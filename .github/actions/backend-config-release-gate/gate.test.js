const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
  validateStatusEvidence,
} = require("./gate");

test("Realtime Database OAuth scopes are opt-in", () => {
  assert.equal(
    googleOAuthScope(),
    "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase"
  );
  assert.equal(
    googleOAuthScope(true),
    [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/firebase",
      "https://www.googleapis.com/auth/firebase.database",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" ")
  );
});

test("parseBoolean accepts explicit booleans and rejects other input", () => {
  assert.equal(parseBoolean("true", "flag"), true);
  assert.equal(parseBoolean("FALSE", "flag"), false);
  assert.throws(() => parseBoolean("yes", "flag"), /flag must be true or false/);
});

test("collectConfigPaths includes each Firebase deployment contract", () => {
  const paths = collectConfigPaths({
    firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" },
    storage: { rules: "storage.rules" },
    database: { rules: "rdb.rules.json" },
  });
  assert.deepEqual(paths, [
    "firebase.json",
    "firestore.indexes.json",
    "firestore.rules",
    "rdb.rules.json",
    "storage.rules",
  ]);
});

test("collectPages includes evidence beyond the first API page", async () => {
  const pages = [Array.from({ length: 2 }, (_, index) => `first-${index}`), ["second-0"]];
  const requests = [];
  const result = await collectPages(async (page, pageSize) => {
    requests.push({ page, pageSize });
    return pages[page - 1];
  }, 2);
  assert.deepEqual(result, ["first-0", "first-1", "second-0"]);
  assert.deepEqual(requests, [
    { page: 1, pageSize: 2 },
    { page: 2, pageSize: 2 },
  ]);
});

test("listCompositeIndexes queries each configured collection group without a page size override", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url) => {
    requests.push(new URL(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ indexes: [] }),
    };
  };

  try {
    const indexes = await listCompositeIndexes(
      "project-id",
      "(default)",
      ["sites", "floor_plans", "sites"],
      "access-token"
    );
    assert.deepEqual(indexes, []);
    assert.deepEqual(
      requests.map((request) => {
        const match = request.pathname.match(/\/collectionGroups\/([^/]+)\/indexes$/);
        return decodeURIComponent(match[1]);
      }),
      ["floor_plans", "sites"]
    );
    assert.equal(requests.every((request) => !request.searchParams.has("pageSize")), true);
    assert.equal(requests.some((request) => request.pathname.includes("/collectionGroups/-/")), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("configHash ignores JSON key order and CRLF differences", () => {
  const left = new Map([
    ["firebase.json", '{"firestore":{"indexes":"firestore.indexes.json","rules":"firestore.rules"}}'],
    ["firestore.rules", "rules_version = '2';\r\n"],
  ]);
  const right = new Map([
    ["firestore.rules", "rules_version = '2';\n"],
    ["firebase.json", '{"firestore":{"rules":"firestore.rules","indexes":"firestore.indexes.json"}}'],
  ]);
  assert.equal(configHash(left), configHash(right));
});

test("canonicalCompositeIndex removes Firestore's implicit __name__ field", () => {
  const live = {
    name: "projects/p/databases/(default)/collectionGroups/floor_plans/indexes/1",
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "is_deleted", order: "ASCENDING" },
      { fieldPath: "order", order: "ASCENDING" },
      { fieldPath: "__name__", order: "ASCENDING" },
    ],
  };
  assert.deepEqual(canonicalCompositeIndex(live), {
    collectionGroup: "floor_plans",
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "is_deleted", order: "ASCENDING" },
      { fieldPath: "order", order: "ASCENDING" },
    ],
  });
});

test("assessCompositeIndexes distinguishes missing, building, failed, and ready", () => {
  const expected = ["ready", "building", "failed", "missing"].map((collectionGroup) => ({
    collectionGroup,
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "is_deleted", order: "ASCENDING" },
      { fieldPath: "order", order: "ASCENDING" },
    ],
  }));
  const live = expected.slice(0, 3).map((index, position) => ({
    ...index,
    name: `projects/p/databases/(default)/collectionGroups/${index.collectionGroup}/indexes/${position}`,
    state: ["READY", "CREATING", "NEEDS_REPAIR"][position],
    fields: [...index.fields, { fieldPath: "__name__", order: "ASCENDING" }],
  }));
  const result = assessCompositeIndexes(expected, live);
  assert.equal(result.ready.length, 1);
  assert.equal(result.pending.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.missing.length, 1);
});

test("assessFieldOverride requires matching ready indexes", () => {
  const expected = {
    collectionGroup: "members",
    fieldPath: "email",
    ttl: false,
    indexes: [
      { order: "ASCENDING", queryScope: "COLLECTION" },
      { order: "DESCENDING", queryScope: "COLLECTION" },
    ],
  };
  const live = {
    indexConfig: {
      indexes: [
        { queryScope: "COLLECTION", state: "READY", fields: [{ order: "ASCENDING" }] },
        { queryScope: "COLLECTION", state: "READY", fields: [{ order: "DESCENDING" }] },
      ],
    },
  };
  assert.deepEqual(assessFieldOverride(expected, live), { status: "ready" });
  live.indexConfig.indexes[1].state = "CREATING";
  assert.equal(assessFieldOverride(expected, live).status, "pending");
});

test("rulesContentMatches finds the deployed source file", () => {
  assert.equal(
    rulesContentMatches("rules_version = '2';\r\n", {
      source: { files: [{ name: "firestore.rules", content: "rules_version = '2';\n" }] },
    }),
    true
  );
});

test("findRulesRelease selects Firestore and the intended Storage bucket", () => {
  const releases = [
    { name: "projects/p/releases/cloud.firestore" },
    { name: "projects/p/releases/firebase.storage/p.appspot.com" },
    { name: "projects/p/releases/firebase.storage/other.appspot.com" },
  ];
  assert.equal(findRulesRelease(releases, "firestore"), releases[0]);
  assert.equal(findRulesRelease(releases, "storage", "p.appspot.com"), releases[1]);
});

test("validateStatusEvidence reports project and config mismatches", () => {
  const oldHash = "a".repeat(64);
  const errors = validateStatusEvidence(
    { description: `wrong-project sha256:${oldHash}` },
    {
      projectId: "intended-project",
      readyConfigHash: oldHash,
      currentConfigHash: "b".repeat(64),
    }
  );
  assert.deepEqual(errors, ["Firebase project wrong-project", "backend config hash is stale"]);
});

test("findSuccessfulReadinessStatus keeps valid evidence across a failed rerun", () => {
  const hash = "a".repeat(64);
  const statuses = [
    { context: "Backend Config Ready / prod", state: "failure", description: "Live verification failed" },
    {
      context: "Backend Config Ready / prod",
      state: "success",
      description: `intended-project sha256:${hash}`,
    },
  ];
  assert.equal(
    findSuccessfulReadinessStatus(statuses, "prod", {
      projectId: "intended-project",
      readyConfigHash: hash,
      currentConfigHash: hash,
    }),
    statuses[1]
  );
});

test("Firebase target resolution uses explicit config and fails closed", () => {
  const adminConfig = {
    storageBucket: "default.appspot.com",
    databaseURL: "https://default.europe-west1.firebasedatabase.app",
  };
  assert.equal(firestoreDatabaseId({ database: "tenant" }), "tenant");
  assert.equal(storageBucket({ bucket: "uploads.appspot.com" }, adminConfig), "uploads.appspot.com");
  assert.equal(realtimeDatabaseUrl({}, adminConfig), adminConfig.databaseURL);
  assert.equal(
    realtimeDatabaseUrl({ instance: "https://other.europe-west1.firebasedatabase.app" }, adminConfig),
    "https://other.europe-west1.firebasedatabase.app"
  );
  assert.throws(() => storageBucket({ target: "uploads" }, adminConfig), /cannot be resolved/);
  assert.throws(() => realtimeDatabaseUrl({ instance: "other" }, adminConfig), /cannot be resolved safely/);
});

test("readiness names are stable", () => {
  assert.equal(readinessBranch("prod"), "backend-config-ready/prod");
  assert.equal(readinessContext("prod"), "Backend Config Ready / prod");
});
