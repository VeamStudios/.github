const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildPageProperties,
  remoteConfigValue,
  resolveProductPageId,
  runSync,
} = require("./sync");

const cipProductId = "30c06908-3a03-8088-bfc4-f9a47469e4a6";

function richText(value) {
  return { rich_text: value ? [{ plain_text: value }] : [] };
}

function relation(id) {
  return { relation: [{ id }] };
}

function page({ id, title, productId, iosKey = "", webKey = "", androidKey = "" }) {
  return {
    id,
    properties: {
      Name: { title: [{ plain_text: title }] },
      Product: relation(productId),
      "iOS RC Key": richText(iosKey),
      "Web RC Key": richText(webKey),
      "Android RC Key": richText(androidKey),
    },
  };
}

class FakeNotion {
  constructor(pages) {
    this.pages = pages;
    this.updates = [];
    this.queries = 0;
  }

  async queryDataSource() {
    this.queries += 1;
    return { results: this.pages, has_more: false };
  }

  async updatePage(id, properties) {
    this.updates.push({ id, properties });
  }
}

class FakeFirebase {
  constructor(template) {
    this.template = template;
  }

  async getTemplate() {
    return this.template;
  }
}

function baseConfig(overrides = {}) {
  return {
    productPageId: cipProductId,
    workItemsDataSourceId: "work-items",
    platform: "all",
    productionState: "",
    productionEvidence: "",
    dryRun: false,
    now: () => new Date("2026-06-19T12:00:00.000Z"),
    ...overrides,
  };
}

async function testRemoteConfigValuesMirrorExactly() {
  const template = {
    parameters: {
      false_flag: { defaultValue: { value: "false" } },
      preview_flag: { defaultValue: { value: "research-preview" } },
      true_flag: { defaultValue: { value: "true" } },
      in_app_default_flag: { defaultValue: { useInAppDefault: true } },
    },
  };

  assert.equal(remoteConfigValue(template, "missing_flag"), "missing");
  assert.equal(remoteConfigValue(template, "false_flag"), "false");
  assert.equal(remoteConfigValue(template, "preview_flag"), "research-preview");
  assert.equal(remoteConfigValue(template, "true_flag"), "true");
  assert.equal(remoteConfigValue(template, "in_app_default_flag"), "useInAppDefault");
}

async function testProductSlugResolvesPageId() {
  assert.equal(resolveProductPageId({ product: "cip" }), cipProductId);
  assert.equal(resolveProductPageId({ product: "Checklist Inspector Pro" }), cipProductId);
  assert.equal(
    resolveProductPageId({ product: "sap" }),
    "30c06908-3a03-80d0-9845-fe97daa54c31"
  );
  assert.equal(resolveProductPageId({ product: "cip", productPageId: "override" }), "override");
}

async function testSyncWritesExactRcValues() {
  const notion = new FakeNotion([
    page({
      id: "work-item-1",
      title: "Floorplans",
      productId: cipProductId,
      iosKey: "floor_plans_ios",
      webKey: "floor_plans_web",
      androidKey: "floor_plans_android",
    }),
  ]);
  const firebase = new FakeFirebase({
    parameters: {
      floor_plans_ios: { defaultValue: { value: "research-preview" } },
      floor_plans_android: { defaultValue: { value: "custom-live-value" } },
    },
  });

  const summary = await runSync(baseConfig(), { notion, firebase });

  assert.equal(summary.matchedPages, 1);
  assert.equal(summary.remoteConfigChecked, 3);
  assert.equal(notion.updates.length, 1);
  assert.equal(notion.updates[0].properties["iOS Prod RC Value"].select.name, "research-preview");
  assert.equal(notion.updates[0].properties["Web Prod RC Value"].select.name, "missing");
  assert.equal(notion.updates[0].properties["Android Prod RC Value"].select.name, "custom-live-value");
  assert.equal(notion.updates[0].properties["Last Production Sync"].date.start, "2026-06-19T12:00:00.000Z");
}

async function testSyncWritesNoPlatformKeyForBlankRcKeys() {
  const notion = new FakeNotion([
    page({
      id: "work-item-1",
      title: "iOS-only feature",
      productId: cipProductId,
      iosKey: "ios_only_feature",
    }),
  ]);
  const firebase = new FakeFirebase({
    parameters: {
      ios_only_feature: { defaultValue: { value: "true" } },
    },
  });

  const summary = await runSync(baseConfig(), { notion, firebase });

  assert.equal(summary.matchedPages, 1);
  assert.equal(summary.remoteConfigChecked, 1);
  assert.equal(notion.updates.length, 1);
  assert.equal(notion.updates[0].properties["iOS Prod RC Value"].select.name, "true");
  assert.equal(notion.updates[0].properties["Web Prod RC Value"].select.name, "no platform key");
  assert.equal(notion.updates[0].properties["Android Prod RC Value"].select.name, "no platform key");
}

async function testProductionStatusTargetsPlatform() {
  const properties = buildPageProperties({
    item: { iosRcKey: "", webRcKey: "" },
    template: null,
    syncedAt: "2026-06-19T12:00:00.000Z",
    config: baseConfig({
      platform: "ios",
      productionState: "Uploaded to App Store Connect",
      productionEvidence: "https://github.com/run",
    }),
  });

  assert.equal(properties["iOS Release Status"], "Uploaded to App Store Connect");
  assert.equal(properties["Web Deploy Status"], undefined);
  assert.equal(properties["Production Evidence"], "https://github.com/run");
  assert.equal(properties["Last Production Sync"], undefined);
}

async function testAndroidReleaseStatusTargetsPlatform() {
  const properties = buildPageProperties({
    item: { iosRcKey: "", webRcKey: "", androidRcKey: "android_feature" },
    template: null,
    syncedAt: "2026-06-19T12:00:00.000Z",
    config: baseConfig({
      platform: "android",
      productionState: "In rollout",
      productionEvidence: "https://github.com/run",
    }),
  });

  assert.equal(properties["Android Release Status"], "In rollout");
  assert.equal(properties["iOS Release Status"], undefined);
  assert.equal(properties["Web Deploy Status"], undefined);
}

async function testBackendDoesNotWriteStatusOrEvidence() {
  const properties = buildPageProperties({
    item: { iosRcKey: "ios_feature", webRcKey: "web_feature", androidRcKey: "" },
    template: null,
    syncedAt: "2026-06-19T12:00:00.000Z",
    config: baseConfig({
      platform: "backend",
      productionState: "Deployed",
      productionEvidence: "https://github.com/run",
    }),
  });

  assert.equal(properties["Backend Deploy Status"], undefined);
  assert.equal(properties["Production Evidence"], undefined);
}

async function testPlatformFilteringUsesRelevantRcKeys() {
  const notion = new FakeNotion([
    page({ id: "ios-item", title: "iOS feature", productId: cipProductId, iosKey: "ios_feature" }),
    page({ id: "web-item", title: "Web feature", productId: cipProductId, webKey: "web_feature" }),
    page({ id: "android-item", title: "Android feature", productId: cipProductId, androidKey: "android_feature" }),
  ]);

  const summary = await runSync(
    baseConfig({ platform: "ios", productionState: "Uploaded to App Store Connect" }),
    { notion, firebase: null }
  );

  assert.equal(summary.matchedPages, 1);
  assert.equal(notion.updates.length, 1);
  assert.equal(notion.updates[0].id, "ios-item");
  assert.equal(notion.updates[0].properties["iOS Release Status"].select.name, "Uploaded to App Store Connect");
  assert.equal(notion.updates[0].properties["Last Production Sync"], undefined);
}

function oneItem() {
  return page({ id: "work-item-1", title: "Feature", productId: cipProductId, iosKey: "flag" });
}

async function testFailedReadsNeverClaimFreshness() {
  for (const dryRun of [false, true]) {
    const notion = new FakeNotion([oneItem()]);
    const firebase = { getTemplate: async () => { throw new Error("Firebase 403"); } };
    const summary = await runSync(baseConfig({ dryRun, platform: "ios", productionState: "Live" }), { notion, firebase });
    assert.deepEqual(summary.errors, ["Remote Config read failed: Firebase 403"]);
    assert.equal(summary.updatedPages, 0);
    assert.equal(notion.queries, 0);
    assert.deepEqual(notion.updates, []);
  }
}

async function testMissingCredentialsAndMalformedTemplates() {
  const notion = new FakeNotion([oneItem()]);
  const missing = await runSync(baseConfig({ firebaseProjectId: "test-project" }), { notion, firebase: null });
  assert.match(missing.errors.join(" "), /credentials are not configured/);
  for (const template of [null, undefined, [], "bad-template"]) {
    const summary = await runSync(baseConfig(), { notion, firebase: new FakeFirebase(template) });
    assert.match(summary.errors.join(" "), /invalid Remote Config template/);
  }
  assert.equal(notion.queries, 0);
  assert.deepEqual(notion.updates, []);
}

async function testLiveUploadWithNothingToObserveIsNoOp() {
  const notion = new FakeNotion([oneItem()]);
  for (const client of [notion, null]) {
    const summary = await runSync(baseConfig({ platform: "ios" }), { notion: client, firebase: null });
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.matchedPages, 0);
    assert.equal(summary.updatedPages, 0);
  }
  assert.equal(notion.queries, 0);
  assert.deepEqual(notion.updates, []);
}

async function testNotionReadFailureIsReported() {
  const notion = new FakeNotion([oneItem()]);
  notion.queryDataSource = async () => { throw new Error("Notion 502"); };
  const summary = await runSync(baseConfig(), { notion, firebase: new FakeFirebase({}) });
  assert.deepEqual(summary.errors, ["Work Items read failed: Notion 502"]);
  assert.equal(summary.updatedPages, 0);
  assert.deepEqual(notion.updates, []);
}

async function testPageFailureDoesNotDiscardOtherUpdates() {
  const notion = new FakeNotion([
    oneItem(),
    page({ id: "work-item-2", title: "Other feature", productId: cipProductId, iosKey: "flag" }),
  ]);
  const update = notion.updatePage.bind(notion);
  notion.updatePage = async (id, properties) => {
    if (id === "work-item-1") throw new Error("Notion 502");
    return update(id, properties);
  };
  const summary = await runSync(baseConfig(), { notion, firebase: new FakeFirebase({}) });
  assert.equal(summary.matchedPages, 2);
  assert.equal(summary.updatedPages, 1);
  assert.equal(summary.remoteConfigChecked, 2);
  assert.deepEqual(summary.errors, ["Work Item work-item-1 update failed: Notion 502"]);
  assert.deepEqual(summary.items.map(item => item.updated), [false, true]);
  assert.equal(notion.updates[0].id, "work-item-2");
}

async function testCommandExitStatusAndOutputs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-config-notion-test-"));
  try {
    const preload = path.join(dir, "fetch.cjs");
    // Exercise the actual CLI without allowing any production API requests.
    fs.writeFileSync(preload, 'global.fetch = async () => { throw new Error("simulated Notion outage"); };');
    const invoke = (inputs = {}, extra = {}) => {
      const output = path.join(dir, "outputs");
      fs.writeFileSync(output, "");
      const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "sync.js")], {
        encoding: "utf8",
        env: {
          INPUT_PRODUCT: "cip",
          INPUT_PLATFORM: "ios",
          INPUT_WORK_ITEMS_DATA_SOURCE_ID: "test-data-source",
          INPUT_NOTION_TOKEN: "fake-test-token",
          INPUT_PRODUCTION_STATE: "Live",
          ...inputs,
          GITHUB_OUTPUT: output,
          ...extra,
        },
      });
      return { ...result, outputs: fs.readFileSync(output, "utf8") };
    };
    const failed = invoke();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /::error::Work Items read failed: simulated Notion outage/);
    assert.match(failed.outputs, /updated_pages=0/);
    const missing = invoke({ INPUT_FIREBASE_PROJECT_ID: "test-project" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /credentials are not configured/);
    const skipped = invoke({ INPUT_PRODUCTION_STATE: "", INPUT_NOTION_TOKEN: "" });
    assert.equal(skipped.status, 0);
    assert.match(skipped.outputs, /matched_pages=0/);
    const outerFailure = invoke({ INPUT_PRODUCTION_STATE: "" }, { GITHUB_STEP_SUMMARY: dir });
    assert.equal(outerFailure.status, 1);
    assert.match(outerFailure.stderr, /EISDIR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testDryRunDoesNotUpdate() {
  const notion = new FakeNotion([
    page({ id: "work-item-1", title: "Floorplans", productId: cipProductId, iosKey: "floor_plans_ios" }),
  ]);
  const firebase = new FakeFirebase({
    parameters: {
      floor_plans_ios: { defaultValue: { value: "true" } },
    },
  });

  const summary = await runSync(baseConfig({ dryRun: true }), { notion, firebase });

  assert.equal(summary.matchedPages, 1);
  assert.equal(summary.updatedPages, 0);
  assert.equal(notion.updates.length, 0);
}

async function run() {
  await testRemoteConfigValuesMirrorExactly();
  await testProductSlugResolvesPageId();
  await testSyncWritesExactRcValues();
  await testSyncWritesNoPlatformKeyForBlankRcKeys();
  await testProductionStatusTargetsPlatform();
  await testAndroidReleaseStatusTargetsPlatform();
  await testBackendDoesNotWriteStatusOrEvidence();
  await testPlatformFilteringUsesRelevantRcKeys();
  await testDryRunDoesNotUpdate();
  await testFailedReadsNeverClaimFreshness();
  await testMissingCredentialsAndMalformedTemplates();
  await testLiveUploadWithNothingToObserveIsNoOp();
  await testNotionReadFailureIsReported();
  await testPageFailureDoesNotDiscardOtherUpdates();
  await testCommandExitStatusAndOutputs();
  console.log("remote-config-notion-sync tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
