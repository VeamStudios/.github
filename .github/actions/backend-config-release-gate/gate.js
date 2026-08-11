#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIREBASE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/firebase",
];
const REALTIME_DATABASE_SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/userinfo.email",
];
const GITHUB_API_VERSION = "2022-11-28";
const SCHEMA_VERSION = 1;

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

function actionInput(name, { required = false, defaultValue = "" } = {}) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = String(process.env[key] ?? defaultValue).trim();
  if (required && !value) throw new Error(`Missing required input: ${name}`);
  return value;
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function appendSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeText(value) {
  return String(value).replace(/\r\n/g, "\n");
}

function normalizeConfigContent(filePath, content) {
  const normalized = normalizeText(content);
  if (filePath.endsWith(".json")) return stableStringify(JSON.parse(normalized));
  return normalized;
}

function configHash(files) {
  const entries = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => [filePath, normalizeConfigContent(filePath, content)]);
  return crypto.createHash("sha256").update(stableStringify(entries)).digest("hex");
}

function firebaseSections(config, key) {
  const value = config?.[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectConfigPaths(firebaseConfig) {
  const paths = new Set(["firebase.json"]);
  for (const section of firebaseSections(firebaseConfig, "firestore")) {
    if (section.rules) paths.add(section.rules);
    if (section.indexes) paths.add(section.indexes);
  }
  for (const section of firebaseSections(firebaseConfig, "storage")) {
    if (section.rules) paths.add(section.rules);
  }
  for (const section of firebaseSections(firebaseConfig, "database")) {
    if (section.rules) paths.add(section.rules);
  }
  return [...paths].sort();
}

function resolveConfigPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Firebase config path escapes config root: ${relativePath}`);
  }
  return resolvedPath;
}

function loadLocalConfig(root) {
  const firebaseJsonPath = resolveConfigPath(root, "firebase.json");
  const firebaseJson = fs.readFileSync(firebaseJsonPath, "utf8");
  const firebaseConfig = JSON.parse(firebaseJson);
  const files = new Map();
  for (const filePath of collectConfigPaths(firebaseConfig)) {
    files.set(filePath, fs.readFileSync(resolveConfigPath(root, filePath), "utf8"));
  }
  return { firebaseConfig, files };
}

async function requestJson(url, options = {}) {
  const { label = url, allow404 = false, ...fetchOptions } = options;
  const response = await fetch(url, fetchOptions);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    const details = typeof body === "string" ? body : JSON.stringify(body);
    throw new HttpError(`${label} failed with HTTP ${response.status}: ${details}`, response.status, body);
  }
  return body;
}

async function githubRequest(token, apiPath, options = {}) {
  return requestJson(`https://api.github.com${apiPath}`, {
    ...options,
    label: options.label || `GitHub API ${apiPath}`,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(options.headers || {}),
    },
  });
}

async function githubContent(repo, ref, filePath, token) {
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const body = await githubRequest(
    token,
    `/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
  );
  if (!body || body.type !== "file" || !body.content) {
    throw new Error(`Expected ${repo}:${ref}:${filePath} to be a file.`);
  }
  return Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
}

async function loadGithubConfig(repo, ref, token) {
  const firebaseJson = await githubContent(repo, ref, "firebase.json", token);
  const firebaseConfig = JSON.parse(firebaseJson);
  const files = new Map();
  for (const filePath of collectConfigPaths(firebaseConfig)) {
    files.set(filePath, await githubContent(repo, ref, filePath, token));
  }
  return { firebaseConfig, files };
}

function normalizePrivateKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
}

function googleOAuthScope(includeRealtimeDatabaseScopes = false) {
  return [
    ...FIREBASE_SCOPES,
    ...(includeRealtimeDatabaseScopes ? REALTIME_DATABASE_SCOPES : []),
  ].join(" ");
}

async function googleAccessToken(serviceAccountPath, includeRealtimeDatabaseScopes = false) {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: googleOAuthScope(includeRealtimeDatabaseScopes),
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), normalizePrivateKey(serviceAccount.private_key));
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await requestJson(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    label: "Google OAuth token exchange",
  });
  if (!response?.access_token) throw new Error("Google OAuth response did not include an access token.");
  return response.access_token;
}

function googleHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

function canonicalIndexField(field) {
  const result = { fieldPath: field.fieldPath };
  if (field.order) result.order = field.order;
  if (field.arrayConfig) result.arrayConfig = field.arrayConfig;
  if (field.vectorConfig) result.vectorConfig = stableValue(field.vectorConfig);
  return result;
}

function collectionGroupFromIndex(index) {
  const match = String(index.name || "").match(/\/collectionGroups\/([^/]+)\/indexes\//);
  return match ? decodeURIComponent(match[1]) : index.collectionGroup;
}

function canonicalCompositeIndex(index) {
  return {
    collectionGroup: collectionGroupFromIndex(index),
    queryScope: index.queryScope || "COLLECTION",
    fields: (index.fields || [])
      .filter((field) => field.fieldPath !== "__name__")
      .map(canonicalIndexField),
  };
}

function compositeIndexKey(index) {
  return stableStringify(canonicalCompositeIndex(index));
}

function assessCompositeIndexes(expectedIndexes, liveIndexes) {
  const liveByKey = new Map(liveIndexes.map((index) => [compositeIndexKey(index), index]));
  const assessment = { ready: [], pending: [], missing: [], failed: [] };
  for (const expected of expectedIndexes) {
    const key = compositeIndexKey(expected);
    const live = liveByKey.get(key);
    if (!live) {
      assessment.missing.push(canonicalCompositeIndex(expected));
    } else if (live.state === "READY") {
      assessment.ready.push(canonicalCompositeIndex(expected));
    } else if (live.state === "CREATING") {
      assessment.pending.push({ ...canonicalCompositeIndex(expected), state: live.state });
    } else {
      assessment.failed.push({ ...canonicalCompositeIndex(expected), state: live.state || "UNKNOWN" });
    }
  }
  return assessment;
}

function canonicalSingleFieldIndex(index) {
  const field = (index.fields || [index])[0] || {};
  const result = { queryScope: index.queryScope || field.queryScope || "COLLECTION" };
  if (field.order || index.order) result.order = field.order || index.order;
  if (field.arrayConfig || index.arrayConfig) result.arrayConfig = field.arrayConfig || index.arrayConfig;
  return result;
}

function assessFieldOverride(expected, live) {
  if (!live) return { status: "missing", reason: "field override not found" };
  if (live.indexConfig?.reverting) return { status: "pending", reason: "index config is reverting" };
  const expectedIndexes = (expected.indexes || []).map(canonicalSingleFieldIndex).map(stableStringify).sort();
  const liveIndexes = (live.indexConfig?.indexes || []).map(canonicalSingleFieldIndex).map(stableStringify).sort();
  if (stableStringify(expectedIndexes) !== stableStringify(liveIndexes)) {
    return { status: "missing", reason: "single-field index configuration differs" };
  }
  const unready = (live.indexConfig?.indexes || []).find((index) => index.state && index.state !== "READY");
  if (unready) {
    return {
      status: unready.state === "CREATING" ? "pending" : "failed",
      reason: `single-field index state is ${unready.state}`,
    };
  }
  if (expected.ttl === true && live.ttlConfig?.state !== "ACTIVE") {
    return {
      status: live.ttlConfig?.state === "CREATING" ? "pending" : "missing",
      reason: `TTL state is ${live.ttlConfig?.state || "disabled"}`,
    };
  }
  if (expected.ttl === false && live.ttlConfig && live.ttlConfig.state !== "STATE_UNSPECIFIED") {
    return { status: "failed", reason: `TTL should be disabled but is ${live.ttlConfig.state}` };
  }
  return { status: "ready" };
}

async function listCompositeIndexes(projectId, databaseId, collectionGroups, accessToken) {
  const indexes = [];
  const uniqueCollectionGroups = [...new Set(collectionGroups.map(String))].sort();
  for (const collectionGroup of uniqueCollectionGroups) {
    if (!collectionGroup) throw new Error("Firestore composite index has no collection group.");
    let pageToken = "";
    do {
      const url = new URL(
        `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/collectionGroups/${encodeURIComponent(collectionGroup)}/indexes`
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await requestJson(url, {
        headers: googleHeaders(accessToken),
        label: `List Firestore composite indexes for ${collectionGroup}`,
      });
      indexes.push(...(body?.indexes || []));
      pageToken = body?.nextPageToken || "";
    } while (pageToken);
  }
  return indexes;
}

async function getFieldOverride(projectId, databaseId, expected, accessToken) {
  const collectionGroup = encodeURIComponent(expected.collectionGroup);
  const fieldPath = encodeURIComponent(expected.fieldPath);
  return requestJson(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/collectionGroups/${collectionGroup}/fields/${fieldPath}`,
    {
      headers: googleHeaders(accessToken),
      allow404: true,
      label: `Get Firestore field override ${expected.collectionGroup}.${expected.fieldPath}`,
    }
  );
}

function assessmentCount(assessment) {
  return assessment.missing.length + assessment.pending.length + assessment.failed.length;
}

function describeIndex(index) {
  const fields = (index.fields || []).map((field) => `${field.fieldPath}:${field.order || field.arrayConfig}`).join(", ");
  return `${index.collectionGroup} (${index.queryScope}) [${fields}]`;
}

async function verifyFirestoreIndexes({
  projectId,
  databaseId,
  accessToken,
  indexConfig,
  timeoutSeconds,
  pollIntervalSeconds,
}) {
  const expectedIndexes = indexConfig.indexes || [];
  const expectedOverrides = indexConfig.fieldOverrides || [];
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastComposite = null;
  let lastOverrides = [];

  while (true) {
    const liveIndexes = await listCompositeIndexes(
      projectId,
      databaseId,
      expectedIndexes.map((index) => index.collectionGroup),
      accessToken
    );
    lastComposite = assessCompositeIndexes(expectedIndexes, liveIndexes);
    lastOverrides = [];
    for (const expected of expectedOverrides) {
      const live = await getFieldOverride(projectId, databaseId, expected, accessToken);
      lastOverrides.push({ expected, ...assessFieldOverride(expected, live) });
    }

    if (lastComposite.failed.length) {
      throw new Error(`Firestore indexes failed: ${lastComposite.failed.map(describeIndex).join("; ")}`);
    }
    const failedOverrides = lastOverrides.filter((item) => item.status === "failed");
    if (failedOverrides.length) {
      throw new Error(
        `Firestore field overrides failed: ${failedOverrides
          .map((item) => `${item.expected.collectionGroup}.${item.expected.fieldPath}: ${item.reason}`)
          .join("; ")}`
      );
    }

    const unreadyOverrides = lastOverrides.filter((item) => item.status !== "ready");
    if (assessmentCount(lastComposite) === 0 && unreadyOverrides.length === 0) {
      return {
        compositeIndexesReady: expectedIndexes.length,
        fieldOverridesReady: expectedOverrides.length,
      };
    }

    if (Date.now() >= deadline) {
      const details = [
        ...lastComposite.missing.map((index) => `missing ${describeIndex(index)}`),
        ...lastComposite.pending.map((index) => `building ${describeIndex(index)}`),
        ...unreadyOverrides.map(
          (item) => `${item.status} ${item.expected.collectionGroup}.${item.expected.fieldPath}: ${item.reason}`
        ),
      ];
      throw new Error(`Firestore indexes were not ready before timeout: ${details.join("; ")}`);
    }

    console.log(
      `Waiting for Firestore indexes: ${lastComposite.missing.length} missing, ${lastComposite.pending.length} building, ${unreadyOverrides.length} field overrides pending.`
    );
    await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
  }
}

async function listRulesReleases(projectId, accessToken) {
  const releases = [];
  let pageToken = "";
  do {
    const url = new URL(`https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/releases`);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await requestJson(url, {
      headers: googleHeaders(accessToken),
      label: "List Firebase Rules releases",
    });
    releases.push(...(body?.releases || []));
    pageToken = body?.nextPageToken || "";
  } while (pageToken);
  return releases;
}

async function getRuleset(rulesetName, accessToken) {
  return requestJson(`https://firebaserules.googleapis.com/v1/${rulesetName}`, {
    headers: googleHeaders(accessToken),
    label: `Get Firebase Rules ruleset ${rulesetName}`,
  });
}

function rulesContentMatches(localContent, ruleset) {
  const expected = normalizeText(localContent);
  return (ruleset?.source?.files || []).some((file) => normalizeText(file.content || "") === expected);
}

function findRulesRelease(releases, service, storageBucket = "") {
  if (service === "firestore") {
    return releases.find((release) => release.name.endsWith("/releases/cloud.firestore"));
  }
  const storageReleases = releases.filter((release) => release.name.includes("/releases/firebase.storage/"));
  if (storageBucket) {
    return storageReleases.find((release) => release.name.endsWith(`/${storageBucket}`));
  }
  return storageReleases.length === 1 ? storageReleases[0] : null;
}

async function verifyRulesRelease({ releases, service, localContent, accessToken, storageBucket }) {
  const release = findRulesRelease(releases, service, storageBucket);
  if (!release) {
    throw new Error(
      service === "storage"
        ? `No Firebase Storage rules release found for bucket ${storageBucket || "<unknown>"}.`
        : "No Cloud Firestore rules release found."
    );
  }
  const ruleset = await getRuleset(release.rulesetName, accessToken);
  if (!rulesContentMatches(localContent, ruleset)) {
    throw new Error(`${service === "storage" ? "Storage" : "Firestore"} rules do not match the deployed ruleset.`);
  }
  return release.name;
}

async function firebaseAdminSdkConfig(projectId, accessToken) {
  return requestJson(
    `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/adminSdkConfig`,
    {
      headers: googleHeaders(accessToken),
      label: "Get Firebase Admin SDK config",
    }
  );
}

async function verifyRealtimeDatabaseRules(databaseUrl, localContent, accessToken) {
  if (!databaseUrl) throw new Error("Firebase project has no default Realtime Database URL.");
  const url = new URL("./.settings/rules.json", databaseUrl.endsWith("/") ? databaseUrl : `${databaseUrl}/`);
  url.searchParams.set("access_token", accessToken);
  const liveRules = await requestJson(url, { label: "Get Realtime Database rules" });
  const expectedRules = JSON.parse(localContent);
  if (stableStringify(liveRules) !== stableStringify(expectedRules)) {
    throw new Error("Realtime Database rules do not match the deployed rules.");
  }
}

function firestoreDatabaseId(section) {
  if (section.target) {
    throw new Error(
      `Firestore target '${section.target}' cannot be resolved without Firebase target metadata. Use an explicit database in firebase.json.`
    );
  }
  return String(section.database || "(default)");
}

function storageBucket(section, adminConfig) {
  if (section.target) {
    throw new Error(
      `Storage target '${section.target}' cannot be resolved without Firebase target metadata. Use an explicit bucket in firebase.json.`
    );
  }
  const bucket = String(section.bucket || adminConfig?.storageBucket || "");
  if (!bucket) throw new Error("Firebase Storage rules are configured, but no bucket could be resolved.");
  return bucket;
}

function realtimeDatabaseUrl(section, adminConfig) {
  if (section.target) {
    throw new Error(
      `Realtime Database target '${section.target}' cannot be resolved without Firebase target metadata. Use an explicit instance in firebase.json.`
    );
  }
  const defaultUrl = String(adminConfig?.databaseURL || "");
  const instance = String(section.instance || "");
  if (!instance) {
    if (!defaultUrl) throw new Error("Firebase project has no default Realtime Database URL.");
    return defaultUrl;
  }
  if (/^https:\/\//.test(instance)) return instance;
  if (defaultUrl) {
    const hostname = new URL(defaultUrl).hostname;
    if (hostname === instance || hostname.startsWith(`${instance}.`)) return defaultUrl;
  }
  throw new Error(
    `Realtime Database instance '${instance}' is not the project's default instance and cannot be resolved safely. Use its full HTTPS URL in firebase.json.`
  );
}

async function verifyLiveFirebase({
  projectId,
  serviceAccountFile,
  includeRealtimeDatabaseScopes,
  config,
  timeoutSeconds,
  pollIntervalSeconds,
}) {
  const accessToken = await googleAccessToken(serviceAccountFile, includeRealtimeDatabaseScopes);
  const checks = { firestore: [], storage: [], realtimeDatabase: [] };
  const firestore = firebaseSections(config.firebaseConfig, "firestore");
  const storage = firebaseSections(config.firebaseConfig, "storage");
  const databases = firebaseSections(config.firebaseConfig, "database");
  const hasRules = [...firestore, ...storage].some((section) => section.rules);
  const releases = hasRules ? await listRulesReleases(projectId, accessToken) : [];
  const needsAdminConfig = storage.some((section) => section.rules) || databases.some((section) => section.rules);
  const adminConfig = needsAdminConfig ? await firebaseAdminSdkConfig(projectId, accessToken) : null;

  for (const section of firestore) {
    const databaseId = firestoreDatabaseId(section);
    const result = { database: databaseId };
    if (section.indexes) {
      const indexConfig = JSON.parse(config.files.get(section.indexes));
      result.indexes = await verifyFirestoreIndexes({
        projectId,
        databaseId,
        accessToken,
        indexConfig,
        timeoutSeconds,
        pollIntervalSeconds,
      });
    }
    if (section.rules) {
      if (databaseId !== "(default)") {
        throw new Error(
          `Firestore rules for database '${databaseId}' cannot be matched to a Firebase Rules release safely.`
        );
      }
      result.rulesRelease = await verifyRulesRelease({
        releases,
        service: "firestore",
        localContent: config.files.get(section.rules),
        accessToken,
      });
    }
    checks.firestore.push(result);
  }

  for (const section of storage) {
    if (!section.rules) continue;
    const bucket = storageBucket(section, adminConfig);
    checks.storage.push({
      bucket,
      rulesRelease: await verifyRulesRelease({
        releases,
        service: "storage",
        localContent: config.files.get(section.rules),
        accessToken,
        storageBucket: bucket,
      }),
    });
  }

  for (const section of databases) {
    if (!section.rules) continue;
    const databaseUrl = realtimeDatabaseUrl(section, adminConfig);
    await verifyRealtimeDatabaseRules(databaseUrl, config.files.get(section.rules), accessToken);
    checks.realtimeDatabase.push({ databaseUrl, rulesReady: true });
  }
  return checks;
}

function workflowRunUrl() {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return repo && runId ? `${server}/${repo}/actions/runs/${runId}` : "";
}

function readinessBranch(environment) {
  return `backend-config-ready/${environment}`;
}

function readinessContext(environment) {
  return `Backend Config Ready / ${environment}`;
}

async function postCommitStatus({ token, repo, commit, environment, state, projectId, hash, description }) {
  await githubRequest(token, `/repos/${repo}/statuses/${commit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      context: readinessContext(environment),
      description: description || `${projectId} sha256:${hash}`,
      target_url: workflowRunUrl(),
    }),
  });
}

async function collectPages(fetchPage, pageSize = 100) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const pageItems = await fetchPage(page, pageSize);
    if (!Array.isArray(pageItems)) throw new Error("Paginated API response was not an array.");
    items.push(...pageItems);
    if (pageItems.length < pageSize) return items;
  }
}

async function commitStatuses(token, repo, commit) {
  return collectPages((page, pageSize) =>
    githubRequest(
      token,
      `/repos/${repo}/commits/${commit}/statuses?per_page=${pageSize}&page=${page}`
    )
  );
}

async function publishReadinessBranch({ token, repo, commit, environment }) {
  const branch = readinessBranch(environment);
  const readPath = `/repos/${repo}/git/ref/heads/${branch}`;
  const writePath = `/repos/${repo}/git/refs/heads/${branch}`;
  const existing = await githubRequest(token, readPath, { allow404: true });
  if (existing) {
    await githubRequest(token, writePath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit, force: true }),
    });
  } else {
    await githubRequest(token, `/repos/${repo}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit }),
    });
  }
}

function writeManifest(environment, manifest) {
  const directory = process.env.RUNNER_TEMP || os.tmpdir();
  const manifestPath = path.join(directory, `backend-config-ready-${environment}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "ascii");
  return manifestPath;
}

async function recordReadiness(inputs) {
  const config = loadLocalConfig(inputs.configRoot);
  const hash = configHash(config.files);
  const commit = process.env.GITHUB_SHA;
  if (!commit) throw new Error("GITHUB_SHA is required in record mode.");

  try {
    const checks = await verifyLiveFirebase({
      projectId: inputs.projectId,
      serviceAccountFile: inputs.serviceAccountFile,
      includeRealtimeDatabaseScopes: inputs.includeRealtimeDatabaseScopes,
      config,
      timeoutSeconds: inputs.timeoutSeconds,
      pollIntervalSeconds: inputs.pollIntervalSeconds,
    });
    const manifest = {
      schema_version: SCHEMA_VERSION,
      backend_repo: inputs.backendRepo,
      backend_ref: inputs.backendRef,
      backend_commit: commit,
      environment: inputs.environment,
      firebase_project_id: inputs.projectId,
      config_hash: hash,
      verified_at: new Date().toISOString(),
      workflow_run_url: workflowRunUrl(),
      checks,
    };
    const manifestPath = writeManifest(inputs.environment, manifest);
    await postCommitStatus({
      token: inputs.githubToken,
      repo: inputs.backendRepo,
      commit,
      environment: inputs.environment,
      state: "success",
      projectId: inputs.projectId,
      hash,
    });
    await publishReadinessBranch({
      token: inputs.githubToken,
      repo: inputs.backendRepo,
      commit,
      environment: inputs.environment,
    });
    return { manifest, manifestPath };
  } catch (error) {
    try {
      const statuses = await commitStatuses(inputs.githubToken, inputs.backendRepo, commit);
      const previousSuccess = findSuccessfulReadinessStatus(statuses || [], inputs.environment, {
        projectId: inputs.projectId,
        readyConfigHash: hash,
        currentConfigHash: hash,
      });
      if (previousSuccess) {
        console.warn("::warning::Live verification failed, but existing successful readiness evidence was preserved.");
      } else {
        await postCommitStatus({
          token: inputs.githubToken,
          repo: inputs.backendRepo,
          commit,
          environment: inputs.environment,
          state: "failure",
          projectId: inputs.projectId,
          hash,
          description: "Live Firebase indexes or rules are not ready",
        });
      }
    } catch (statusError) {
      console.error(`::warning::Unable to publish failure status: ${statusError.message}`);
    }
    throw error;
  }
}

async function readReadinessBranch(token, repo, environment) {
  const branch = readinessBranch(environment);
  const ref = await githubRequest(token, `/repos/${repo}/git/ref/heads/${branch}`, {
    allow404: true,
  });
  if (!ref) {
    throw new Error(`No backend readiness marker exists for ${environment}. Deploy the backend to ${environment} first.`);
  }
  if (ref.object?.type !== "commit" || !ref.object.sha) {
    throw new Error(`Backend readiness marker ${branch} does not point to a commit.`);
  }
  return ref.object.sha;
}

function validateStatusEvidence(status, expected) {
  const errors = [];
  const match = String(status?.description || "").match(/^(\S+) sha256:([0-9a-f]{64})$/);
  if (!match) return ["readiness status evidence is malformed"];
  const [, projectId, configHash] = match;
  if (projectId !== expected.projectId) {
    errors.push(`Firebase project ${projectId}`);
  }
  if (configHash !== expected.readyConfigHash) errors.push("readiness status hash does not match its commit");
  if (configHash !== expected.currentConfigHash) errors.push("backend config hash is stale");
  return errors;
}

function findSuccessfulReadinessStatus(statuses, environment, expected) {
  const candidates = statuses.filter(
    (status) => status.context === readinessContext(environment) && status.state === "success"
  );
  return candidates.find((status) => validateStatusEvidence(status, expected).length === 0) || null;
}

async function requireReadiness(inputs) {
  const config = await loadGithubConfig(inputs.backendRepo, inputs.backendRef, inputs.githubToken);
  const currentHash = configHash(config.files);
  const commit = await readReadinessBranch(
    inputs.githubToken,
    inputs.backendRepo,
    inputs.environment
  );
  const readyConfig = await loadGithubConfig(inputs.backendRepo, commit, inputs.githubToken);
  const readyHash = configHash(readyConfig.files);
  const statuses = await commitStatuses(inputs.githubToken, inputs.backendRepo, commit);
  const expectedEvidence = {
    projectId: inputs.projectId,
    readyConfigHash: readyHash,
    currentConfigHash: currentHash,
  };
  const readinessStatus = findSuccessfulReadinessStatus(statuses || [], inputs.environment, expectedEvidence);
  if (!readinessStatus) {
    const latestSuccess = (statuses || []).find(
      (status) => status.context === readinessContext(inputs.environment) && status.state === "success"
    );
    const errors = latestSuccess ? validateStatusEvidence(latestSuccess, expectedEvidence) : [];
    throw new Error(
      errors.length
        ? `Backend config is not ready for ${inputs.environment}: ${errors.join(", ")}. Deploy ${inputs.backendRepo}@${inputs.backendRef} to ${inputs.environment} first.`
        : `${readinessContext(inputs.environment)} has no matching successful evidence on backend commit ${commit}. Deploy the backend first.`
    );
  }
  const manifest = {
    schema_version: SCHEMA_VERSION,
    backend_repo: inputs.backendRepo,
    backend_ref: inputs.backendRef,
    backend_commit: commit,
    environment: inputs.environment,
    firebase_project_id: inputs.projectId,
    config_hash: currentHash,
    verified_at: readinessStatus.created_at || "",
    workflow_run_url: readinessStatus.target_url || "",
    checks: { recorded_by_backend_deploy: true },
  };
  const manifestPath = writeManifest(inputs.environment, manifest);
  return { manifest, manifestPath };
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (!["true", "false"].includes(normalized)) throw new Error(`${name} must be true or false.`);
  return normalized === "true";
}

function loadInputs() {
  const mode = actionInput("mode", { required: true }).toLowerCase();
  if (!['record', 'require'].includes(mode)) throw new Error("mode must be record or require.");
  const environment = actionInput("environment", { required: true }).toLowerCase();
  if (!["dev", "beta", "prod"].includes(environment)) {
    throw new Error("environment must be dev, beta, or prod.");
  }
  const inputs = {
    mode,
    environment,
    projectId: actionInput("firebase-project-id", { required: true }),
    backendRepo: actionInput("backend-repo", { required: true }),
    backendRef: actionInput("backend-ref", { defaultValue: "main" }),
    githubToken: actionInput("github-token", { required: true }),
    serviceAccountFile: actionInput("service-account-file"),
    includeRealtimeDatabaseScopes: parseBoolean(
      actionInput("include-realtime-database-scopes", { defaultValue: "false" }),
      "include-realtime-database-scopes"
    ),
    configRoot: actionInput("config-root", { defaultValue: "." }),
    timeoutSeconds: parsePositiveInteger(actionInput("timeout-seconds", { defaultValue: "900" }), "timeout-seconds"),
    pollIntervalSeconds: parsePositiveInteger(
      actionInput("poll-interval-seconds", { defaultValue: "15" }),
      "poll-interval-seconds"
    ),
  };
  if (mode === "record" && !inputs.serviceAccountFile) {
    throw new Error("service-account-file is required in record mode.");
  }
  return inputs;
}

async function main() {
  try {
    const inputs = loadInputs();
    const result = inputs.mode === "record" ? await recordReadiness(inputs) : await requireReadiness(inputs);
    setOutput("config_hash", result.manifest.config_hash);
    setOutput("backend_commit", result.manifest.backend_commit);
    setOutput("manifest_path", result.manifestPath);
    appendSummary([
      `## Backend Config Ready / ${inputs.environment}`,
      "",
      `- Firebase project: \`${inputs.projectId}\``,
      `- Backend: \`${inputs.backendRepo}@${result.manifest.backend_commit}\``,
      `- Config hash: \`${result.manifest.config_hash}\``,
      `- Mode: \`${inputs.mode}\``,
    ]);
    console.log(
      `Backend Config Ready / ${inputs.environment}: ${inputs.projectId} at ${result.manifest.backend_commit}`
    );
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  assessCompositeIndexes,
  assessFieldOverride,
  canonicalCompositeIndex,
  collectPages,
  collectConfigPaths,
  configHash,
  findSuccessfulReadinessStatus,
  findRulesRelease,
  firestoreDatabaseId,
  googleOAuthScope,
  listCompositeIndexes,
  parseBoolean,
  realtimeDatabaseUrl,
  readinessBranch,
  readinessContext,
  rulesContentMatches,
  storageBucket,
  stableStringify,
  validateStatusEvidence,
};
