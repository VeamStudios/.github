const crypto = require("node:crypto");

class HttpError extends Error {
  constructor(message, statusCode, body) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.body = body;
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

async function requestJson(fetchImpl, url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`, response.status, text);
  }
  return text ? JSON.parse(text) : {};
}

class AppStoreConnectClient {
  constructor({
    keyId,
    issuerId,
    privateKey,
    baseUrl = "https://api.appstoreconnect.apple.com/v1",
    fetchImpl = fetch,
  }) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = privateKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.appCache = new Map();
  }

  jwt() {
    return createAppStoreConnectJwt({
      keyId: this.keyId,
      issuerId: this.issuerId,
      privateKey: this.privateKey,
    });
  }

  get(path, params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return requestJson(this.fetchImpl, url.toString(), {
      headers: {
        Authorization: `Bearer ${this.jwt()}`,
        Accept: "application/json",
      },
    });
  }

  async findAppByBundleId(bundleId) {
    if (this.appCache.has(bundleId)) {
      return this.appCache.get(bundleId);
    }
    const payload = await this.get("/apps", {
      "filter[bundleId]": bundleId,
      "fields[apps]": "name,bundleId,sku,primaryLocale",
      limit: 10,
    });
    const app = Array.isArray(payload.data) ? payload.data[0] || null : null;
    this.appCache.set(bundleId, app);
    return app;
  }

}

module.exports = { AppStoreConnectClient, normalizeVersion, createAppStoreConnectJwt };
