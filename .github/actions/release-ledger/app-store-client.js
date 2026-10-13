const crypto = require("node:crypto");

class AppStoreVerificationError extends Error {
  constructor(message, verificationStatus = 'unavailable') {
    super(`App Store verification ${verificationStatus}: ${message}`);
    this.verificationStatus = verificationStatus;
    this.retryable = verificationStatus === 'unavailable';
  }
}
class HttpError extends AppStoreVerificationError {
  constructor(message, statusCode, body, retryAfter) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.body = body;
    this.retryable = statusCode === 429 || statusCode >= 500;
    const seconds = Number(retryAfter);
    this.retryAfterMs = retryAfter ? Math.min(20000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now())) : 0;
  }
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^[vV]/, "");
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizePrivateKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
}

function createAppStoreConnectJwt({ keyId, issuerId, privateKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: nowSeconds,
    exp: nowSeconds + 20 * 60,
    aud: "appstoreconnect-v1",
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), {
    key: crypto.createPrivateKey(normalizePrivateKey(privateKey)),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${base64Url(signature)}`;
}

async function requestJson(fetchImpl, url, headers, timeoutMs, validate) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
        const text = await response.text();
        if (!response.ok) throw new HttpError(`HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`, response.status, text, response.headers?.get('retry-after'));
        let payload;
        try { payload = JSON.parse(text); }
        catch { throw new AppStoreVerificationError(`Malformed JSON from ${url}: ${text.slice(0, 200)}`); }
        return validate(payload);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        reject(new AppStoreVerificationError(`Read timed out after ${timeoutMs} ms for ${url}`));
        controller.abort();
      }, timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof AppStoreVerificationError) throw error;
    throw new AppStoreVerificationError(`Read failed for ${url}: ${error.message}`);
  } finally { clearTimeout(timer); }
}

class AppStoreConnectClient {
  constructor({
    keyId,
    issuerId,
    privateKey,
    baseUrl = "https://api.appstoreconnect.apple.com/v1",
    fetchImpl = fetch,
    requestTimeoutMs = 20000,
    retryDelayMs = 1000,
  }) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = privateKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.appCache = new Map();
  }

  jwt() {
    return createAppStoreConnectJwt({
      keyId: this.keyId,
      issuerId: this.issuerId,
      privateKey: this.privateKey,
    });
  }

  async get(path, params = {}, validate = payload => payload) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = { Authorization: `Bearer ${this.jwt()}`, Accept: 'application/json' };
    // GET only. Three attempts include the response body in each deadline;
    // Retry-After is respected up to 20 seconds, never an unbounded job sleep.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await requestJson(this.fetchImpl, url.toString(), headers, this.requestTimeoutMs, validate); }
      catch (error) {
        if (!error.retryable || attempt === 3) { error.message += ` (${attempt} attempt${attempt === 1 ? '' : 's'})`; throw error; }
        await new Promise(resolve => setTimeout(resolve, Math.max(error.retryAfterMs || 0, this.retryDelayMs * attempt)));
      }
    }
  }

  async findAppByBundleId(bundleId) {
    if (this.appCache.has(bundleId)) {
      return this.appCache.get(bundleId);
    }
    const app = await this.get("/apps", {
      "filter[bundleId]": bundleId,
      "fields[apps]": "name,bundleId,sku,primaryLocale",
      limit: 10,
    }, payload => {
      if (!Array.isArray(payload?.data)) throw new AppStoreVerificationError(`Malformed app lookup for ${bundleId}: data is not an array`);
      if (payload.links?.next) throw new AppStoreVerificationError(`Incomplete app lookup for ${bundleId}: another page was returned`);
      if (!payload.data.length) throw new AppStoreVerificationError(`App lookup returned no apps for ${bundleId}`);
      if (payload.data.some(app => typeof app?.id !== 'string' || !app.id.trim() || typeof app.attributes?.bundleId !== 'string' || !app.attributes.bundleId.trim())) {
        throw new AppStoreVerificationError(`Malformed app identity for ${bundleId}: ${JSON.stringify(payload.data.map(app => ({ id: app?.id, bundleId: app?.attributes?.bundleId }))).slice(0, 500)}`);
      }
      const matches = payload.data.filter(app => app.attributes.bundleId === bundleId);
      if (matches.length !== 1) throw new AppStoreVerificationError(`App lookup for ${bundleId} returned ${matches.length} exact identities; returned bundles: ${payload.data.map(app => app.attributes.bundleId).join(', ').slice(0, 500)}`, 'conflict');
      return matches[0];
    });
    this.appCache.set(bundleId, app);
    return app;
  }

}

module.exports = { AppStoreConnectClient, AppStoreVerificationError, normalizeVersion, createAppStoreConnectJwt };
