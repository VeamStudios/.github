const { releaseSchema, targetFilter } = require('./presentation');
const { AppStoreConnectClient, normalizeVersion } = require('./app-store-client.js');
const { clients, allPages, text, rich, hash, verificationProperties } = require('./record.js');
const { ownedOnly, OWNERS, effectiveObservation, previousObservation } = require('./ledger-columns');

const DISTRIBUTION_STATES = ['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'];
const WITHDRAWN_STATES = ['DEVELOPER_REMOVED_FROM_SALE', 'REMOVED_FROM_SALE'];
const SUPERSEDED_STATE = 'REPLACED_WITH_NEW_VERSION';
const SUPERSEDED_HOLD = 'App Store version was replaced by a newer version; historical delivery evidence is retained';
function presentFields(attributes, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(attributes, key)).map(key => [key, attributes[key]]));
}
function matchingSupersession(previous, manifest, bundleId) {
  const s = previous?.superseded;
  return previous?.verificationStatus === 'superseded' && s?.state === SUPERSEDED_STATE && s.manifestHash === hash(manifest) &&
    s.version === normalizeVersion(manifest.version).split('-')[0] && s.build === manifest.build && s.commit === manifest.commit &&
    s.bundleId === bundleId && typeof s.appStoreVersionId === 'string' && Boolean(s.appStoreVersionId.trim()) &&
    (!previous.verification?.appStoreVersionId || s.appStoreVersionId === previous.verification.appStoreVersionId) &&
    Number.isFinite(Date.parse(s.checkedAt)) && previous.verificationAttempt?.at === s.checkedAt && Boolean(previous.verificationError);
}

async function observeStore(manifest, bundleId, apple, now = () => new Date().toISOString()) {
  const app = await apple.findAppByBundleId(bundleId);
  if (!app || app.attributes?.bundleId !== bundleId) throw new Error('App Store bundle identity not verified');
  // Exact filtered version + platform, then its related build. Never infer a build from the latest upload.
  const versionString = normalizeVersion(manifest.version).split('-')[0];
  const result = await apple.get(`/apps/${app.id}/appStoreVersions`, { 'filter[versionString]': versionString, 'filter[platform]': 'IOS', limit: 200 });
  if (!Array.isArray(result?.data)) throw new Error('App Store version evidence is malformed');
  const versions = result.data.filter(v => v.attributes?.versionString === versionString && v.attributes?.platform === 'IOS');
  if (result.links?.next || versions.length > 1) throw new Error('App Store version is ambiguous');
  // An uploaded TestFlight build can precede creation of its store version.
  // A successful, explicitly empty query means waiting, never live evidence.
  if (!versions.length && !result.data.length) return null;
  if (!versions.length) throw new Error('App Store version evidence does not match the requested version/platform');
  const version = versions[0];
  if (typeof version.id !== 'string' || !version.id.trim()) throw new Error('App Store version identity is missing');
  // Prefer Apple's current state field; retain both raw fields for auditing.
  const state = version.attributes.appVersionState ?? version.attributes.appStoreState;
  if (typeof state !== 'string' || !state) throw new Error('App Store version state is missing');
  if (!DISTRIBUTION_STATES.includes(state) && !WITHDRAWN_STATES.includes(state) && state !== SUPERSEDED_STATE) return null;
  const build = await apple.get(`/appStoreVersions/${version.id}/build`);
  if (String(build.data?.attributes?.version) !== manifest.build) throw new Error('App Store build differs from recorded shipped build');
  const verification = {
    kind: 'app-store', version: versionString, platform: 'IOS', build: manifest.build, commit: manifest.commit,
    bundleId, appId: app.id, appStoreVersionId: version.id, state,
    ...presentFields(version.attributes, ['appStoreState', 'appVersionState', 'downloadable']),
    evidence: `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${version.id}/build`,
  };
  const source = `https://appstoreconnect.apple.com/apps/${app.id}/distribution/ios/version/inflight`;
  if (state === SUPERSEDED_STATE) {
    const observedAt = now();
    return { phase: 'superseded', source, verification: { ...verification, checkedAt: observedAt } };
  }
  // A confirmed withdrawal/non-downloadable version is fresh negative evidence,
  // not a failed lookup or an invented completed phased release.
  if (WITHDRAWN_STATES.includes(state) || version.attributes.downloadable === false) {
    const observedAt = now();
    return { phase: 'withdrawn', source, verification: { ...verification, checkedAt: observedAt } };
  }
  // The related resource can return 404 when no phased release exists. Only an
  // explicit null relationship proves absence; failed lookups remain errors.
  const relationship = await apple.get(`/appStoreVersions/${version.id}/relationships/appStoreVersionPhasedRelease`);
  let limited = false;
  if (relationship?.data === null) {
    // NONE is our explicit absence marker, never an Apple phased state inferred from HTTP 404.
    verification.phasedReleaseState = 'NONE';
    verification.phasedReleaseId = null;
    verification.phasedReleaseEvidence = `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${version.id}/relationships/appStoreVersionPhasedRelease`;
  } else {
    const linked = relationship?.data;
    if (linked?.type !== 'appStoreVersionPhasedReleases' || typeof linked.id !== 'string' || !linked.id.trim()) {
      throw new Error('App Store phased-release relationship is missing or malformed');
    }
    const phased = await apple.get(`/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
    const phasedState = phased?.data?.attributes?.phasedReleaseState;
    if (phased?.data?.id !== linked.id || phased.data.type !== linked.type || typeof phasedState !== 'string' || !phasedState.trim()) {
      throw new Error('App Store phased-release evidence is missing or inconsistent');
    }
    limited = phasedState !== 'COMPLETE';
    Object.assign(verification, presentFields(phased.data.attributes, ['phasedReleaseState', 'currentDayNumber', 'totalPauseDuration', 'startDate']), {
      phasedReleaseId: linked.id,
      phasedReleaseEvidence: `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`,
    });
  }
  const observedAt = now();
  // ASC createdDate is not the actual release time. Record first observed live time explicitly.
  return { phase: limited ? 'rollout' : 'live', source, releasedAt: observedAt, timeBasis: 'first-observed', verification: { ...verification, checkedAt: observedAt } };
}
// Without the shared lock, an overlapping run that checked earlier must not
// overwrite evidence a newer check has already written.
async function writeIfNewest(api, row, properties, checkedAt) {
  const current = await api.notion(`/pages/${row.id}`);
  // A malformed column is not newer evidence; never report it as a store failure.
  let latest; try { latest = JSON.parse(text(current?.properties?.[OWNERS.store.observation]) || 'null'); } catch { latest = null; }
  if (latest && Date.parse(latest.recordedAt) > Date.parse(checkedAt)) return false;
  await api.notion(`/pages/${row.id}`, 'PATCH', { properties });
  return true;
}
async function monitor(config, api, apple, now = () => new Date().toISOString()) {
  const schema = await releaseSchema(api.notion, config.releasesId);
  const rows = await allPages(api.notion, `/data_sources/${config.releasesId}/query`, { filter: { and: [{ property: 'Repository', rich_text: { equals: config.repo } }, targetFilter(schema, config.target)] } });
  const errors = []; let observed = 0; let skippedHistorical = 0;
  for (const row of rows) {
    let previous; let validRecord = false;
    try {
      const m = JSON.parse(text(row.properties.Manifest));
      if (m.target !== config.target || m.repository !== config.repo || hash(m) !== text(row.properties['Manifest Hash'])) { errors.push(`${row.id}: invalid manifest`); continue; }
      // Imported history deliberately has no verified build. Preserve it as
      // Unverified; it is not a pending upload for the store monitor to resolve.
      // Keep integrity checks above this exception and validate current releases.
      if (!m.build && m.event === 'baseline' && row.properties.Historical?.checkbox === true) { skippedHistorical++; continue; }
      if (!m.build) { errors.push(`${row.id}: invalid manifest`); continue; }
      previous = previousObservation(row.properties);
      validRecord = true;
      if (previous?.phase === 'withdrawn' || matchingSupersession(previous, m, config.bundleId)) continue;
      // Refresh released rows too: live is an observation, not a permanent exemption.
      const observation = await observeStore(m, config.bundleId, apple, now);
      if (!observation) {
        if (['live', 'rollout'].includes(previous?.phase)) throw new Error('App Store no longer confirms distribution for the recorded version/build');
        continue;
      }
      const observedAt = observation.verification.checkedAt;
      if (observation.phase === 'superseded') {
        // Supersession is expected terminal negative evidence, not an API error
        // or a withdrawal of the frozen historical delivery/baseline proof.
        observed++;
        const terminal = { ...previous, phase: previous?.phase || 'uploaded', superseded: { ...observation.verification, manifestHash: hash(m) }, verificationStatus: 'superseded', verificationError: SUPERSEDED_HOLD, verificationAttempt: { source: observation.source, at: observedAt } };
        if (!config.dryRun) {
          const properties = verificationProperties({ phase: terminal.phase, source: observation.source, verification: observation.verification }, previous, row.properties, observedAt);
          Object.assign(properties, { Observation: rich(JSON.stringify(terminal)), 'Observed At': { date: { start: observedAt } } });
          await writeIfNewest(api, row, { ...ownedOnly('store', properties, observedAt, row.properties), [OWNERS.store.error]: rich('') }, observedAt);
        }
        continue;
      }
      if (['live', 'rollout', 'withdrawn'].includes(previous?.phase)) observation.releasedAt = previous.releasedAt || effectiveObservation(row.properties)?.releasedAt || row.properties['Released At']?.date?.start || observation.releasedAt;
      observed++;
      if (!config.dryRun) {
        const properties = verificationProperties(observation, previous, row.properties, observedAt);
        properties.Observation = rich(JSON.stringify({ ...previous, ...observation, releasedAt: observation.releasedAt, superseded: undefined, verificationStatus: undefined, verificationError: undefined, verificationAttempt: undefined }));
        Object.assign(properties, { 'Observed At': { date: { start: observedAt } }, 'Availability Evidence': { url: observation.verification.evidence } });
        if (observation.releasedAt) properties['Released At'] = { date: { start: observation.releasedAt } };
        await writeIfNewest(api, row, { ...ownedOnly('store', properties, observedAt, row.properties), [OWNERS.store.error]: rich('') }, observedAt);
      }
    } catch (e) {
      errors.push(`${row.id}: ${e.message}`);
      // Retain the last raw proof and its old checkedAt for diagnostics. A failed
      // current check must explicitly block eligibility, even before it goes stale.
      if (validRecord && !config.dryRun) {
        const attemptedAt = now();
        const observation = { ...previous, phase: previous?.phase || 'uploaded', verificationStatus: 'error', verificationError: e.message, verificationAttempt: { source: previous?.source || '', at: attemptedAt } };
        try {
          const properties = { Observation: rich(JSON.stringify(observation)), 'Observed At': { date: { start: attemptedAt } } };
          if (!text(row.properties.Error) || text(row.properties.Error) === previous?.verificationError) properties.Error = rich(e.message);
          // The owned error always reflects this check, even when the shared Error holds another writer's message.
          await writeIfNewest(api, row, { ...ownedOnly('store', properties, attemptedAt, row.properties), [OWNERS.store.error]: rich(e.message) }, attemptedAt);
        } catch (writeError) { errors.push(`${row.id}: could not persist verification error: ${writeError.message}`); }
      }
    }
  }
  return { checked: rows.length, observed, skippedHistorical, errors };
}
async function main() {
  const config = { repo: process.env.GITHUB_REPOSITORY, target: process.env.INPUT_TARGET, bundleId: process.env.INPUT_BUNDLE_ID, releasesId: process.env.INPUT_RELEASES_ID, githubToken: process.env.INPUT_GITHUB_TOKEN, notionToken: process.env.INPUT_NOTION_TOKEN, dryRun: process.env.INPUT_DRY_RUN === 'true' };
  for (const [key, value] of Object.entries(config)) if (key !== 'dryRun' && !value) throw new Error(`Missing ${key}`);
  const apple = new AppStoreConnectClient({ keyId: process.env.APP_STORE_CONNECT_API_KEY_ID, issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID, privateKey: process.env.APP_STORE_CONNECT_API_KEY_CONTENT });
  const api = clients(config);
  // Owned columns replace the shared lock: no other writer sends these properties.
  const result = await monitor(config, api, apple);
  console.log(JSON.stringify(result));
  if (result.errors.length) throw new Error('App Store evidence requires attention; no availability was inferred for failed records');
}
module.exports = { observeStore, monitor };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
