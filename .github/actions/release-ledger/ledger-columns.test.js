const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownColumns, effectiveObservation } = require('./ledger-columns');
const { rich, text } = require('./record');

const at = minute => `2026-10-06T10:${String(minute).padStart(2, '0')}:00.000Z`;
// Apply writes in order, as each writer's PATCH would land on the row.
function rowAfter(writes) {
  const properties = {};
  for (const [owner, observation, minute, extra = {}] of writes) {
    Object.assign(properties, ownColumns(owner, { Observation: rich(JSON.stringify(observation)), ...extra }, at(minute), properties));
  }
  return properties;
}
const uploaded = { phase: 'uploaded', verification: null };
const live = { phase: 'live', releasedAt: at(2), verification: { kind: 'app-store', checkedAt: at(2) } };

for (const { name, writes, website, phase, owner, evidence, releasedAt } of [
  { name: 'store evidence replaces the uploaded deploy record',
    writes: [['deploy', uploaded, 1], ['store', live, 2, { 'Availability Evidence': { url: 'https://asc/1' }, 'Released At': { date: { start: at(2) } } }]],
    phase: 'live', owner: 'store', evidence: 'https://asc/1', releasedAt: at(2) },
  { name: 'a later deploy retry of a lower phase cannot hide live store evidence',
    writes: [['store', live, 2, { 'Availability Evidence': { url: 'https://asc/1' } }], ['deploy', uploaded, 3]],
    phase: 'live', owner: 'store', evidence: 'https://asc/1' },
  { name: 'an explicit withdrawal outranks live evidence',
    writes: [['store', live, 2], ['deploy', { phase: 'withdrawn', verification: null }, 4, { 'Availability Evidence': { url: 'https://run/4' }, 'Released At': { date: { start: at(4) } } }]],
    phase: 'withdrawn', owner: 'deploy', evidence: 'https://run/4', releasedAt: at(4) },
  { name: 'a failed store check keeps its phase but carries the error',
    writes: [['store', live, 2, { 'Released At': { date: { start: at(2) } } }], ['store', { ...live, verificationStatus: 'error', verificationError: 'HTTP 403' }, 5]],
    phase: 'live', owner: 'store', releasedAt: at(2) },
  { name: 'Play evidence always replaces, including a halt after live',
    writes: [['play', { phase: 'live', verification: { kind: 'google-play' } }, 2], ['play', { phase: 'halted', verification: { kind: 'google-play' } }, 6]],
    phase: 'halted', owner: 'play' },
  { name: 'the website receipt is merged back into the observation',
    writes: [['play', { phase: 'live', verification: { kind: 'google-play' }, website: { state: 'stale copy' } }, 2]],
    website: { state: 'published', commit: 'abc' }, phase: 'live', owner: 'play' },
]) {
  test(`effective observation: ${name}`, () => {
    const properties = rowAfter(writes);
    if (website) properties['Website Receipt'] = rich(JSON.stringify(website));
    const result = effectiveObservation(properties);
    assert.equal(result.observation.phase, phase);
    assert.equal(result.owner, owner);
    assert.equal(result.availabilityEvidence, evidence || '');
    assert.equal(result.releasedAt, releasedAt || '');
    assert.deepEqual(result.observation.website, website);
  });
}

test('a first owned record starts from the row\'s existing release time and evidence', () => {
  const legacy = { 'Availability Evidence': { url: 'https://asc/old' }, 'Released At': { date: { start: at(1) } } };
  const properties = ownColumns('store', { Observation: rich(JSON.stringify({ ...live, verificationStatus: 'error', verificationError: 'HTTP 403' })) }, at(5), legacy);
  const result = effectiveObservation(properties);
  assert.equal(result.availabilityEvidence, 'https://asc/old');
  assert.equal(result.releasedAt, at(1));
});

test('rows with no owned observation have no effective observation', () => {
  assert.equal(effectiveObservation({}), null);
});

test('owned columns mirror the shared error and never store the website copy', () => {
  const properties = ownColumns('store', { Observation: rich(JSON.stringify({ phase: 'live', website: { state: 'x' } })), Error: rich('HTTP 403') }, at(1));
  assert.equal(text(properties['App Store Error']), 'HTTP 403');
  assert.equal(JSON.parse(text(properties['App Store Observation'])).observation.website, undefined);
  assert.throws(() => ownColumns('store', {}, 'not a time'), /recordedAt/);
});
