// Each release-ledger writer owns its own Releases columns, so concurrent
// writers never overwrite each other's data. Readers fold the owned columns
// back into the single observation the shared Observation field used to hold.
// NotionWorkers src/shared/releases/ledger-columns.ts implements the same fold.
const text = prop => (prop?.rich_text || prop?.title || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
const rich = value => {
  const s = String(value ?? '');
  if (s.length > 180000) throw new Error('Release record exceeds supported size; split the release explicitly (nothing was truncated).');
  return { rich_text: (s.match(/[\s\S]{1,1800}/g) || []).map(content => ({ type: 'text', text: { content } })) };
};

const OWNERS = {
  deploy: { observation: 'Deploy Observation', error: 'Deploy Error' },
  store: { observation: 'App Store Observation', error: 'App Store Error' },
  play: { observation: 'Play Observation', error: 'Play Error' },
};
const WEBSITE_RECEIPT = 'Website Receipt';
const ANNOUNCEMENT_SOURCE = 'Announcement Source';
// Same ordering record.js uses to refuse an older deploy phase over a newer one.
const RANK = { prepare: 0, uploaded: 1, deployed: 2, rollout: 3, live: 4, withdrawn: 5 };

// Mirror the shared fields this writer is sending into its own columns. Released
// At and Availability Evidence stay set until replaced, so carry this writer's
// previous values forward when a write (such as a failed check) omits them. A
// writer's first owned record starts from the row's existing shared values.
function ownColumns(owner, properties, recordedAt, previousProperties = {}) {
  const columns = OWNERS[owner];
  if (!columns) throw new Error(`Unknown release ledger owner: ${owner}`);
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('Owned observation requires a recordedAt timestamp');
  const result = { ...properties };
  if (properties.Observation) {
    const { website, ...observation } = JSON.parse(text(properties.Observation));
    const previous = parse(previousProperties[columns.observation]) || { availabilityEvidence: previousProperties['Availability Evidence']?.url, releasedAt: previousProperties['Released At']?.date?.start };
    const record = { owner, recordedAt, observation };
    const availabilityEvidence = properties['Availability Evidence']?.url || previous.availabilityEvidence;
    const releasedAt = properties['Released At']?.date?.start || previous.releasedAt;
    if (availabilityEvidence) record.availabilityEvidence = availabilityEvidence;
    if (releasedAt) record.releasedAt = releasedAt;
    result[columns.observation] = rich(JSON.stringify(record));
  }
  if (properties.Error) result[columns.error] = properties.Error;
  return result;
}

function parse(prop) {
  const raw = text(prop);
  return raw ? JSON.parse(raw) : null;
}

// Rebuild the observation from the owned columns, oldest write first. A deploy
// record only replaces a lower-or-equal phase; store and Play evidence always
// replace, exactly as their direct writes to Observation did.
function effectiveObservation(properties) {
  const records = Object.entries(OWNERS)
    .map(([owner, columns]) => parse(properties[columns.observation]) && { ...parse(properties[columns.observation]), owner })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  let current = null; let availabilityEvidence = ''; let releasedAt = ''; let observedAt = '';
  for (const record of records) {
    const accepted = !current || record.owner !== 'deploy' || RANK[record.observation.phase] >= (RANK[current.observation.phase] ?? -1);
    if (!accepted) continue;
    current = record;
    if (record.availabilityEvidence) availabilityEvidence = record.availabilityEvidence;
    if (record.releasedAt) releasedAt = record.releasedAt;
    observedAt = record.recordedAt;
  }
  const website = parse(properties[WEBSITE_RECEIPT]);
  if (!current) return null;
  return { observation: { ...current.observation, ...(website ? { website } : {}) }, owner: current.owner, availabilityEvidence, releasedAt, observedAt };
}

module.exports = { OWNERS, WEBSITE_RECEIPT, ANNOUNCEMENT_SOURCE, RANK, ownColumns, effectiveObservation };
