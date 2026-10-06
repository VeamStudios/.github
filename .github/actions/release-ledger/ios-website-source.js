// Read-only selection for website PRs. Storefront caches and GitHub release
// events are wake-ups, never proof of the currently downloadable source build.
const fs = require('node:fs');
const { clients, allPages, text, hash } = require('./record');
const { releaseSchema, targetFilter } = require('./presentation');
const { observeStore } = require('./monitor-store');
const { AppStoreConnectClient } = require('./app-store-client');

const BUNDLES = { 'VeamStudios/ChecklistInspectorPro-iOS': 'com.veamstudios.checklistinspectorpro', 'VeamStudios/SiteAuditPro-iOS': 'com.veamstudios.iaudit' };
function versionParts(version) {
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw Error('Exact marketing version required');
  const parts = version.replace(/^v/, '').split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw Error('Invalid marketing version');
  return parts;
}
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function publicObservation(o, m, bundle, now) {
  const v = o?.verification, checked = Date.parse(v?.checkedAt || '');
  return Boolean(o && ['live', 'rollout'].includes(o.phase) && !o.verificationError &&
    v?.kind === 'app-store' && v.platform === 'IOS' && v.downloadable === true &&
    v.version === m.version.replace(/^v/, '') && v.build === m.build && v.commit === m.commit && v.bundleId === bundle &&
    v.appStoreVersionId && v.evidence === `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${v.appStoreVersionId}/build` &&
    ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(v.state) && Number.isFinite(checked) && checked <= now + 60000 && now - checked <= 2 * 60 * 60 * 1000 &&
    (o.phase === 'rollout' ? v.phasedReleaseState === 'ACTIVE' : ['COMPLETE', 'NONE'].includes(v.phasedReleaseState)));
}
// One operator-attested legacy release can remain historically suppressed while
// supplying website notes. Imported baselines and other historical rows stay excluded.
function auditedHistoricalSource(m) {
  const r=m.recovery,a=r?.buildSourceAttestation,b=r?.baselineEquivalence;
  return Boolean(m.repository==='VeamStudios/SiteAuditPro-iOS' && m.target==='ios-consumer' &&
    m.version==='v10.7.3' && m.build==='1' && m.commit==='131138291db97d6e42e2d6deb03b00efb834f490' &&
    m.provenanceComplete===true && r?.kind==='audited-historical-release-recovery' &&
    a?.operator==='harrygt' && a.sourcePr===2586 && a.commit===m.commit && a.build===m.build && a.version===m.version &&
    a.buildId==='a4fc9694-2155-4bed-b5e7-dcc7499e7cb6' && a.appStoreVersionId==='db645b65-b744-4e45-bc2f-5f5e7f661b6f' &&
    b?.recordedCommit==='5a940d890e4d3dc7ca753efcb6e76ec911f294ad' &&
    b.comparisonCommit===m.baseline && m.baseline==='d15b0dcd727a6ce4c7e3bdaf0c1f9e1d61c681ea' &&
    b.identicalTree==='05ad1c53c442054b7a1762807401db147274ae05' &&
    b.recordedManifestHash==='fa33210fe37de3668716c971005dc8f15750e36c4c82390c07c9633202db9abd' &&
    r.originalAnnouncement?.permalink==='https://veamstudios.slack.com/archives/C2CK0TA0K/p1790237712608319');
}
async function selectSource(config, api, apple, now = () => new Date().toISOString()) {
  const bundle = BUNDLES[config.repo];
  if (!bundle || config.bundleId !== bundle) throw Error('Unsupported iOS website source identity');
  const schema = await releaseSchema(api.notion, config.releasesId);
  const rows = await allPages(api.notion, `/data_sources/${config.releasesId}/query`, { filter: { and: [{ property: 'Repository', rich_text: { equals: config.repo } }, targetFilter(schema, 'ios-consumer')] } });
  const candidates = [];
  for (const row of rows) {
    const m = JSON.parse(text(row.properties.Manifest));
    if (m.repository !== config.repo || m.target !== 'ios-consumer' || hash(m) !== text(row.properties['Manifest Hash'])) throw Error('Frozen iOS source identity/hash mismatch');
    const recovered=Boolean(row.properties.Historical?.checkbox && auditedHistoricalSource(m));
    if ((row.properties.Historical?.checkbox && !recovered) || m.event !== 'release' || !m.build) continue;
    if (m.schemaVersion !== 2 || !/^[a-f0-9]{40}$/.test(m.commit) || m.key !== `${m.repository}/${m.target}/release/${m.version}`) throw Error('Invalid frozen iOS release source');
    versionParts(m.version);
    // Refresh exact ASC evidence now; an old positive observation cannot confer
    // authority after a failed lookup, supersession, hold or withdrawal.
    const observation = await observeStore(m, bundle, apple, now);
    if (!publicObservation(observation, m, bundle, Date.parse(now()))) continue;
    if(recovered) {
      if(observation.verification.appStoreVersionId!==m.recovery.buildSourceAttestation.appStoreVersionId)throw Error('Recovered ASC version identity differs from attested release');
      const build=await apple.get(`/appStoreVersions/${observation.verification.appStoreVersionId}/build`);
      if(build.data?.id!==m.recovery.buildSourceAttestation.buildId)throw Error('Recovered ASC build identity differs from attested upload');
    }
    candidates.push({ live_version: m.version.replace(/^v/, ''), source_commit: m.commit, build: m.build, release_page: row.url || `https://www.notion.so/${row.id.replaceAll('-', '')}`, manifest_hash: hash(m), verification: observation.verification });
  }
  candidates.sort((a, b) => compareVersions(b.live_version, a.live_version));
  if (!candidates.length) throw Error('No exact publicly downloadable frozen iOS release; existing website notes are preserved');
  if (candidates.length > 1 && compareVersions(candidates[0].live_version, candidates[1].live_version) === 0) throw Error('Ambiguous public iOS release source');
  return candidates[0];
}
async function main() {
  const config = { repo: process.env.GITHUB_REPOSITORY, bundleId: process.env.INPUT_BUNDLE_ID, releasesId: process.env.INPUT_RELEASES_ID, notionToken: process.env.NOTION_TOKEN, githubToken: process.env.GITHUB_TOKEN };
  if (!config.notionToken || !config.releasesId) throw Error('Notion release source configuration missing');
  const apple = new AppStoreConnectClient({ keyId: process.env.APP_STORE_CONNECT_API_KEY_ID, issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID, privateKey: process.env.APP_STORE_CONNECT_API_KEY_CONTENT });
  const source = await selectSource(config, clients(config), apple);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({ ref: source.source_commit, live_version: source.live_version, release_page: source.release_page, manifest_hash: source.manifest_hash, evidence: source.verification.evidence, checked_at: source.verification.checkedAt }).map(([k, v]) => `${k}=${v}\n`).join(''));
  console.log(JSON.stringify(source));
}
module.exports = { selectSource, publicObservation, compareVersions, auditedHistoricalSource };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
