// Read-only ledger lookup. Repository/target/data-source configuration must come
// from the trusted caller, never from a PR body or a PR-controlled file.
const { deployedBaseline, hash, text, allPages } = require('./record');
const { releaseSchema, targetFilter, TARGETS } = require('./presentation');
const { effectiveObservation, previousObservation, OWNERS } = require('./ledger-columns');

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$/i;
const BUNDLES = {
  'VeamStudios/SiteAuditPro-iOS/ios-consumer': 'com.veamstudios.iaudit',
  'VeamStudios/SiteAuditPro-iOS/ios-enterprise': 'com.veamstudios.iaudit.enterprise',
  'VeamStudios/ChecklistInspectorPro-iOS/ios-consumer': 'com.veamstudios.checklistinspectorpro',
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const secureUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
};

class BaselineError extends Error {
  constructor(code, message) { super(message); this.name = 'BaselineError'; this.code = code; }
}
function fail(code, message) { throw new BaselineError(code, message); }
function configuration({ api, repo, target, releasesId }) {
  if (typeof api?.notion !== 'function' || !/^VeamStudios\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !Object.hasOwn(TARGETS, target) || !UUID.test(releasesId || '')) {
    fail('configuration', 'Provide trusted repository, release target and Releases data-source configuration.');
  }
}
function parseRow(row, repo, target) {
  if (!object(row?.properties) || !UUID.test(row.id || '')) fail('invalid', 'Release baseline row identity is invalid.');
  const p = row.properties;
  const raw = text(p.Manifest);
  if (!raw || raw.length > 180000) fail('invalid', 'Release baseline manifest is missing or exceeds the supported bound.');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail('invalid', 'Release baseline manifest is malformed.'); }
  if (!object(manifest) || ![1, 2].includes(manifest.schemaVersion) || manifest.repository !== repo || manifest.target !== target ||
      !SHA.test(manifest.commit || '') || typeof manifest.version !== 'string' || !manifest.version ||
      manifest.version.length > 100 || /[\r\n]/.test(manifest.version) ||
      manifest.key !== `${repo}/${target}/${manifest.event}/${manifest.version}` || hash(manifest) !== text(p['Manifest Hash'])) {
    fail('invalid', 'Release baseline frozen identity or manifest hash does not match the trusted scope.');
  }
  // Do not accept a contradictory display identity, even though only the frozen
  // manifest supplies the returned commit and version.
  const displayedRepo = text(p.Repository), displayedCommit = text(p.Commit);
  const displayedTarget = p.Target?.select?.name ?? text(p.Target);
  if (displayedRepo !== repo || ![target, TARGETS[target]].includes(displayedTarget) ||
      (displayedCommit && displayedCommit !== manifest.commit)) fail('conflict', 'Release baseline row conflicts with its frozen identity.');
  let observation, folded;
  try {
    for (const [owner, columns] of Object.entries(OWNERS)) {
      const content = text(p[columns.observation]);
      if (!content) continue;
      if (content.length > 180000) throw Error('oversize');
      const record = JSON.parse(content);
      if (!object(record) || record.owner !== owner || !timestamp(record.recordedAt) || !object(record.observation)) throw Error('invalid owned record');
    }
    folded = effectiveObservation(p);
    observation = previousObservation(p);
    if (observation && !object(observation)) throw Error('invalid observation');
  } catch { fail('invalid', 'Release baseline owned observation is malformed; repair the ledger evidence.'); }
  const releasedAt = folded?.releasedAt || observation?.releasedAt || p['Released At']?.date?.start;
  const state = p.State?.select?.name;
  const candidate = manifest.event === 'baseline' || manifest.event === 'release' && Boolean(releasedAt ||
    ['deployed', 'live', 'rollout', 'withdrawn', 'halted'].includes(observation?.phase) ||
    ['Released', 'Available', 'Limited rollout', 'Withdrawn', 'Superseded'].includes(state));
  if (!candidate) return null; // Prepare/upload alone cannot establish shipment.
  if (!timestamp(releasedAt) || Date.parse(releasedAt) > Date.now() + 60000) fail('invalid', 'A released baseline candidate lacks a valid release time; no earlier release was substituted.');
  const observedAt = folded?.observedAt || observation?.verification?.checkedAt || observation?.baseline?.checkedAt || p['Observed At']?.date?.start;
  return { row, manifest, observation, folded, releasedAt, observedAt };
}
// Changelog immutability starts when this exact build is downloadable. A valid
// ACTIVE phased rollout has already shipped notes, even though the separate
// release-completion gates still wait for COMPLETE/NONE.
function distributedAppStore(observation, manifest) {
  const v = observation?.verification, bundle = BUNDLES[`${manifest.repository}/${manifest.target}`];
  return Boolean(v?.kind === 'app-store' && bundle && v.bundleId === bundle && v.platform === 'IOS' &&
    typeof manifest.build === 'string' && manifest.build && v.build === manifest.build &&
    v.version === manifest.version.replace(/^v/, '') && v.commit === manifest.commit && v.downloadable === true &&
    ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(v.state) &&
    (observation.phase === 'rollout' && v.phasedReleaseState === 'ACTIVE' ||
      observation.phase === 'live' && ['COMPLETE', 'NONE'].includes(v.phasedReleaseState)) &&
    UUID.test(v.appStoreVersionId || '') && timestamp(v.checkedAt) && Date.parse(v.checkedAt) <= Date.now() + 60000 &&
    v.evidence === `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${v.appStoreVersionId}/build`);
}
function verified(candidate) {
  const { row, manifest: m, observation: o, folded, observedAt } = candidate;
  const p = row.properties;
  const ownerError = folded && text(p[OWNERS[folded.owner].error]);
  if (!o || o.verificationError || o.verificationStatus === 'error' || ownerError || !timestamp(observedAt) ||
      Date.parse(observedAt) > Date.now() + 60000 || (!deployedBaseline(row) && !distributedAppStore(o, m))) {
    fail('unverified', 'Latest released baseline lacks valid distribution evidence; repair/recheck it instead of using an earlier release.');
  }
  const b = o.baseline;
  if (o.verification?.kind === 'app-store') {
    if (!distributedAppStore(o, m)) {
      fail('unverified', 'Latest iOS baseline is not bound to the exact distributed bundle, version, build and commit.');
    }
  } else if (b?.kind === 'audited-production-baseline') {
    if (!b.evidence.every(secureUrl) || Date.parse(b.checkedAt) > Date.now() + 60000) fail('unverified', 'Audited baseline evidence links or observation time are invalid.');
  } else if (!secureUrl(o.verification?.evidence)) {
    fail('unverified', 'Latest shipped baseline evidence URL is invalid.');
  }
  const pageId = row.id.replace(/-/g, '').toLowerCase().replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
  return {
    commit: m.commit,
    version: m.version,
    pageId,
    proofDigest: hash({ pageId, manifestHash: hash(m), observation: o, observedAt,
      availabilityEvidence: folded?.availabilityEvidence || p['Availability Evidence']?.url || '',
      audienceVerified: p['Audience Verified']?.checkbox === true }),
    observedAt,
  };
}
async function resolveBaseline(config) {
  configuration(config);
  const { api, repo, target, releasesId } = config;
  const schema = await releaseSchema(api.notion, releasesId);
  const queryPath = `/data_sources/${releasesId}/query`;
  let pages = 0, count = 0;
  const cursors = new Set();
  const query = async (path, method, body) => {
    if (path !== queryPath || method !== 'POST' || ++pages > 100 || body.start_cursor && cursors.has(body.start_cursor)) {
      fail('invalid', 'Release baseline pagination is invalid or exceeds the supported bound.');
    }
    if (body.start_cursor) cursors.add(body.start_cursor);
    const result = await api.notion(path, method, body);
    if (!Array.isArray(result?.results) || (count += result.results.length) > 10000 ||
        typeof result.has_more !== 'boolean' || result.has_more && (typeof result.next_cursor !== 'string' || !result.next_cursor)) {
      fail('invalid', 'Release baseline query returned incomplete or unsupported pagination.');
    }
    return result;
  };
  const rows = await allPages(query, queryPath, {
    filter: { and: [{ property: 'Repository', rich_text: { equals: repo } }, targetFilter(schema, target)] },
    sorts: [{ property: 'Released At', direction: 'descending' }],
  });
  const candidates = rows.map(row => parseRow(row, repo, target)).filter(Boolean);
  if (!candidates.length) fail('missing', `No verified shipped baseline exists for ${repo} (${target}); upload or GitHub release metadata is insufficient.`);
  const identities = new Set();
  for (const candidate of candidates) {
    // Even identical duplicates are ambiguous ledger identities, not a tie to
    // resolve by page order or the mutable display status.
    const identity = candidate.manifest.version.replace(/^v/, '');
    if (identities.has(identity)) fail('ambiguous', 'Duplicate or conflicting release baseline identities require ledger reconciliation.');
    identities.add(identity);
  }
  candidates.sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
  if (candidates.length > 1 && Date.parse(candidates[0].releasedAt) === Date.parse(candidates[1].releasedAt)) {
    fail('ambiguous', 'Released baseline candidates have the same release time; no arbitrary baseline was selected.');
  }
  return verified(candidates[0]);
}
async function resolveBaselines(config) {
  if (!Array.isArray(config.targets) || !config.targets.length || config.targets.length > 8 ||
      new Set(config.targets).size !== config.targets.length) fail('configuration', 'Provide all distinct trusted release targets for the maintained changelog.');
  const result = [];
  for (const target of config.targets) result.push({ target, ...await resolveBaseline({ ...config, target }) });
  return result; // Any missing target fails the complete lookup; no partial success.
}

module.exports = { BaselineError, resolveBaseline, resolveBaselines };
