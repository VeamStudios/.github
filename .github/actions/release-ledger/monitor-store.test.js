const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeStore, monitor } = require('./monitor-store');
const { hash, rich, text, deployedBaseline } = require('./record');

const manifest = { version: 'v1.2.3', build: '123', commit: 'a'.repeat(40) };
const relationshipPath = '/appStoreVersions/version/relationships/appStoreVersionPhasedRelease';
const resourcePath = '/appStoreVersions/version/appStoreVersionPhasedRelease';
const linked = { id: 'phase', type: 'appStoreVersionPhasedReleases' };
const now = () => '2026-09-08T12:00:00.000Z';

function monitorFixture(entries) {
  const writes = [];
  const rows = entries.map(({ m, historical = false, digest = hash(m), observation, properties = {} }) => ({ id: m.key, properties: { Manifest: rich(JSON.stringify(m)), 'Manifest Hash': rich(digest), Historical: { checkbox: historical }, ...(observation ? { Observation: rich(JSON.stringify(observation)) } : {}), ...properties } }));
  return { writes, api: { notion: async (path, method, body) => {
    if (path === '/data_sources/releases') return { properties: { Target: { type: 'rich_text' }, Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } } } };
    if (method === 'PATCH') { writes.push({ path, body }); return {}; }
    return { results: rows, has_more: false };
  } } };
}
const monitorConfig = { repo: 'VeamStudios/Test', target: 'ios-consumer', bundleId: 'com.test.app', releasesId: 'releases' };

test('buildless historical baseline is unchanged while the current build is verified', async () => {
  const current = { ...manifest, key: 'current', repository: monitorConfig.repo, target: monitorConfig.target, event: 'release' };
  const baseline = { ...current, key: 'history', event: 'baseline', build: '', version: '10.7.0.1' };
  const { api, writes } = monitorFixture([{ m: baseline, historical: true }, { m: current }]);
  const result = await monitor(monitorConfig, api, fixture());
  assert.deepEqual(result, { checked: 2, observed: 1, skippedHistorical: 1, errors: [] });
  assert.deepEqual(writes.map(x => x.path), ['/pages/current']);
});

test('historical status does not bypass integrity checks or missing current-build evidence', async () => {
  const base = { ...manifest, repository: monitorConfig.repo, target: monitorConfig.target, event: 'baseline', build: '' };
  const { api, writes } = monitorFixture([
    { m: { ...base, key: 'current-baseline' } },
    { m: { ...base, key: 'historical-release', event: 'release' }, historical: true },
    { m: { ...base, key: 'tampered-history' }, historical: true, digest: 'wrong' },
    { m: { ...base, key: 'wrong-repository', repository: 'VeamStudios/Other' }, historical: true },
  ]);
  const result = await monitor(monitorConfig, api, fixture());
  assert.equal(result.errors.length, 4);
  assert.equal(result.skippedHistorical, 0);
  assert.equal(result.observed, 0);
  assert.deepEqual(writes, []);
});

test('historical baselines with exact builds remain eligible for verification; dry run writes nothing', async () => {
  const m = { ...manifest, key: 'history-build', repository: monitorConfig.repo, target: monitorConfig.target, event: 'baseline' };
  const { api, writes } = monitorFixture([{ m, historical: true }]);
  const result = await monitor({ ...monitorConfig, dryRun: true }, api, fixture());
  assert.deepEqual(result, { checked: 1, observed: 1, skippedHistorical: 0, errors: [] });
  assert.deepEqual(writes, []);
});

function fixture({ relationship = { data: null }, phased = { data: { ...linked, attributes: { phasedReleaseState: 'COMPLETE' } } }, state = 'READY_FOR_DISTRIBUTION', build = '123', bundleId = 'com.test.app', attributes = {} } = {}) {
  const calls = [];
  return { calls, findAppByBundleId: async () => ({ id: 'app', attributes: { bundleId } }), get: async path => {
    calls.push(path);
    if (path === '/apps/app/appStoreVersions') return { data: [{ id: 'version', attributes: { versionString: '1.2.3', platform: 'IOS', appStoreState: state, ...attributes } }] };
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
  assert.equal(result.verification.version, '1.2.3');
  assert.equal(result.verification.platform, 'IOS');
  assert.equal(result.verification.appStoreVersionId, 'version');
  assert.equal(result.verification.checkedAt, now());
  assert.equal(result.verification.phasedReleaseState, 'NONE');
  assert.equal(result.verification.phasedReleaseId, null);
  assert.equal(result.verification.currentDayNumber, undefined);
  assert.ok(!apple.calls.includes(resourcePath));
});

for (const state of ['COMPLETE', 'ACTIVE', 'PAUSED', 'INACTIVE', 'FUTURE_STATE']) {
  test(`linked phased release ${state} preserves rollout restrictions`, async () => {
    const apple = fixture({ relationship: { data: linked }, phased: { data: { ...linked, attributes: { phasedReleaseState: state } } } });
    const result = await observeStore(manifest, 'com.test.app', apple);
    assert.equal(result.phase, state === 'COMPLETE' ? 'live' : 'rollout');
    assert.equal(result.verification.phasedReleaseState, state);
    assert.equal(result.verification.phasedReleaseId, linked.id);
    assert.equal(result.verification.currentDayNumber, undefined);
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
  assert.deepEqual(writes.map(x => x.path), ['/pages/bad', '/pages/good']);
  const failure = JSON.parse(text(writes[0].body.properties.Observation));
  assert.equal(failure.phase, 'uploaded');
  assert.equal(failure.verification, undefined);
  assert.match(failure.verificationError, /build differs/);
});
test('a store version not created after TestFlight upload remains pending',async()=>{const apple=fixture();const get=apple.get;apple.get=async path=>path==='/apps/app/appStoreVersions'?{data:[]}:get(path);assert.equal(await observeStore(manifest,'com.test.app',apple),null)});
test('non-live version without an assigned build remains pending',async()=>{const apple=fixture({state:'PREPARE_FOR_SUBMISSION'});const get=apple.get;apple.get=async path=>{if(path.endsWith('/build'))throw new Error('404');return get(path)};assert.equal(await observeStore(manifest,'com.test.app',apple),null);assert.ok(!apple.calls.some(p=>p.endsWith('/build')))});
test('malformed version query is still actionable',async()=>{const apple=fixture();apple.get=async()=>({});await assert.rejects(observeStore(manifest,'com.test.app',apple),/malformed/)});
test('malformed manifest or observation does not abort sibling records',async()=>{const m={...manifest,key:'good',repository:monitorConfig.repo,target:monitorConfig.target};const row={id:'good',properties:{Manifest:rich(JSON.stringify(m)),'Manifest Hash':rich(hash(m))}};const rows=[{id:'bad-json',properties:{Manifest:rich('{')}},{...row,id:'bad-observation',properties:{...row.properties,Observation:rich('{')}},row];const writes=[];const api={notion:async(path,method,body)=>{if(path==='/data_sources/releases')return {properties:{Target:{type:'rich_text'},Products:{type:'relation',relation:{data_source_id:'30c06908-3a03-80ca-bd1b-000b2bbce6d8'}}}};if(method==='PATCH'){writes.push(path);return {}};return {results:rows,has_more:false}}};const result=await monitor(monitorConfig,api,fixture());assert.equal(result.errors.length,2);assert.equal(result.observed,1);assert.deepEqual(writes,['/pages/good'])});

for (const state of ['ACTIVE', 'COMPLETE', 'PAUSED', 'FUTURE_STATE']) {
  test(`${state} retains exact raw progress without inventing a percentage`, async () => {
    const attributes = { phasedReleaseState: state, currentDayNumber: 2, totalPauseDuration: 0, startDate: '2026-09-07T10:00:00Z' };
    const result = await observeStore(manifest, 'com.test.app', fixture({ relationship: { data: linked }, phased: { data: { ...linked, attributes } } }), now);
    for (const [key, value] of Object.entries(attributes)) assert.equal(result.verification[key], value);
    assert.equal(result.verification.checkedAt, now());
    assert.equal(result.verification.progress, undefined);
    assert.equal(result.verification.percentage, undefined);
  });
}

test('current Apple state wins over deprecated state; both raw fields remain available', async () => {
  const apple = fixture({ state: 'READY_FOR_SALE', attributes: { appVersionState: 'READY_FOR_DISTRIBUTION', downloadable: true } });
  const result = await observeStore(manifest, 'com.test.app', apple, now);
  assert.equal(result.verification.state, 'READY_FOR_DISTRIBUTION');
  assert.equal(result.verification.appStoreState, 'READY_FOR_SALE');
  assert.equal(result.verification.appVersionState, 'READY_FOR_DISTRIBUTION');
  assert.equal(result.verification.downloadable, true);
  const replaced = await observeStore(manifest, 'com.test.app', fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  assert.equal(replaced.phase, 'superseded');
  assert.equal(replaced.verification.state, 'REPLACED_WITH_NEW_VERSION');
  assert.equal(replaced.verification.checkedAt, now());
});

for (const options of [{ state: 'REMOVED_FROM_SALE' }, { state: 'DEVELOPER_REMOVED_FROM_SALE' }, { attributes: { downloadable: false } }]) {
  test(`explicit withdrawal ${JSON.stringify(options)} requires the recorded build and retains negative evidence`, async () => {
    const apple = fixture(options);
    const result = await observeStore(manifest, 'com.test.app', apple, now);
    assert.equal(result.phase, 'withdrawn');
    assert.equal(result.verification.build, manifest.build);
    assert.equal(result.verification.commit, manifest.commit);
    assert.equal(result.verification.version, '1.2.3');
    assert.equal(result.verification.checkedAt, now());
    assert.equal(result.verification.phasedReleaseState, undefined);
    assert.equal(result.releasedAt, undefined);
    assert.ok(!apple.calls.includes(relationshipPath));
    await assert.rejects(observeStore(manifest, 'com.test.app', fixture({ ...options, build: '124' })), /build differs/);
  });
}

const current = { ...manifest, key: 'current', repository: monitorConfig.repo, target: monitorConfig.target, event: 'release' };
const firstSeen = '2026-09-07T12:00:00.000Z';
async function releasedObservation(phase = 'live') {
  return { ...await observeStore(manifest, 'com.test.app', fixture(), () => firstSeen), phase, website: { diagnostic: 'preserved' } };
}

for (const phase of ['live', 'rollout']) {
  test(`previous ${phase} evidence is refreshed with the first release time intact`, async () => {
    const previous = await releasedObservation(phase);
    const { api, writes } = monitorFixture([{ m: current, observation: previous, properties: { 'Released At': { date: { start: firstSeen } } } }]);
    const result = await monitor(monitorConfig, api, fixture(), now);
    assert.equal(result.observed, 1);
    assert.equal(writes.length, 1);
    const properties = writes[0].body.properties;
    const fresh = JSON.parse(text(properties.Observation));
    assert.equal(fresh.phase, 'live');
    assert.equal(fresh.releasedAt, firstSeen);
    assert.equal(fresh.verification.checkedAt, now());
    assert.deepEqual(fresh.website, previous.website);
    assert.equal(properties['Released At'].date.start, firstSeen);
    assert.equal(properties['Observed At'].date.start, now());
  });
}

test('live to paused to active to complete retains the original first observed time', async () => {
  let previous = await releasedObservation();
  for (const state of ['PAUSED', 'ACTIVE', 'COMPLETE']) {
    const { api, writes } = monitorFixture([{ m: current, observation: previous }]);
    const apple = fixture({ relationship: { data: linked }, phased: { data: { ...linked, attributes: { phasedReleaseState: state, currentDayNumber: 4, totalPauseDuration: 3 } } } });
    const result = await monitor(monitorConfig, api, apple, now);
    assert.equal(result.errors.length, 0);
    previous = JSON.parse(text(writes[0].body.properties.Observation));
    assert.equal(previous.phase, state === 'COMPLETE' ? 'live' : 'rollout');
    assert.equal(previous.verification.phasedReleaseState, state);
    assert.equal(previous.releasedAt, firstSeen);
  }
});

test('a rechecked live release can become withdrawn without erasing original release identity or time', async () => {
  const previous = await releasedObservation();
  const { api, writes } = monitorFixture([{ m: current, observation: previous }]);
  const result = await monitor(monitorConfig, api, fixture({ state: 'REMOVED_FROM_SALE' }), now);
  assert.equal(result.errors.length, 0);
  const withdrawn = JSON.parse(text(writes[0].body.properties.Observation));
  assert.equal(withdrawn.phase, 'withdrawn');
  assert.equal(withdrawn.verification.state, 'REMOVED_FROM_SALE');
  assert.equal(withdrawn.verification.checkedAt, now());
  assert.equal(withdrawn.verification.phasedReleaseState, undefined);
  assert.equal(withdrawn.releasedAt, firstSeen);
  assert.equal(writes[0].body.properties['Released At'].date.start, firstSeen);
});

test('initial withdrawal or non-downloadable evidence records only a check time, never a release time', async () => {
  for (const options of [{ state: 'REMOVED_FROM_SALE' }, { attributes: { downloadable: false } }]) {
    for (const observation of [undefined, { phase: 'uploaded', releasedAt: firstSeen }]) {
      const { api, writes } = monitorFixture([{ m: current, observation }]);
      const result = await monitor(monitorConfig, api, fixture(options), now);
      assert.equal(result.errors.length, 0);
      const properties = writes[0].body.properties;
      const withdrawn = JSON.parse(text(properties.Observation));
      assert.equal(withdrawn.phase, 'withdrawn');
      assert.equal(withdrawn.releasedAt, undefined);
      assert.equal(withdrawn.verification.checkedAt, now());
      assert.equal(properties['Observed At'].date.start, now());
      assert.equal(properties['Released At'], undefined);
    }
  }
});

for (const phase of ['live', 'rollout']) {
  for (const failure of ['http-error', 'missing-version', 'non-live', 'wrong-build']) {
    test(`failed ${failure} recheck of ${phase} records a blocking error and preserves old raw evidence`, async () => {
      const previous = await releasedObservation(phase);
      const { api, writes } = monitorFixture([{ m: current, observation: previous }]);
      const apple = fixture({ ...(failure === 'http-error' ? { relationship: new Error('HTTP 403') } : {}), ...(failure === 'non-live' ? { state: 'WAITING_FOR_REVIEW' } : {}), ...(failure === 'wrong-build' ? { build: '124' } : {}) });
      if (failure === 'missing-version') { const get = apple.get; apple.get = async path => path === '/apps/app/appStoreVersions' ? { data: [] } : get(path); }
      const result = await monitor(monitorConfig, api, apple, now);
      assert.equal(result.observed, 0);
      assert.equal(result.errors.length, 1);
      assert.equal(writes.length, 1);
      const properties = writes[0].body.properties;
      const failed = JSON.parse(text(properties.Observation));
      assert.deepEqual(failed.verification, previous.verification);
      assert.equal(failed.verification.checkedAt, firstSeen);
      assert.equal(failed.phase, previous.phase);
      assert.equal(failed.releasedAt, firstSeen);
      assert.ok(failed.verificationError);
      assert.equal(failed.verificationStatus, 'error');
      assert.equal(text(properties.Error), failed.verificationError);
      assert.equal(failed.verificationAttempt.at, now());
      assert.equal(properties['Released At'], undefined);
    });
  }
}

test('successful recheck clears its own error and saves a recovery receipt', async () => {
  const previous = { ...await releasedObservation(), verificationError: 'HTTP 403', verificationAttempt: { at: firstSeen } };
  const { api, writes } = monitorFixture([{ m: current, observation: previous, properties: { Error: rich('HTTP 403'), 'Operations Receipt': rich(JSON.stringify({ notification: 'already reported' })) } }]);
  const result = await monitor(monitorConfig, api, fixture(), now);
  assert.equal(result.errors.length, 0);
  const properties = writes[0].body.properties;
  const recovered = JSON.parse(text(properties.Observation));
  assert.equal(recovered.verificationError, undefined);
  assert.equal(recovered.verificationAttempt, undefined);
  assert.equal(recovered.verification.checkedAt, now());
  assert.equal(text(properties.Error), '');
  const receipt = JSON.parse(text(properties['Operations Receipt']));
  assert.equal(receipt.notification, 'already reported');
  assert.equal(receipt.resolutions[0].error, 'HTTP 403');
});

test('a successful store refresh preserves unrelated delivery errors', async () => {
  const previous = { ...await releasedObservation(), verificationError: 'HTTP 403' };
  const { api, writes } = monitorFixture([{ m: current, observation: previous, properties: { Error: rich('Uncertain Slack delivery') } }]);
  await monitor(monitorConfig, api, fixture(), now);
  assert.equal(writes[0].body.properties.Error, undefined);
  assert.equal(JSON.parse(text(writes[0].body.properties.Observation)).verificationError, undefined);
});

test('a failed store refresh blocks eligibility while preserving an unrelated delivery error', async () => {
  const { api, writes } = monitorFixture([{ m: current, observation: await releasedObservation(), properties: { Error: rich('Uncertain Slack delivery') } }]);
  await monitor(monitorConfig, api, fixture({ relationship: new Error('HTTP 403') }), now);
  assert.equal(writes[0].body.properties.Error, undefined);
  assert.equal(JSON.parse(text(writes[0].body.properties.Observation)).verificationError, 'HTTP 403');
});

test('first observed distribution time does not inherit a TestFlight upload timestamp', async () => {
  const { api, writes } = monitorFixture([{ m: current, observation: { phase: 'uploaded', releasedAt: firstSeen } }]);
  await monitor(monitorConfig, api, fixture(), now);
  assert.equal(JSON.parse(text(writes[0].body.properties.Observation)).releasedAt, now());
  assert.equal(writes[0].body.properties['Released At'].date.start, now());
});

test('failed dry-run recheck reports the hold without writing a diagnostic', async () => {
  const { api, writes } = monitorFixture([{ m: current, observation: await releasedObservation() }]);
  const result = await monitor({ ...monitorConfig, dryRun: true }, api, fixture({ relationship: new Error('HTTP 403') }), now);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(writes, []);
});

test('failure to persist the blocking diagnostic remains visible alongside the original error', async () => {
  const { api } = monitorFixture([{ m: current, observation: await releasedObservation() }]);
  const notion = api.notion;
  api.notion = async (path, method, body) => { if (method === 'PATCH') throw new Error('Notion unavailable'); return notion(path, method, body); };
  const result = await monitor(monitorConfig, api, fixture({ relationship: new Error('HTTP 403') }), now);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /HTTP 403/);
  assert.match(result.errors[1], /could not persist verification error: Notion unavailable/);
});

test('ordinary supersession holds new publication and preserves frozen delivery history and comparison baseline', async () => {
  const previous = await releasedObservation();
  const { api, writes } = monitorFixture([{ m: current, observation: previous, properties: { Error: rich('Uncertain Slack delivery'), 'Released At': { date: { start: firstSeen } } } }]);
  const apple = fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } });
  const result = await monitor(monitorConfig, api, apple, now);
  assert.deepEqual(result, { checked: 1, observed: 1, skippedHistorical: 0, errors: [] });
  const properties = writes[0].body.properties;
  const terminal = JSON.parse(text(properties.Observation));
  assert.equal(terminal.phase, previous.phase);
  assert.equal(terminal.releasedAt, firstSeen);
  assert.deepEqual(terminal.verification, previous.verification);
  assert.match(terminal.verificationError, /replaced by a newer version/);
  assert.equal(terminal.verificationStatus, 'superseded');
  assert.equal(terminal.verificationAttempt.at, terminal.superseded.checkedAt);
  assert.equal(terminal.superseded.state, 'REPLACED_WITH_NEW_VERSION');
  assert.equal(terminal.superseded.checkedAt, now());
  assert.equal(terminal.superseded.manifestHash, hash(current));
  assert.equal(terminal.superseded.appStoreVersionId, 'version');
  assert.equal(terminal.superseded.version, '1.2.3');
  assert.equal(terminal.superseded.build, current.build);
  assert.equal(terminal.superseded.commit, current.commit);
  assert.equal(properties['Released At'], undefined);
  assert.equal(properties.Error, undefined);
  assert.equal(deployedBaseline({ properties: { Manifest: rich(JSON.stringify(current)), 'Manifest Hash': rich(hash(current)), Observation: properties.Observation } }), true);

  const repeated = monitorFixture([{ m: current, observation: terminal }]);
  const noRequests = { findAppByBundleId: async () => { throw new Error('Terminal supersession must not be queried again'); } };
  const retry = await monitor(monitorConfig, repeated.api, noRequests, now);
  assert.deepEqual(retry, { checked: 1, observed: 0, skippedHistorical: 0, errors: [] });
  assert.deepEqual(repeated.writes, []);
});

test('supersession before any successful distribution proof cannot manufacture historical live evidence', async () => {
  const { api, writes } = monitorFixture([{ m: current }]);
  const result = await monitor(monitorConfig, api, fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  assert.equal(result.errors.length, 0);
  const terminal = JSON.parse(text(writes[0].body.properties.Observation));
  assert.equal(terminal.phase, 'uploaded');
  assert.equal(terminal.verification, undefined);
  assert.ok(terminal.verificationError);
  assert.equal(terminal.superseded.state, 'REPLACED_WITH_NEW_VERSION');
});

test('only exact identity-bound supersession is terminal; mismatches recheck and clear a resolved hold', async () => {
  const initial = monitorFixture([{ m: current, observation: await releasedObservation() }]);
  await monitor(monitorConfig, initial.api, fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  const terminal = JSON.parse(text(initial.writes[0].body.properties.Observation));
  for (const change of [{ manifestHash: 'different' }, { commit: 'b'.repeat(40) }, { build: '124' }, { version: '1.2.4' }, { bundleId: 'other' }, { appStoreVersionId: '' }, { appStoreVersionId: 'different' }, { checkedAt: 'invalid' }]) {
    const previous = { ...terminal, superseded: { ...terminal.superseded, ...change } };
    const { api, writes } = monitorFixture([{ m: current, observation: previous, properties: { Error: rich('Uncertain Slack delivery') } }]);
    const result = await monitor(monitorConfig, api, fixture(), now);
    assert.equal(result.observed, 1);
    assert.equal(result.errors.length, 0);
    const fresh = JSON.parse(text(writes[0].body.properties.Observation));
    assert.equal(fresh.superseded, undefined);
    assert.equal(fresh.verificationError, undefined);
    assert.equal(fresh.verification.checkedAt, now());
    assert.equal(fresh.releasedAt, firstSeen);
    assert.equal(writes[0].body.properties.Error, undefined);
  }
});

test('successful supersession check resolves a prior lookup failure while retaining its recovery receipt', async () => {
  const previous = { ...await releasedObservation(), verificationError: 'HTTP 403' };
  const { api, writes } = monitorFixture([{ m: current, observation: previous, properties: { Error: rich('HTTP 403') } }]);
  const result = await monitor(monitorConfig, api, fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  assert.equal(result.errors.length, 0);
  const properties = writes[0].body.properties;
  const terminal = JSON.parse(text(properties.Observation));
  assert.equal(text(properties.Error), '');
  assert.match(terminal.verificationError, /replaced by a newer version/);
  assert.deepEqual(terminal.verification, previous.verification);
  assert.equal(JSON.parse(text(properties['Operations Receipt'])).resolutions[0].error, 'HTTP 403');
});

test('superseded build mismatches remain actual errors and do not establish a terminal marker', async () => {
  const { api, writes } = monitorFixture([{ m: current, observation: await releasedObservation() }]);
  const result = await monitor(monitorConfig, api, fixture({ build: '124', attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  assert.equal(result.errors.length, 1);
  const failed = JSON.parse(text(writes[0].body.properties.Observation));
  assert.equal(failed.superseded, undefined);
  assert.match(failed.verificationError, /build differs/);
});

test('legacy, error-status and attempt-mismatched supersession markers recheck rather than silence verification', async () => {
  const initial = monitorFixture([{ m: current, observation: await releasedObservation() }]);
  await monitor(monitorConfig, initial.api, fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  const terminal = JSON.parse(text(initial.writes[0].body.properties.Observation));
  for (const change of [{ verificationStatus: undefined }, { verificationStatus: 'error' }, { verificationAttempt: { at: firstSeen } }]) {
    const { api, writes } = monitorFixture([{ m: current, observation: { ...terminal, ...change } }]);
    const result = await monitor(monitorConfig, api, fixture(), now);
    assert.equal(result.observed, 1);
    assert.equal(result.errors.length, 0);
    const fresh = JSON.parse(text(writes[0].body.properties.Observation));
    assert.equal(fresh.superseded, undefined);
    assert.equal(fresh.verificationStatus, undefined);
    assert.equal(fresh.verificationError, undefined);
  }
});

test('a genuine lookup failure with retained supersession proof is typed as error', async () => {
  const initial = monitorFixture([{ m: current, observation: await releasedObservation() }]);
  await monitor(monitorConfig, initial.api, fixture({ attributes: { appVersionState: 'REPLACED_WITH_NEW_VERSION' } }), now);
  const terminal = JSON.parse(text(initial.writes[0].body.properties.Observation));
  const { api, writes } = monitorFixture([{ m: current, observation: { ...terminal, verificationStatus: 'error' } }]);
  const result = await monitor(monitorConfig, api, fixture({ relationship: new Error('HTTP 503') }), now);
  assert.equal(result.errors.length, 1);
  const failed = JSON.parse(text(writes[0].body.properties.Observation));
  assert.deepEqual(failed.superseded, terminal.superseded);
  assert.equal(failed.verificationStatus, 'error');
  assert.equal(failed.verificationError, 'HTTP 503');
});
