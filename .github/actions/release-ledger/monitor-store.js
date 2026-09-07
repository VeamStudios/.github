const { AppStoreConnectClient, normalizeVersion } = require('../ios-app-store-live-monitor/monitor.js');
const { clients, allPages, withLock, text, rich, hash } = require('./record.js');

async function observeStore(manifest, bundleId, apple, now = () => new Date().toISOString()) {
  const app = await apple.findAppByBundleId(bundleId);
  if (!app || app.attributes?.bundleId !== bundleId) throw new Error('App Store bundle identity not verified');
  // Exact filtered version + platform, then its related build. Never infer a build from the latest upload.
  const versionString = normalizeVersion(manifest.version).split('-')[0];
  const result = await apple.get(`/apps/${app.id}/appStoreVersions`, { 'filter[versionString]': versionString, 'filter[platform]': 'IOS', limit: 200 });
  const versions = (result.data || []).filter(v => v.attributes?.versionString === versionString && v.attributes?.platform === 'IOS');
  if (result.links?.next || versions.length !== 1) throw new Error('App Store version is missing or ambiguous');
  const version = versions[0];
  const build = await apple.get(`/appStoreVersions/${version.id}/build`);
  if (String(build.data?.attributes?.version) !== manifest.build) throw new Error('App Store build differs from recorded shipped build');
  const state = version.attributes.appStoreState || version.attributes.appVersionState;
  if (!['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'].includes(state)) return null;
  const phased = await apple.get(`/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
  const limited = phased.data && phased.data.attributes?.phasedReleaseState !== 'COMPLETE';
  const observedAt = now();
  // ASC createdDate is not the actual release time. Record first observed live time explicitly.
  return { phase: limited ? 'rollout' : 'live', source: `https://appstoreconnect.apple.com/apps/${app.id}/distribution/ios/version/inflight`, releasedAt: observedAt, timeBasis: 'first-observed', verification: { kind: 'app-store', build: manifest.build, commit: manifest.commit, bundleId, appId: app.id, appStoreVersionId: version.id, state, checkedAt: observedAt, evidence: `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${version.id}/build` } };
}
async function monitor(config, api, apple) {
  const rows = await allPages(api.notion, `/data_sources/${config.releasesId}/query`, { filter: { and: [{ property: 'Repository', rich_text: { equals: config.repo } }, { property: 'Target', rich_text: { equals: config.target } }] } });
  const errors = []; let observed = 0;
  for (const row of rows) {
    const m = JSON.parse(text(row.properties.Manifest));
    if (!m.build || m.target !== config.target || m.repository !== config.repo || hash(m) !== text(row.properties['Manifest Hash'])) { errors.push(`${row.id}: invalid manifest`); continue; }
    const previous = text(row.properties.Observation) ? JSON.parse(text(row.properties.Observation)) : null;
    if (previous?.phase === 'withdrawn' || previous?.phase === 'live') continue;
    try {
      const observation = await observeStore(m, config.bundleId, apple);
      if (!observation) continue;
      observed++;
      if (!config.dryRun) await api.notion(`/pages/${row.id}`, 'PATCH', { properties: { Observation: rich(JSON.stringify(observation)), 'Observed At': { date: { start: observation.releasedAt } }, 'Released At': { date: { start: previous?.phase === observation.phase && row.properties['Released At']?.date?.start || observation.releasedAt } }, 'Availability Evidence': { url: observation.verification.evidence }, Error: rich('') } });
    } catch (e) { errors.push(`${m.key}: ${e.message}`); }
  }
  return { checked: rows.length, observed, errors };
}
async function main() {
  const config = { repo: process.env.GITHUB_REPOSITORY, target: process.env.INPUT_TARGET, bundleId: process.env.INPUT_BUNDLE_ID, releasesId: process.env.INPUT_RELEASES_ID, githubToken: process.env.INPUT_GITHUB_TOKEN, notionToken: process.env.INPUT_NOTION_TOKEN, dryRun: process.env.INPUT_DRY_RUN === 'true' };
  for (const [key, value] of Object.entries(config)) if (key !== 'dryRun' && !value) throw new Error(`Missing ${key}`);
  const apple = new AppStoreConnectClient({ keyId: process.env.APP_STORE_CONNECT_API_KEY_ID, issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID, privateKey: process.env.APP_STORE_CONNECT_API_KEY_CONTENT });
  const api = clients(config);
  const result = config.dryRun ? await monitor(config, api, apple) : await withLock(api.gh, 'VeamStudios/.github', () => monitor(config, api, apple));
  console.log(JSON.stringify(result));
  if (result.errors.length) throw new Error('App Store evidence requires attention; no availability was inferred for failed records');
}
module.exports = { observeStore, monitor };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
