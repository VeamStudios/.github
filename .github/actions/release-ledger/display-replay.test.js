const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { record, rich, hash, text, deployedBaseline } = require('./record');

function fixture(state) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const source = 'https://github.com/VeamStudios/Test/actions/runs/123';
  const releasedAt = '2026-10-05T10:00:00Z';
  const manifest = { schemaVersion: 2, key: 'VeamStudios/Test/web/release/v1.0.0', repository: 'VeamStudios/Test', product: 'Site Audit Pro', target: 'web', version: 'v1.0.0', build: '', commit, baseline: '', event: 'release', prs: [], changes: [], issues: [], provenanceComplete: false, source, completeChangelog: '', workItemSnapshots: [] };
  const verification = { kind: 'http', commit, reportedCommit: commit, repository: manifest.repository, evidence: 'https://example.com/release-info.json' };
  const observation = { phase: 'deployed', source, releasedAt, verification };
  const row = { id: 'row', properties: { State: { select: { name: state } }, Manifest: rich(JSON.stringify(manifest)), 'Manifest Hash': rich(hash(manifest)), Observation: rich(JSON.stringify(observation)) } };
  const config = { repo: manifest.repository, target: manifest.target, product: manifest.product, version: manifest.version, build: manifest.build, commit, event: manifest.event, phase: observation.phase, source, releasedAt, verification, releasesId: 'releases', dryRun: true };
  const api = { gh: async () => { throw new Error('Replay must not query mutable GitHub metadata'); }, notion: async path => path === '/data_sources/releases' ? { properties: { Target: { type: 'rich_text' }, Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } } } } : { results: [row], has_more: false } };
  return { config, api, row, manifest };
}

for (const state of ['Available', 'Released', 'Superseded', 'Withdrawn']) {
  test(`${state} display survives two identical source replays`, async () => {
    const { config, api, row, manifest } = fixture(state);
    const frozen = JSON.stringify(row);
    for (let i = 0; i < 2; i++) {
      const result = await record(config, api);
      assert.equal(result.properties.State, undefined);
      assert.equal(result.properties.Manifest, undefined);
      assert.equal(result.properties['Manifest Hash'], undefined);
      assert.equal(result.properties.Observation, undefined);
      assert.equal(result.properties['Notification State'], undefined);
      assert.deepEqual(result.manifest, manifest);
    }
    assert.equal(JSON.stringify(row), frozen);
  });
}

test('Released label cannot hide explicit withdrawal or a failed verification', async () => {
  const { config, api, manifest } = fixture('Released');
  const withdrawal = await record({ ...config, phase: 'withdrawn' }, api);
  assert.equal(withdrawal.properties.State.select.name, 'Withdrawn');
  assert.equal(JSON.parse(text(withdrawal.properties.Observation)).phase, 'withdrawn');
  const failure = await record({ ...config, verification: undefined, verificationError: 'Current production lookup failed' }, api);
  const observation = JSON.parse(text(failure.properties.Observation));
  assert.equal(observation.verificationError, 'Current production lookup failed');
  assert.equal(text(failure.properties.Error), observation.verificationError);
  assert.equal(JSON.parse(text(withdrawal.properties['Deploy Observation'])).observation.phase, 'withdrawn');
  assert.equal(text(failure.properties['Deploy Error']), observation.verificationError);
  assert.equal(observation.verification.commit, manifest.commit);
  await assert.rejects(record({ ...config, build: 'other-build' }, api), /different commit\/build/);
});

test('Waiting display stays provisional on a verified source replay', async () => {
  const { config, api } = fixture('Waiting');
  const result = await record(config, api);
  assert.equal(result.properties.State, undefined); // identical Waiting is a no-op
});

test('display labels cannot manufacture a verified comparison baseline', () => {
  for (const state of ['Available', 'Released', 'Superseded', 'Waiting']) {
    const { row } = fixture(state);
    assert.equal(deployedBaseline(row), true);
    const observation = JSON.parse(text(row.properties.Observation));
    row.properties.Observation = rich(JSON.stringify({ ...observation, verification: null }));
    assert.equal(deployedBaseline(row), false);
  }
});
