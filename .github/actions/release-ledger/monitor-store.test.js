const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeStore, monitor } = require('./monitor-store');
const { hash, rich } = require('./record');

const manifest = { version: 'v1.2.3', build: '123', commit: 'a'.repeat(40) };
const relationshipPath = '/appStoreVersions/version/relationships/appStoreVersionPhasedRelease';
const resourcePath = '/appStoreVersions/version/appStoreVersionPhasedRelease';
const linked = { id: 'phase', type: 'appStoreVersionPhasedReleases' };
const now = () => '2026-09-08T12:00:00.000Z';

function fixture({ relationship = { data: null }, phased = { data: { ...linked, attributes: { phasedReleaseState: 'COMPLETE' } } }, state = 'READY_FOR_DISTRIBUTION', build = '123', bundleId = 'com.test.app' } = {}) {
  const calls = [];
  return { calls, findAppByBundleId: async () => ({ id: 'app', attributes: { bundleId } }), get: async path => {
    calls.push(path);
    if (path === '/apps/app/appStoreVersions') return { data: [{ id: 'version', attributes: { versionString: '1.2.3', platform: 'IOS', appStoreState: state } }] };
    if (path === '/appStoreVersions/version/build') return { data: { attributes: { version: build } } };
    const response = path === relationshipPath ? relationship : path === resourcePath ? phased : undefined;
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`Unexpected request: ${path}`);
    return response;
  } };
}

test('explicitly absent relationship records live without requesting the missing resource', async () => {
  const apple = fixture({ phased: Object.assign(new Error('Not Found'), { statusCode: 404 }) });
  const result = await observeStore(manifest, 'com.test.app', apple, now);
  assert.equal(result.phase, 'live');
  assert.equal(result.timeBasis, 'first-observed');
  assert.equal(result.releasedAt, now());
  assert.equal(result.verification.commit, manifest.commit);
  assert.equal(result.verification.build, manifest.build);
  assert.ok(!apple.calls.includes(resourcePath));
});

for (const state of ['COMPLETE', 'ACTIVE', 'PAUSED', 'INACTIVE', 'FUTURE_STATE']) {
  test(`linked phased release ${state} preserves rollout restrictions`, async () => {
    const apple = fixture({ relationship: { data: linked }, phased: { data: { ...linked, attributes: { phasedReleaseState: state } } } });
    assert.equal((await observeStore(manifest, 'com.test.app', apple)).phase, state === 'COMPLETE' ? 'live' : 'rollout');
  });
}

for (const relationship of [null, {}, { data: [] }, { data: {} }, { data: { ...linked, id: '' } }, { data: { ...linked, type: 'apps' } }]) {
  test(`malformed relationship ${JSON.stringify(relationship)} cannot establish availability`, async () => {
    await assert.rejects(observeStore(manifest, 'com.test.app', fixture({ relationship })), /relationship is missing or malformed/);
  });
}
for (const phased of [{ data: null }, { data: { ...linked } }, { data: { ...linked, id: 'other', attributes: { phasedReleaseState: 'COMPLETE' } } }, { data: { ...linked, attributes: { phasedReleaseState: '' } } }]) {
  test(`incomplete or mismatched phased evidence ${JSON.stringify(phased)} fails`, async () => {
    await assert.rejects(observeStore(manifest, 'com.test.app', fixture({ relationship: { data: linked }, phased })), /evidence is missing or inconsistent/);
  });
}
for (const endpoint of ['relationship', 'phased']) {
  for (const statusCode of [401, 403, 404, 500]) {
    test(`${endpoint} HTTP ${statusCode} remains an actionable error`, async () => {
      const error = Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
      const apple = fixture({ relationship: { data: linked }, [endpoint]: error });
      await assert.rejects(observeStore(manifest, 'com.test.app', apple), e => e === error);
    });
  }
}
test('non-live versions do not query rollout; bundle and build mismatches still fail', async () => {
  const pending = fixture({ state: 'WAITING_FOR_REVIEW' });
  assert.equal(await observeStore(manifest, 'com.test.app', pending), null);
  assert.ok(!pending.calls.includes(relationshipPath));
  await assert.rejects(observeStore(manifest, 'com.test.app', fixture({ build: '124' })), /build differs/);
  await assert.rejects(observeStore(manifest, 'com.test.app', fixture({ bundleId: 'other' })), /bundle identity/);
});
test('monitor retains failed records and continues recording verified releases', async () => {
  const good = { ...manifest, key: 'good', repository: 'VeamStudios/Test', target: 'ios-consumer' };
  const bad = { ...good, key: 'bad', build: '124' };
  const rows = [bad, good].map(m => ({ id: m.key, properties: { Manifest: rich(JSON.stringify(m)), 'Manifest Hash': rich(hash(m)) } }));
  const writes = [];
  const result = await monitor({ repo: good.repository, target: good.target, bundleId: 'com.test.app', releasesId: 'releases' }, { notion: async (path, method, body) => {
    if (path === '/data_sources/releases') return { properties: { Target: { type: 'rich_text' }, Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } } } };
    if (method === 'PATCH') { writes.push({ path, body }); return {}; }
    return { results: rows, has_more: false };
  } }, fixture());
  assert.equal(result.observed, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /bad: App Store build differs/);
  assert.deepEqual(writes.map(x => x.path), ['/pages/good']);
});
