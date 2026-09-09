const assert = require("node:assert/strict");
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
  }

  async queryDataSource() {
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
  console.log("remote-config-notion-sync tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
