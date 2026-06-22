#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const FIREBASE_REMOTE_CONFIG_SCOPE = "https://www.googleapis.com/auth/firebase.remoteconfig";
const PRODUCT_PAGE_IDS = {
  cip: "30c06908-3a03-8088-bfc4-f9a47469e4a6",
  checklistinspectorpro: "30c06908-3a03-8088-bfc4-f9a47469e4a6",
  checklistinspectorproproduction: "30c06908-3a03-8088-bfc4-f9a47469e4a6",
  sap: "30c06908-3a03-80d0-9845-fe97daa54c31",
  siteauditpro: "30c06908-3a03-80d0-9845-fe97daa54c31",
};
const NO_PLATFORM_KEY_VALUE = "no platform key";
const REMOTE_CONFIG_VALUE_PROPERTIES = new Set([
  "iOS Prod RC Value",
  "Web Prod RC Value",
  "Android Prod RC Value",
]);
const PRODUCTION_STATUS_PROPERTIES = new Set([
  "iOS Release Status",
  "Web Deploy Status",
  "Android Release Status",
]);

class HttpError extends Error {
  constructor(message, statusCode, body) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizePageId(value) {
  return String(value || "").replace(/-/g, "").toLowerCase();
}

function normalizeProduct(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveProductPageId({ product, productPageId }) {
  const explicitPageId = String(productPageId || "").trim();
  if (explicitPageId) return explicitPageId;
  return PRODUCT_PAGE_IDS[normalizeProduct(product)] || "";
}

function normalizePlatform(value) {
  const platform = String(value || "all").trim().toLowerCase();
  if (["ios", "web", "android", "backend", "all"].includes(platform)) return platform;
  return "all";
}

function textFromRichText(property) {
  const values = property?.rich_text || property?.title || [];
  return values.map((item) => item.plain_text || item.text?.content || "").join("");
}

function relationIds(property) {
  return Array.isArray(property?.relation) ? property.relation.map((item) => normalizePageId(item.id)) : [];
}

function notionRichText(value) {
  const text = String(value || "");
  return text ? { rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }] } : { rich_text: [] };
}

function notionSelect(value) {
  const name = String(value || "").trim();
  return name ? { select: { name } } : { select: null };
}

function notionDate(value) {
  return { date: { start: value } };
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

function parseServiceAccount(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const candidates = [raw];
  try {
    candidates.push(Buffer.from(raw, "base64").toString("utf8"));
  } catch (_error) {
    // Not base64; keep the direct candidate.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.client_email && parsed.private_key) return parsed;
    } catch (_error) {
      // Try the next candidate.
    }
  }

  throw new Error("Firebase service account must be JSON or base64-encoded JSON.");
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

function createServiceAccountJwt(serviceAccount, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: FIREBASE_REMOTE_CONFIG_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), normalizePrivateKey(serviceAccount.private_key));
  return `${unsigned}.${base64Url(signature)}`;
}

class FirebaseRemoteConfigClient {
  constructor({ projectId, serviceAccount, fetchImpl = fetch }) {
    this.projectId = projectId;
    this.serviceAccount = serviceAccount;
    this.fetchImpl = fetchImpl;
    this.accessToken = null;
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    const assertion = createServiceAccountJwt(this.serviceAccount);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`OAuth token request failed: ${text.slice(0, 500)}`, response.status, text);
    }
    const payload = JSON.parse(text);
    this.accessToken = payload.access_token;
    return this.accessToken;
  }

  async getTemplate() {
    const accessToken = await this.token();
    return requestJson(
      this.fetchImpl,
      `https://firebaseremoteconfig.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/remoteConfig`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );
  }
}

class NotionClient {
  constructor({ token, apiUrl = NOTION_API_URL, fetchImpl = fetch }) {
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  request(path, options = {}) {
    return requestJson(this.fetchImpl, `${this.apiUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
        ...(options.headers || {}),
      },
    });
  }

  queryDataSource(dataSourceId, body) {
    return this.request(`/data_sources/${dataSourceId}/query`, { method: "POST", body });
  }

  updatePage(pageId, properties) {
    return this.request(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
  }
}

async function listLaunchHubItems(notion, dataSourceId) {
  const pages = [];
  let startCursor;
  do {
    const payload = await notion.queryDataSource(dataSourceId, {
      page_size: 100,
      start_cursor: startCursor,
    });
    pages.push(...(payload.results || []));
    startCursor = payload.has_more ? payload.next_cursor : undefined;
  } while (startCursor);
  return pages;
}

function extractWorkItem(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    title: textFromRichText(props.Name),
    productIds: relationIds(props.Product),
    iosRcKey: textFromRichText(props["iOS RC Key"]).trim(),
    webRcKey: textFromRichText(props["Web RC Key"]).trim(),
    androidRcKey: textFromRichText(props["Android RC Key"]).trim(),
  };
}

function remoteConfigValue(template, key) {
  if (!key) return null;
  const parameter = template?.parameters?.[key];
  if (!parameter) {
    return "missing";
  }
  if (parameter.defaultValue?.value !== undefined) {
    return String(parameter.defaultValue.value);
  }
  if (parameter.defaultValue?.useInAppDefault === true) {
    return "useInAppDefault";
  }
  return "";
}

function productionRcValue(template, key) {
  return key ? remoteConfigValue(template, key) : NO_PLATFORM_KEY_VALUE;
}

function itemMatchesPlatform(item, platform) {
  switch (normalizePlatform(platform)) {
    case "ios":
      return Boolean(item.iosRcKey);
    case "web":
      return Boolean(item.webRcKey);
    case "android":
      return Boolean(item.androidRcKey);
    case "backend":
    case "all":
    default:
      return Boolean(item.iosRcKey || item.webRcKey || item.androidRcKey);
  }
}

function buildPageProperties({ item, template, config, syncedAt }) {
  const properties = {
    "Last Production Sync": syncedAt,
  };

  if (template) {
    properties["iOS Prod RC Value"] = productionRcValue(template, item.iosRcKey);
    properties["Web Prod RC Value"] = productionRcValue(template, item.webRcKey);
    properties["Android Prod RC Value"] = productionRcValue(template, item.androidRcKey);
  }

  const platform = normalizePlatform(config.platform);
  let wroteProductionStatus = false;
  if (config.productionState) {
    if (platform === "ios") {
      properties["iOS Release Status"] = config.productionState;
      wroteProductionStatus = true;
    }
    if (platform === "web") {
      properties["Web Deploy Status"] = config.productionState;
      wroteProductionStatus = true;
    }
    if (platform === "android") {
      properties["Android Release Status"] = config.productionState;
      wroteProductionStatus = true;
    }
  }
  if (wroteProductionStatus && config.productionEvidence) {
    properties["Production Evidence"] = config.productionEvidence;
  }

  return properties;
}

function toNotionProperties(rawProperties) {
  const properties = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    if (key === "Last Production Sync") {
      properties[key] = notionDate(value);
    } else if (PRODUCTION_STATUS_PROPERTIES.has(key) || REMOTE_CONFIG_VALUE_PROPERTIES.has(key)) {
      properties[key] = notionSelect(value);
    } else {
      properties[key] = notionRichText(value);
    }
  }
  return properties;
}

async function runSync(config, clients) {
  const syncedAt = config.now().toISOString();
  const summary = {
    matchedPages: 0,
    updatedPages: 0,
    remoteConfigChecked: 0,
    errors: [],
    dryRun: config.dryRun,
    items: [],
  };

  if (!clients.notion) {
    summary.errors.push("Notion token is not configured; skipped Launch Hub sync.");
    return summary;
  }

  const productId = normalizePageId(config.productPageId);
  if (!productId) {
    summary.errors.push("Product is not configured; set product to cip/sap or pass product_page_id.");
    return summary;
  }

  let template = null;
  if (clients.firebase) {
    try {
      template = await clients.firebase.getTemplate();
    } catch (error) {
      summary.errors.push(`Remote Config read failed: ${error.message}`);
    }
  }

  const pages = await listLaunchHubItems(clients.notion, config.workItemsDataSourceId);
  const items = pages
    .map(extractWorkItem)
    .filter((item) => item.productIds.includes(productId))
    .filter((item) => itemMatchesPlatform(item, config.platform));
  summary.matchedPages = items.length;

  for (const item of items) {
    const properties = buildPageProperties({ item, template, config, syncedAt });
    if (template && item.iosRcKey) summary.remoteConfigChecked += 1;
    if (template && item.webRcKey) summary.remoteConfigChecked += 1;
    if (template && item.androidRcKey) summary.remoteConfigChecked += 1;

    summary.items.push({
      title: item.title,
      iosRcKey: item.iosRcKey,
      webRcKey: item.webRcKey,
      androidRcKey: item.androidRcKey,
      iosValue: properties["iOS Prod RC Value"] || "",
      webValue: properties["Web Prod RC Value"] || "",
      androidValue: properties["Android Prod RC Value"] || "",
      updated: Object.keys(properties).length > 0,
    });

    if (!config.dryRun && Object.keys(properties).length > 0) {
      await clients.notion.updatePage(item.id, toNotionProperties(properties));
      summary.updatedPages += 1;
    }
  }

  return summary;
}

function buildSummaryMarkdown(config, summary) {
  const lines = [
    "## Launch Hub production mirror",
    "",
    `- Product: ${config.product || "(not set)"}`,
    `- Product page: ${config.productPageId}`,
    `- Platform: ${config.platform}`,
    `- Release/deploy status: ${config.productionState || "(not set)"}`,
    `- Dry run: ${summary.dryRun ? "true" : "false"}`,
    `- Matched Work Items: ${summary.matchedPages}`,
    `- Updated Work Items: ${summary.updatedPages}`,
    `- Remote Config keys checked: ${summary.remoteConfigChecked}`,
    "",
  ];

  if (summary.errors.length > 0) {
    lines.push("### Warnings");
    for (const error of summary.errors) lines.push(`- ${error}`);
    lines.push("");
  }

  if (summary.items.length > 0) {
    lines.push("| Work Item | iOS key | iOS value | Web key | Web value | Android key | Android value |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const item of summary.items) {
      lines.push(
        `| ${escapeTableCell(item.title)} | ${escapeTableCell(item.iosRcKey)} | ${escapeTableCell(item.iosValue)} | ${escapeTableCell(item.webRcKey)} | ${escapeTableCell(item.webValue)} | ${escapeTableCell(item.androidRcKey)} | ${escapeTableCell(item.androidValue)} |`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function escapeTableCell(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\n/g, " ")}\n`, "utf8");
}

async function main() {
  const config = {
    product: process.env.INPUT_PRODUCT || "",
    productPageId: resolveProductPageId({
      product: process.env.INPUT_PRODUCT || "",
      productPageId: process.env.INPUT_PRODUCT_PAGE_ID || "",
    }),
    workItemsDataSourceId: process.env.INPUT_WORK_ITEMS_DATA_SOURCE_ID || "",
    platform: normalizePlatform(process.env.INPUT_PLATFORM),
    productionState: process.env.INPUT_PRODUCTION_STATE || "",
    productionEvidence: process.env.INPUT_PRODUCTION_EVIDENCE || "",
    firebaseProjectId: process.env.INPUT_FIREBASE_PROJECT_ID || "",
    dryRun: parseBoolean(process.env.INPUT_DRY_RUN),
    now: () => new Date(),
  };

  const notionToken = process.env.INPUT_NOTION_TOKEN || "";
  let serviceAccount = null;
  let serviceAccountError = "";
  try {
    serviceAccount = parseServiceAccount(process.env.INPUT_FIREBASE_SERVICE_ACCOUNT || "");
  } catch (error) {
    serviceAccountError = error.message;
  }
  const clients = {
    notion: notionToken ? new NotionClient({ token: notionToken }) : null,
    firebase:
      config.firebaseProjectId && serviceAccount
        ? new FirebaseRemoteConfigClient({ projectId: config.firebaseProjectId, serviceAccount })
        : null,
  };

  let summary;
  try {
    summary = await runSync(config, clients);
    if (serviceAccountError) {
      summary.errors.push(`Remote Config credentials skipped: ${serviceAccountError}`);
    }
  } catch (error) {
    summary = {
      matchedPages: 0,
      updatedPages: 0,
      remoteConfigChecked: 0,
      dryRun: config.dryRun,
      items: [],
      errors: [`Launch Hub sync failed: ${error.message}`],
    };
  }

  const markdown = buildSummaryMarkdown(config, summary);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }

  setOutput("matched_pages", summary.matchedPages);
  setOutput("updated_pages", summary.updatedPages);
  setOutput("remote_config_checked", summary.remoteConfigChecked);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(0);
  });
}

module.exports = {
  FirebaseRemoteConfigClient,
  NotionClient,
  buildPageProperties,
  buildSummaryMarkdown,
  createServiceAccountJwt,
  extractWorkItem,
  normalizePageId,
  parseServiceAccount,
  remoteConfigValue,
  resolveProductPageId,
  runSync,
  toNotionProperties,
};
