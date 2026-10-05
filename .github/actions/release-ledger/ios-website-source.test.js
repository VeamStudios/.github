const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectSource, publicObservation } = require('./ios-website-source');
const { hash, rich } = require('./record');
const repo = 'VeamStudios/ChecklistInspectorPro-iOS', bundleId = 'com.veamstudios.checklistinspectorpro';
const now = '2026-10-05T12:30:00Z';
function row(version = 'v2.2.2', build = '7') {
  const manifest = { schemaVersion: 2, repository: repo, target: 'ios-consumer', event: 'release', version, build, commit: 'a'.repeat(40), key: `${repo}/ios-consumer/release/${version}` };
  return { id: version, properties: { Manifest: rich(JSON.stringify(manifest)), 'Manifest Hash': rich(hash(manifest)) } };
}
function api(rows) { return { notion: async path => path === '/data_sources/db' ? { properties: { Target: { type: 'rich_text' }, Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } } } } : { results: rows, has_more: false } }; }
function apple({ state = 'READY_FOR_DISTRIBUTION', phase = 'ACTIVE', downloadable = true, build = '7' } = {}) {
  return { findAppByBundleId: async () => ({ id: 'app', attributes: { bundleId } }), get: async (path, params) => {
    if (path.endsWith('/build')) return { data: { attributes: { version: build } } };
    if (path.includes('/relationships/')) return { data: phase === 'NONE' ? null : { id: 'phase', type: 'appStoreVersionPhasedReleases' } };
    if (path.endsWith('/appStoreVersionPhasedRelease')) return { data: { id: 'phase', type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: phase } } };
    return { data: [{ id: 'asc-version', attributes: { versionString: params['filter[versionString]'], platform: 'IOS', appVersionState: state, downloadable } }] };
  } };
}
const config = { repo, bundleId, releasesId: 'db' };
test('exact fresh ACTIVE 2.2.2 wins independently of stale GB2.2.0 or older GitHub events', async () => {
  const result = await selectSource({ ...config, storefrontVersion: '2.2.0', eventTag: 'v2.2.0' }, api([row()]), apple(), () => now);
  assert.equal(result.live_version, '2.2.2');
  assert.equal(result.source_commit, 'a'.repeat(40));
  assert.equal(result.verification.phasedReleaseState, 'ACTIVE');
});
for (const phase of ['COMPLETE', 'NONE']) test(`public ${phase} exact build selects its frozen source`, async () => assert.equal((await selectSource(config, api([row()]), apple({ phase }), () => now)).live_version, '2.2.2'));
for (const options of [{ phase: 'PAUSED' }, { state: 'PENDING_DEVELOPER_RELEASE' }, { state: 'PREPARE_FOR_SUBMISSION' }, { downloadable: false }]) test(`held/private/withdrawn is not selected: ${JSON.stringify(options)}`, async () => await assert.rejects(selectSource(config, api([row()]), apple(options), () => now), /No exact publicly/));
test('a newer held release cannot replace the exact public release', async () => {
  const client = apple(); const get = client.get;
  client.get = async (path, params) => params?.['filter[versionString]'] === '2.2.3' ? { data: [{ id: 'future', attributes: { versionString: '2.2.3', platform: 'IOS', appVersionState: 'PENDING_DEVELOPER_RELEASE' } }] } : get(path, params);
  assert.equal((await selectSource(config, api([row('v2.2.3', '8'), row()]), client, () => now)).live_version, '2.2.2');
});
test('historical unverified snapshots do not manufacture a source', async () => {
  const historical = row('v2.2.0', ''); historical.properties.Historical = { checkbox: true };
  await assert.rejects(selectSource(config, api([historical]), apple(), () => now), /No exact publicly/);
});
test('exact build/hash and ambiguous-source errors fail before any write', async () => {
  await assert.rejects(selectSource(config, api([row()]), apple({ build: '8' }), () => now), /differs/);
  await assert.rejects(selectSource(config, api([row(), row()]), apple(), () => now), /Ambiguous/);
  const invalid = row(); invalid.properties['Manifest Hash'] = rich('wrong');
  await assert.rejects(selectSource(config, api([invalid]), apple(), () => now), /hash mismatch/);
});
test('stale or future positive proof is not public authority', async () => {
  const source = await selectSource(config, api([row()]), apple(), () => now);
  const manifest = JSON.parse(row().properties.Manifest.rich_text[0].text.content);
  for (const checkedAt of ['2026-10-05T09:00:00Z', '2026-10-05T12:32:00Z']) assert.equal(publicObservation({ phase: 'rollout', verification: { ...source.verification, checkedAt } }, manifest, bundleId, Date.parse(now)), false);
});
test('an ASC failure cannot fall back to cached proof or an older release', async () => {
  await assert.rejects(selectSource(config, api([row()]), { findAppByBundleId: async () => { throw Error('ASC unavailable'); } }, () => now), /ASC unavailable/);
});
