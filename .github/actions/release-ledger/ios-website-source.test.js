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

function sapRecovery() {
 const manifest={schemaVersion:2,repository:'VeamStudios/SiteAuditPro-iOS',target:'ios-consumer',event:'release',version:'v10.7.3',build:'1',commit:'131138291db97d6e42e2d6deb03b00efb834f490',baseline:'d15b0dcd727a6ce4c7e3bdaf0c1f9e1d61c681ea',key:'VeamStudios/SiteAuditPro-iOS/ios-consumer/release/v10.7.3',provenanceComplete:true,recovery:{kind:'audited-historical-release-recovery',buildSourceAttestation:{operator:'harrygt',sourcePr:2586,version:'v10.7.3',build:'1',commit:'131138291db97d6e42e2d6deb03b00efb834f490',buildId:'a4fc9694-2155-4bed-b5e7-dcc7499e7cb6',appStoreVersionId:'db645b65-b744-4e45-bc2f-5f5e7f661b6f'},baselineEquivalence:{recordedCommit:'5a940d890e4d3dc7ca753efcb6e76ec911f294ad',comparisonCommit:'d15b0dcd727a6ce4c7e3bdaf0c1f9e1d61c681ea',identicalTree:'05ad1c53c442054b7a1762807401db147274ae05',recordedManifestHash:'fa33210fe37de3668716c971005dc8f15750e36c4c82390c07c9633202db9abd'},originalAnnouncement:{permalink:'https://veamstudios.slack.com/archives/C2CK0TA0K/p1790237712608319'}}};
 return {id:'recovery',properties:{Historical:{checkbox:true},Manifest:rich(JSON.stringify(manifest)),'Manifest Hash':rich(hash(manifest))}};
}
const sapConfig={repo:'VeamStudios/SiteAuditPro-iOS',bundleId:'com.veamstudios.iaudit',releasesId:'db'};
function sapApple({phase='COMPLETE',buildId='a4fc9694-2155-4bed-b5e7-dcc7499e7cb6'}={}) {
 const base=apple({phase,build:'1'});
 return {findAppByBundleId:async()=>({id:'430234732',attributes:{bundleId:sapConfig.bundleId}}),get:async(path,params)=>{
  if(path.endsWith('/build'))return {data:{id:buildId,type:'builds',attributes:{version:'1'}}};
  const result=await base.get(path,params);
  if(params)result.data[0].id='db645b65-b744-4e45-bc2f-5f5e7f661b6f';
  return result;
 }};
}
test('attested SAP10.7.3 historical recovery supplies exact fresh source without changing suppression',async()=>{
 const saved=sapRecovery(),before=JSON.stringify(saved);
 const result=await selectSource(sapConfig,api([saved]),sapApple(),()=>now);
 assert.equal(result.live_version,'10.7.3');assert.equal(result.source_commit,'131138291db97d6e42e2d6deb03b00efb834f490');assert.equal(JSON.stringify(saved),before);
});
test('historical recovery needs the complete exact attestation and audited baseline',async()=>{
 for(const mutate of [m=>delete m.recovery,m=>m.provenanceComplete=false,m=>m.recovery.buildSourceAttestation.commit='b'.repeat(40),m=>m.recovery.baselineEquivalence.identicalTree='c'.repeat(40),m=>m.recovery.originalAnnouncement.permalink='https://example.com']) {
  const saved=sapRecovery(),m=JSON.parse(saved.properties.Manifest.rich_text[0].text.content);mutate(m);saved.properties.Manifest=rich(JSON.stringify(m));saved.properties['Manifest Hash']=rich(hash(m));
  await assert.rejects(selectSource(sapConfig,api([saved]),sapApple(),()=>now),/No exact publicly/);
 }
});
test('recovered history cannot override fresh rollout holds or related build mismatch',async()=>{
 await assert.rejects(selectSource(sapConfig,api([sapRecovery()]),sapApple({phase:'PAUSED'}),()=>now),/No exact publicly/);
 await assert.rejects(selectSource(sapConfig,api([sapRecovery()]),sapApple({buildId:'different'}),()=>now),/build identity differs/);
});
