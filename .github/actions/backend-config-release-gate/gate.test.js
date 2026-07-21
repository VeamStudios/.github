const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assessCompositeIndexes,
  assessFieldOverride,
  canonicalCompositeIndex,
  collectConfigPaths,
  configHash,
  findRulesRelease,
  readinessBranch,
  readinessContext,
  rulesContentMatches,
  validateStatusEvidence,
} = require("./gate");

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

test("readiness names are stable", () => {
  assert.equal(readinessBranch("prod"), "backend-config-ready/prod");
  assert.equal(readinessContext("prod"), "Backend Config Ready / prod");
});
