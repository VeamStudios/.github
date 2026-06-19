const assert = require("node:assert/strict");
const {
  buildPageProperties,
  remoteConfigValue,
  runSync,
} = require("./sync");

const cipProductId = "30c06908-3a03-8088-bfc4-f9a47469e4a6";

function richText(value) {
  return { rich_text: value ? [{ plain_text: value }] : [] };
}

function relation(id) {
  return { relation: [{ id }] };
}

function page({ id, title, productId, iosKey = "", webKey = "" }) {
  return {
    id,
    properties: {
      Name: { title: [{ plain_text: title }] },
      Product: relation(productId),
      "iOS RC Key": richText(iosKey),
      "Web RC Key": richText(webKey),
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
    productionVersion: "",
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

async function testSyncWritesExactRcValues() {
  const notion = new FakeNotion([
    page({
      id: "work-item-1",
      title: "Floorplans",
      productId: cipProductId,
      iosKey: "floor_plans_ios",
      webKey: "floor_plans_web",
    }),
  ]);
  const firebase = new FakeFirebase({
    parameters: {
      floor_plans_ios: { defaultValue: { value: "research-preview" } },
    },
  });

  const summary = await runSync(baseConfig(), { notion, firebase });

  assert.equal(summary.matchedPages, 1);
  assert.equal(summary.remoteConfigChecked, 2);
  assert.equal(notion.updates.length, 1);
  assert.equal(
    notion.updates[0].properties["iOS Prod RC Value"].rich_text[0].text.content,
    "research-preview"
  );
  assert.equal(notion.updates[0].properties["Web Prod RC Value"].rich_text[0].text.content, "missing");
}

async function testProductionStateTargetsPlatform() {
  const properties = buildPageProperties({
    item: { iosRcKey: "", webRcKey: "" },
    template: null,
    syncedAt: "2026-06-19T12:00:00.000Z",
    config: baseConfig({
      platform: "ios",
      productionState: "Uploaded to App Store Connect",
      productionVersion: "v2.1.6",
      productionEvidence: "https://github.com/run",
    }),
  });

  assert.equal(properties["iOS Production State"], "Uploaded to App Store Connect");
  assert.equal(properties["Web Production State"], undefined);
  assert.equal(properties["Production Version"], "v2.1.6");
  assert.equal(properties["Production Evidence"], "https://github.com/run");
}

async function testPlatformFilteringUsesRelevantRcKeys() {
  const notion = new FakeNotion([
    page({ id: "ios-item", title: "iOS feature", productId: cipProductId, iosKey: "ios_feature" }),
    page({ id: "web-item", title: "Web feature", productId: cipProductId, webKey: "web_feature" }),
  ]);

  const summary = await runSync(
    baseConfig({ platform: "ios", productionState: "Uploaded to App Store Connect" }),
    { notion, firebase: null }
  );

  assert.equal(summary.matchedPages, 1);
  assert.equal(notion.updates.length, 1);
  assert.equal(notion.updates[0].id, "ios-item");
  assert.equal(notion.updates[0].properties["iOS Production State"].select.name, "Uploaded to App Store Connect");
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
  await testSyncWritesExactRcValues();
  await testProductionStateTargetsPlatform();
  await testPlatformFilteringUsesRelevantRcKeys();
  await testDryRunDoesNotUpdate();
  console.log("launch-hub-production-mirror tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
