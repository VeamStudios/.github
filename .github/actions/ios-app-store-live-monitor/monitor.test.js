const assert = require("node:assert/strict");
const {
  notifiedMarker,
  pendingMarker,
  runMonitor,
} = require("./monitor");

const bundleId = "com.veamstudios.checklistinspectorpro";

function makeRelease(body, tag = "v2.1.6") {
  return {
    id: 123,
    tag_name: tag,
    html_url: `https://github.com/VeamStudios/ChecklistInspectorPro-iOS/releases/tag/${tag}`,
    body,
  };
}

class FakeGitHub {
  constructor(releases) {
    this.releases = releases;
    this.updates = [];
  }

  async listReleases() {
    return this.releases;
  }

  async getReleaseByTag(tag) {
    return this.releases.find((release) => release.tag_name === tag) || null;
  }

  async updateReleaseBody(id, body) {
    this.updates.push({ id, body });
    const release = this.releases.find((candidate) => candidate.id === id);
    if (release) release.body = body;
    return release;
  }
}

class FakeAppStoreConnect {
  constructor(resultsByVersion) {
    this.resultsByVersion = resultsByVersion;
  }

  async findAppStoreVersion(_bundleId, version) {
    if (!this.resultsByVersion.appExists) {
      return { app: null, version: null };
    }
    return {
      app: { id: "123456789" },
      version: this.resultsByVersion[version] || null,
    };
  }
}

class FakeSlack {
  constructor() {
    this.payloads = [];
  }

  async send(payload) {
    this.payloads.push(payload);
  }
}

function baseConfig(overrides = {}) {
  return {
    owner: "VeamStudios",
    repo: "ChecklistInspectorPro-iOS",
    bundleId,
    releaseLimit: 20,
    liveStates: new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"]),
    dryRun: false,
    serverUrl: "https://github.com",
    now: () => new Date("2026-06-18T10:00:00.000Z"),
    logger: { log() {} },
    ...overrides,
  };
}

async function testPendingNonLiveState() {
  const release = makeRelease(pendingMarker({ bundleId, version: "v2.1.6" }));
  const github = new FakeGitHub([release]);
  const appStoreConnect = new FakeAppStoreConnect({
    appExists: true,
    "2.1.6": { versionString: "2.1.6", state: "PENDING_DEVELOPER_RELEASE" },
  });
  const slack = new FakeSlack();

  const result = await runMonitor(baseConfig(), { github, appStoreConnect, slack });

  assert.equal(result.pending, 1);
  assert.equal(slack.payloads.length, 0);
  assert.equal(github.updates.length, 0);
  assert.match(release.body, /:pending/);
}

async function testPendingLiveStateNotifiesAndMarksRelease() {
  const release = makeRelease(pendingMarker({ bundleId, version: "v2.1.6" }));
  const github = new FakeGitHub([release]);
  const appStoreConnect = new FakeAppStoreConnect({
    appExists: true,
    "2.1.6": { versionString: "2.1.6", state: "READY_FOR_DISTRIBUTION" },
  });
  const slack = new FakeSlack();

  const result = await runMonitor(baseConfig(), { github, appStoreConnect, slack });

  assert.equal(result.notified, 1);
  assert.equal(result.liveVersion, "v2.1.6");
  assert.equal(result.liveState, "READY_FOR_DISTRIBUTION");
  assert.equal(
    result.liveReleaseUrl,
    "https://github.com/VeamStudios/ChecklistInspectorPro-iOS/releases/tag/v2.1.6"
  );
  assert.equal(slack.payloads.length, 1);
  assert.equal(github.updates.length, 1);
  assert.match(github.updates[0].body, /:notified/);
  assert.doesNotMatch(github.updates[0].body, /:pending/);
}

async function testAlreadyNotifiedSkips() {
  const release = makeRelease(
    notifiedMarker({
      bundleId,
      version: "v2.1.6",
      state: "READY_FOR_DISTRIBUTION",
      notifiedAt: "2026-06-18T10:00:00.000Z",
    })
  );
  const github = new FakeGitHub([release]);
  const appStoreConnect = new FakeAppStoreConnect({
    appExists: true,
    "2.1.6": { versionString: "2.1.6", state: "READY_FOR_DISTRIBUTION" },
  });
  const slack = new FakeSlack();

  const result = await runMonitor(baseConfig({ releaseTag: "v2.1.6" }), { github, appStoreConnect, slack });

  assert.equal(result.alreadyNotified, 1);
  assert.equal(result.liveVersion, "v2.1.6");
  assert.equal(result.liveState, "READY_FOR_DISTRIBUTION");
  assert.equal(slack.payloads.length, 0);
  assert.equal(github.updates.length, 0);
}

async function testMissingAppStoreVersionSkipsWithSummaryItem() {
  const release = makeRelease(pendingMarker({ bundleId, version: "v2.1.6" }));
  const github = new FakeGitHub([release]);
  const appStoreConnect = new FakeAppStoreConnect({ appExists: true });
  const slack = new FakeSlack();

  const result = await runMonitor(baseConfig(), { github, appStoreConnect, slack });

  assert.equal(result.missingVersion, 1);
  assert.equal(result.items[0].result, "missing_app_store_version");
  assert.equal(slack.payloads.length, 0);
  assert.equal(github.updates.length, 0);
}

async function run() {
  await testPendingNonLiveState();
  await testPendingLiveStateNotifiesAndMarksRelease();
  await testAlreadyNotifiedSkips();
  await testMissingAppStoreVersionSkipsWithSummaryItem();
  console.log("ios-app-store-live-monitor tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
