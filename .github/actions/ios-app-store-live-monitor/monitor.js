#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");

const MARKER_PREFIX = "veamstudios:app-store-live-monitor";
const MONITOR_MARKER_RE = /<!--\s*veamstudios:app-store-live-monitor:(pending|notified)\s+([^>]*)-->/g;

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

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  );
}

function parseAttributes(value) {
  const attrs = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^\s]+))/g;
  let match;
  while ((match = re.exec(value)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

function parseMonitorMarkers(body) {
  const markers = [];
  const text = String(body || "");
  let match;
  while ((match = MONITOR_MARKER_RE.exec(text)) !== null) {
    markers.push({
      raw: match[0],
      status: match[1],
      attrs: parseAttributes(match[2]),
      index: match.index,
    });
  }
  return markers;
}

function pendingMarker({ bundleId, version }) {
  return `<!-- ${MARKER_PREFIX}:pending bundle_id=${bundleId} version=${version} -->`;
}

function notifiedMarker({ bundleId, version, state, notifiedAt }) {
  return `<!-- ${MARKER_PREFIX}:notified bundle_id=${bundleId} version=${version} state=${state} notified_at=${notifiedAt} -->`;
}

function markerMatchesRelease(marker, bundleId, releaseTag) {
  return (
    marker.attrs.bundle_id === bundleId &&
    normalizeVersion(marker.attrs.version || releaseTag) === normalizeVersion(releaseTag)
  );
}

function getReleaseMonitorState(release, bundleId) {
  const markers = parseMonitorMarkers(release.body || "");
  const alreadyNotified = markers.find(
    (marker) => marker.status === "notified" && markerMatchesRelease(marker, bundleId, release.tag_name)
  );
  if (alreadyNotified) {
    return { status: "already_notified", marker: alreadyNotified };
  }

  const pending = markers.find(
    (marker) => marker.status === "pending" && markerMatchesRelease(marker, bundleId, release.tag_name)
  );
  if (!pending) {
    return { status: "no_pending_marker" };
  }

  return {
    status: "pending",
    marker: pending,
    version: pending.attrs.version || release.tag_name,
  };
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

class GitHubClient {
  constructor({ token, owner, repo, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  request(path, options = {}) {
    return requestJson(this.fetchImpl, `${this.apiUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
  }

  listReleases(limit) {
    const perPage = Math.min(Math.max(limit, 1), 100);
    return this.request(`/repos/${this.owner}/${this.repo}/releases?per_page=${perPage}`);
  }

  async getReleaseByTag(tag) {
    try {
      return await this.request(
        `/repos/${this.owner}/${this.repo}/releases/tags/${encodeURIComponent(tag)}`
      );
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  updateReleaseBody(releaseId, body) {
    return this.request(`/repos/${this.owner}/${this.repo}/releases/${releaseId}`, {
      method: "PATCH",
      body: { body },
    });
  }
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

  async findAppStoreVersion(bundleId, version) {
    const app = await this.findAppByBundleId(bundleId);
    if (!app) {
      return { app: null, version: null };
    }

    const payload = await this.get(`/apps/${app.id}/appStoreVersions`, {
      "fields[appStoreVersions]": "platform,versionString,appStoreState,appVersionState,createdDate",
      limit: 50,
    });
    const versions = Array.isArray(payload.data) ? payload.data : [];
    const matches = versions
      .filter((candidate) => normalizeVersion(candidate.attributes?.versionString) === normalizeVersion(version))
      .sort((left, right) =>
        String(right.attributes?.createdDate || "").localeCompare(String(left.attributes?.createdDate || ""))
      );
    const selected = matches[0] || null;
    if (!selected) {
      return { app, version: null };
    }

    const attrs = selected.attributes || {};
    return {
      app,
      version: {
        id: selected.id,
        versionString: attrs.versionString || version,
        state: attrs.appStoreState || attrs.appVersionState || "UNKNOWN",
        createdDate: attrs.createdDate || "",
      },
    };
  }
}

class SlackWebhookClient {
  constructor({ webhookUrl, fetchImpl = fetch }) {
    this.webhookUrl = webhookUrl;
    this.fetchImpl = fetchImpl;
  }

  async send(payload) {
    const response = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`Slack webhook returned HTTP ${response.status}: ${text.slice(0, 500)}`, response.status, text);
    }
    return text;
  }
}

function buildLiveSlackPayload({ owner, repo, release, serverUrl, appStoreVersion }) {
  const repoName = `${owner}/${repo}`;
  const repoUrl = `${serverUrl.replace(/\/+$/, "")}/${repoName}`;
  const releaseUrl = release.html_url || `${repoUrl}/releases/tag/${encodeURIComponent(release.tag_name)}`;
  const header = `🚀 *<${repoUrl}|${repoName}>* — <${releaseUrl}|${release.tag_name}> is live on the App Store`;
  const context = `App Store Connect: ${appStoreVersion.versionString} is ${appStoreVersion.state}`;

  return {
    text: `${repoName} — ${release.tag_name} is live on the App Store`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header } },
      { type: "context", elements: [{ type: "mrkdwn", text: context }] },
    ],
  };
}

async function loadReleases({ github, releaseTag, releaseLimit }) {
  if (releaseTag) {
    const release = await github.getReleaseByTag(releaseTag);
    return release ? [release] : [];
  }
  return github.listReleases(releaseLimit);
}

async function runMonitor(config, clients) {
  const {
    owner,
    repo,
    bundleId,
    releaseTag = "",
    releaseLimit = 20,
    liveStates = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"]),
    dryRun = false,
    serverUrl = "https://github.com",
    now = () => new Date(),
    logger = console,
  } = config;
  const { github, appStoreConnect, slack } = clients;
  const releases = await loadReleases({ github, releaseTag, releaseLimit });
  const results = {
    checked: releases.length,
    candidates: 0,
    notified: 0,
    dryRunLive: 0,
    pending: 0,
    missingApp: 0,
    missingVersion: 0,
    alreadyNotified: 0,
    noPendingMarker: 0,
    liveVersion: "",
    liveState: "",
    liveReleaseUrl: "",
    items: [],
  };

  for (const release of releases) {
    const monitorState = getReleaseMonitorState(release, bundleId);
    if (monitorState.status === "already_notified") {
      results.alreadyNotified += 1;
      if (releaseTag) {
        results.items.push({ tag: release.tag_name, result: "already_notified", state: "" });
        if (!results.liveVersion) {
          results.liveVersion = release.tag_name;
          results.liveState = monitorState.marker.attrs.state || "";
          results.liveReleaseUrl =
            release.html_url ||
            `${serverUrl.replace(/\/+$/, "")}/${owner}/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
        }
      }
      continue;
    }
    if (monitorState.status === "no_pending_marker") {
      results.noPendingMarker += 1;
      if (releaseTag) {
        results.items.push({ tag: release.tag_name, result: "no_pending_marker", state: "" });
      }
      continue;
    }

    results.candidates += 1;
    const appStoreResult = await appStoreConnect.findAppStoreVersion(bundleId, normalizeVersion(monitorState.version));
    if (!appStoreResult.app) {
      results.missingApp += 1;
      results.items.push({ tag: release.tag_name, result: "missing_app", state: "" });
      logger.log(`No App Store Connect app found for bundle ${bundleId}.`);
      continue;
    }
    if (!appStoreResult.version) {
      results.missingVersion += 1;
      results.items.push({ tag: release.tag_name, result: "missing_app_store_version", state: "" });
      logger.log(`No App Store Connect version found for ${release.tag_name}.`);
      continue;
    }

    const state = String(appStoreResult.version.state || "UNKNOWN").toUpperCase();
    if (!liveStates.has(state)) {
      results.pending += 1;
      results.items.push({ tag: release.tag_name, result: "not_live", state });
      logger.log(`${release.tag_name} is ${state}; no Slack notification sent.`);
      continue;
    }

    const payload = buildLiveSlackPayload({
      owner,
      repo,
      release,
      serverUrl,
      appStoreVersion: { ...appStoreResult.version, state },
    });

    if (dryRun) {
      results.dryRunLive += 1;
      results.items.push({ tag: release.tag_name, result: "dry_run_live", state });
      logger.log(`Dry run: ${release.tag_name} is live (${state}); Slack/update skipped.`);
      continue;
    }

    await slack.send(payload);
    const replacement = notifiedMarker({
      bundleId,
      version: monitorState.version,
      state,
      notifiedAt: now().toISOString(),
    });
    const nextBody = String(release.body || "").replace(monitorState.marker.raw, replacement);
    await github.updateReleaseBody(release.id, nextBody);
    if (!results.liveVersion) {
      results.liveVersion = release.tag_name;
      results.liveState = state;
      results.liveReleaseUrl =
        release.html_url ||
        `${serverUrl.replace(/\/+$/, "")}/${owner}/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    }
    results.notified += 1;
    results.items.push({ tag: release.tag_name, result: "notified", state });
    logger.log(`Sent App Store live Slack notification for ${release.tag_name}.`);
  }

  return results;
}

function escapeTableCell(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

function buildSummary(config, results) {
  const lines = [
    "## App Store live monitor",
    "",
    `- Repository: ${config.owner}/${config.repo}`,
    `- Bundle ID: ${config.bundleId}`,
    `- Release tag: ${config.releaseTag || "(recent releases)"}`,
    `- Dry run: ${config.dryRun ? "true" : "false"}`,
    `- Checked releases: ${results.checked}`,
    `- Pending candidates: ${results.candidates}`,
    `- Slack notifications sent: ${results.notified}`,
    "",
  ];

  if (results.items.length === 0) {
    lines.push("No pending App Store live monitor markers matched this run.");
  } else {
    lines.push("| Release | Result | App Store State |");
    lines.push("|---|---|---|");
    for (const item of results.items) {
      lines.push(`| ${escapeTableCell(item.tag)} | ${escapeTableCell(item.result)} | ${escapeTableCell(item.state)} |`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function requireInput(name) {
  const value = process.env[`INPUT_${name}`];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required input ${name.toLowerCase()}.`);
  }
  return value;
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value || "").replace(/\n/g, " ")}\n`, "utf8");
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY must be set to owner/repo.");
  }

  const config = {
    owner,
    repo,
    bundleId: requireInput("BUNDLE_ID"),
    releaseTag: process.env.INPUT_RELEASE_TAG || "",
    releaseLimit: parsePositiveInteger(process.env.INPUT_RELEASE_LIMIT, 20),
    liveStates: parseCsvSet(process.env.INPUT_LIVE_STATES || "READY_FOR_DISTRIBUTION,READY_FOR_SALE"),
    dryRun: parseBoolean(process.env.INPUT_DRY_RUN),
    serverUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
  };

  const clients = {
    github: new GitHubClient({
      token: requireInput("GITHUB_TOKEN"),
      owner,
      repo,
      apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    }),
    appStoreConnect: new AppStoreConnectClient({
      keyId: requireInput("APP_STORE_CONNECT_API_KEY_ID"),
      issuerId: requireInput("APP_STORE_CONNECT_ISSUER_ID"),
      privateKey: requireInput("APP_STORE_CONNECT_API_KEY_CONTENT"),
    }),
    slack: new SlackWebhookClient({
      webhookUrl: requireInput("SLACK_RELEASES_WEBHOOK_URL"),
    }),
  };

  const results = await runMonitor(config, clients);
  const summary = buildSummary(config, results);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  setOutput("live_version", results.liveVersion);
  setOutput("live_state", results.liveState);
  setOutput("live_release_url", results.liveReleaseUrl);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  AppStoreConnectClient,
  GitHubClient,
  SlackWebhookClient,
  buildLiveSlackPayload,
  buildSummary,
  createAppStoreConnectJwt,
  getReleaseMonitorState,
  normalizeVersion,
  notifiedMarker,
  parseMonitorMarkers,
  pendingMarker,
  runMonitor,
};
