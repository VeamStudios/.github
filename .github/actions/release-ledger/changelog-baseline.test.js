const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBaseline, resolveBaselines, BaselineError } = require('./changelog-baseline');
const { hash, rich } = require('./record');
const repo = 'VeamStudios/SiteAuditPro-iOS';
const target = 'ios-consumer';
const releasesId = '8beb58ea-dd4f-4777-8799-b6694ade6317';
const oldTime = '2026-01-01T10:00:00Z';
const newTime = '2026-01-02T10:00:00Z';
const checkedAt = '2026-01-02T11:00:00Z';
function fixture(overrides = {}) {
  const manifest = { schemaVersion: 2, repository: repo, target, version: 'v10.7.3', build: '1', commit: 'a'.repeat(40), event: 'release', ...overrides };
  manifest.key = `${manifest.repository}/${manifest.target}/${manifest.event}/${manifest.version}`;
  const verification = { kind: 'app-store', version: manifest.version.replace(/^v/, ''), platform: 'IOS', build: manifest.build,
    commit: manifest.commit, bundleId: manifest.target === 'ios-enterprise' ? 'com.veamstudios.iaudit.enterprise' : 'com.veamstudios.iaudit',
    appStoreVersionId: 'db645b65-b744-4e45-bc2f-5f5e7f661b6f', state: 'READY_FOR_DISTRIBUTION', downloadable: true,
    phasedReleaseState: 'COMPLETE', checkedAt, evidence: 'https://api.appstoreconnect.apple.com/v1/appStoreVersions/db645b65-b744-4e45-bc2f-5f5e7f661b6f/build' };
  const observation = { phase: 'live', releasedAt: newTime, verification };
  const row = { id: '3f006908-3a03-814c-a5cf-caf62cd90721', properties: {
    Manifest: rich(JSON.stringify(manifest)), 'Manifest Hash': rich(hash(manifest)), Repository: rich(manifest.repository),
    Target: { select: { name: manifest.target === 'ios-enterprise' ? 'iOS — Enterprise' : 'iOS — Consumer' } },
    Commit: rich(manifest.commit), State: { select: { name: 'Released' } }, 'Released At': { date: { start: newTime } },
    'Observed At': { date: { start: checkedAt } },
    'App Store Observation': rich(JSON.stringify({ owner: 'store', recordedAt: checkedAt, observation, releasedAt: newTime })),
  } };
  return { row, manifest, observation };
}
function owned(row, observation, time = checkedAt) {
  row.properties['App Store Observation'] = rich(JSON.stringify({ owner: 'store', recordedAt: time, observation,
    ...(observation.releasedAt ? { releasedAt: observation.releasedAt } : {}) }));
}
function fake(rows, { pages, targetRows } = {}) {
  const calls = [];
  const api = { notion: async (path, method, body) => {
    calls.push({ path, method: method || 'GET', body });
    if (method === undefined && path === `/data_sources/${releasesId}`) return { properties: {
      Target: { type: 'select', select: { options: [{ name: 'iOS — Consumer' }, { name: 'iOS — Enterprise' }] } },
      Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } },
    } };
    assert.equal(method, 'POST');
    assert.equal(path, `/data_sources/${releasesId}/query`);
    if (pages) return body.start_cursor ? { results: pages[1], has_more: false } : { results: pages[0], has_more: true, next_cursor: 'second' };
    const selected = body.filter.and[1].or[0].select.equals;
    return { results: targetRows ? targetRows[selected] || [] : rows, has_more: false };
  } };
  return { config: { api, repo, target, releasesId }, calls };
}
async function rejects(rows, code, options) {
  const { config } = fake(rows, options);
  await assert.rejects(resolveBaseline(config), error => error instanceof BaselineError && error.code === code);
}

test('reads only schema and paginated query, returns frozen identity with proof digest', async () => {
  const { row, manifest } = fixture();
  const { config, calls } = fake([row]);
  const result = await resolveBaseline(config);
  assert.equal(result.commit, manifest.commit);
  assert.equal(result.version, manifest.version);
  assert.equal(result.pageId, row.id);
  assert.equal(result.observedAt, checkedAt);
  assert.match(result.proofDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
  assert.deepEqual(calls[1].body.filter.and[0], { property: 'Repository', rich_text: { equals: repo } });
  assert.equal(calls[1].body.filter.and[1].or[0].select.equals, 'iOS — Consumer');
});
test('does not depend on API page order and reads all pages', async () => {
  const newer = fixture();
  const older = fixture({ version: 'v10.7.2', commit: 'b'.repeat(40) });
  older.row.id = '3f006908-3a03-814c-a5cf-caf62cd90722';
  older.observation.releasedAt = oldTime; owned(older.row, older.observation);
  const { config, calls } = fake([], { pages: [[older.row], [newer.row]] });
  assert.equal((await resolveBaseline(config)).commit, newer.manifest.commit);
  assert.equal(calls[2].body.start_cursor, 'second');
});
test('empty lookup has an explicit missing baseline error', async () => rejects([], 'missing'));
test('TestFlight/upload and prepare do not count as shipped', async () => {
  for (const phase of ['uploaded', 'prepare']) {
    const { row, observation } = fixture();
    observation.phase = phase; delete observation.releasedAt;
    row.properties.State = { select: { name: phase === 'uploaded' ? 'Uploaded' : 'Waiting' } };
    delete row.properties['Released At']; owned(row, observation);
    await rejects([row], 'missing');
  }
});
test('older positive cannot mask latest store lookup error', async () => {
  const { row, observation } = fixture();
  const older = fixture({ version: 'v10.7.2', commit: 'b'.repeat(40) });
  older.row.id = '3f006908-3a03-814c-a5cf-caf62cd90722';
  older.observation.releasedAt = oldTime; owned(older.row, older.observation);
  observation.verificationError = 'lookup failed'; observation.verificationStatus = 'error'; owned(row, observation);
  await rejects([older.row, row], 'unverified');
});
test('latest owned failed proof overrides stale positive shared Observation', async () => {
  const { row, observation } = fixture();
  row.properties.Observation = rich(JSON.stringify(observation));
  observation.verificationError = 'lookup failed'; owned(row, observation);
  await rejects([row], 'unverified');
});
test('latest rollout or withdrawal cannot select an older complete baseline', async () => {
  for (const phase of ['rollout', 'withdrawn']) {
    const { row, observation } = fixture();
    observation.phase = phase; observation.verification.phasedReleaseState = 'ACTIVE'; owned(row, observation);
    await rejects([row], 'unverified');
  }
});
test('rejects latest unverified released candidate instead of earlier verified row', async () => {
  const latest = fixture({ version: 'v10.7.4', commit: 'c'.repeat(40) });
  latest.row.id = '3f006908-3a03-814c-a5cf-caf62cd90722';
  latest.row.properties['Released At'] = { date: { start: '2026-01-03T10:00:00Z' } };
  delete latest.row.properties['App Store Observation'];
  await rejects([fixture().row, latest.row], 'unverified');
});
test('rejects frozen hash corruption and cross-target response', async () => {
  const corrupt = fixture(); corrupt.row.properties['Manifest Hash'] = rich('0'.repeat(64));
  await rejects([corrupt.row], 'invalid');
  await rejects([fixture({ target: 'ios-enterprise' }).row], 'invalid');
});
test('rejects mutable display commit disagreement without using it', async () => {
  const { row } = fixture(); row.properties.Commit = rich('b'.repeat(40));
  await rejects([row], 'conflict');
});
test('rejects duplicate release identity even when duplicate proof matches', async () => {
  const duplicate = fixture(); duplicate.row.id = '3f006908-3a03-814c-a5cf-caf62cd90722';
  await rejects([fixture().row, duplicate.row], 'ambiguous');
});
test('rejects conflicting same-version commits and release-time ties', async () => {
  const conflicting = fixture({ commit: 'b'.repeat(40) }); conflicting.row.id = '3f006908-3a03-814c-a5cf-caf62cd90722';
  await rejects([fixture().row, conflicting.row], 'ambiguous');
  const tie = fixture({ version: 'v10.7.4', commit: 'c'.repeat(40) }); tie.row.id = '3f006908-3a03-814c-a5cf-caf62cd90722';
  await rejects([fixture().row, tie.row], 'ambiguous');
});
test('release candidate without ordering time cannot silently disappear', async () => {
  const { row, observation } = fixture(); delete row.properties['Released At']; delete observation.releasedAt; owned(row, observation);
  await rejects([row], 'invalid');
});
test('malformed owned record and owned writer error invalidate proof', async () => {
  const malformed = fixture(); malformed.row.properties['App Store Observation'] = rich('{');
  await rejects([malformed.row], 'invalid');
  const badTime = fixture(); owned(badTime.row, badTime.observation, 'unknown');
  await rejects([badTime.row], 'invalid');
  const badOwner = fixture(); badOwner.row.properties['App Store Error'] = rich('lookup failed');
  await rejects([badOwner.row], 'unverified');
});
test('requires exact iOS build/version/commit/bundle and distribution evidence', async () => {
  for (const patch of [{ build: '2' }, { version: '10.7.4' }, { commit: 'b'.repeat(40) }, { bundleId: 'com.other.app' },
    { platform: 'MAC_OS' }, { downloadable: false }, { state: 'WAITING_FOR_REVIEW' }, { phasedReleaseState: 'ACTIVE' },
    { evidence: 'https://example.com/proof' }, { checkedAt: 'unknown' }]) {
    const { row, observation } = fixture(); Object.assign(observation.verification, patch); owned(row, observation);
    await rejects([row], 'unverified');
  }
});
test('audited historical baseline remains a comparison proof without availability claim', async () => {
  const { row, manifest } = fixture({ event: 'baseline', schemaVersion: 1 });
  const observation = { baseline: { kind: 'audited-production-baseline', manifestHash: hash(manifest), commit: manifest.commit,
    repository: repo, target, build: '1', checkedAt,
    evidence: ['https://github.com/VeamStudios/SiteAuditPro-iOS/commit/' + manifest.commit, 'https://appstoreconnect.apple.com/apps/430234732'] } };
  row.properties.State = { select: { name: 'Unverified' } };
  delete row.properties['App Store Observation']; row.properties.Observation = rich(JSON.stringify(observation));
  assert.equal((await resolveBaseline(fake([row]).config)).commit, manifest.commit);
  observation.baseline.evidence[1] = 'https://user:password@example.com/proof'; row.properties.Observation = rich(JSON.stringify(observation));
  await rejects([row], 'unverified');
});
test('trusted configuration is required before any API read', async () => {
  for (const patch of [{ repo: '../other' }, { target: 'package' }, { releasesId: '../secret' }, { api: {} }]) {
    const { config, calls } = fake([]);
    await assert.rejects(resolveBaseline({ ...config, ...patch }), error => error.code === 'configuration');
    assert.equal(calls.length, 0);
  }
});
test('aggregate requires distinct targets and fails if any edition lacks a baseline', async () => {
  const { config } = fake([], { targetRows: { 'iOS — Consumer': [fixture().row] } });
  await assert.rejects(resolveBaselines({ ...config, targets: ['ios-consumer', 'ios-enterprise'] }), error => error.code === 'missing');
  await assert.rejects(resolveBaselines({ ...config, targets: ['ios-consumer', 'ios-consumer'] }), error => error.code === 'configuration');
});
test('aggregate preserves both verified edition commits for caller union', async () => {
  const enterprise = fixture({ target: 'ios-enterprise', commit: 'b'.repeat(40), version: 'v10.7.4' });
  const { config } = fake([], { targetRows: { 'iOS — Consumer': [fixture().row], 'iOS — Enterprise': [enterprise.row] } });
  const result = await resolveBaselines({ ...config, targets: ['ios-consumer', 'ios-enterprise'] });
  assert.deepEqual(result.map(item => [item.target, item.commit]), [['ios-consumer', 'a'.repeat(40)], ['ios-enterprise', 'b'.repeat(40)]]);
});
test('unrelated publication error does not erase exact historical shipment', async () => {
  const { row, manifest } = fixture(); row.properties.Error = rich('Missing announcement wording');
  assert.equal((await resolveBaseline(fake([row]).config)).commit, manifest.commit);
});
test('rejects future release/proof timestamps', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const release = fixture(); release.observation.releasedAt = future; owned(release.row, release.observation);
  await rejects([release.row], 'invalid');
  const observation = fixture(); owned(observation.row, observation.observation, future);
  await rejects([observation.row], 'unverified');
  const verification = fixture(); verification.observation.verification.checkedAt = future; owned(verification.row, verification.observation);
  await rejects([verification.row], 'unverified');
});
test('pagination without a continuation cursor cannot produce partial baseline success', async () => {
  const { config } = fake([fixture().row]);
  const original = config.api.notion;
  config.api.notion = async (path, method, body) => method === 'POST' ? { results: [fixture().row], has_more: true } : original(path, method, body);
  await assert.rejects(resolveBaseline(config), error => error.code === 'invalid');
});
test('a repeated API cursor is bounded and rejected', async () => {
  const { config, calls } = fake([]);
  const original = config.api.notion;
  config.api.notion = async (path, method, body) => method === 'POST' ? { results: [], has_more: true, next_cursor: 'loop' } : original(path, method, body);
  await assert.rejects(resolveBaseline(config), error => error.code === 'invalid');
  assert.equal(calls.length, 1); // Only the schema call delegates to the original.
});
