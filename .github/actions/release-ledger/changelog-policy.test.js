'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { policyFor, resolvePolicyBaselines } = require('./changelog-policy');
const repo = 'VeamStudios/SiteAuditPro-iOS';
const proof = { version: '10.7.3', commit: 'a'.repeat(40), proofDigest: 'b'.repeat(64) };
test('policy cannot be narrowed by PR-controlled target, path or ledger inputs', () => {
  assert.deepEqual(policyFor(repo).targets, ['ios-consumer', 'ios-enterprise']);
  assert.deepEqual(policyFor(repo).changelogPaths, ['CHANGELOG.md']);
  assert.throws(() => policyFor('VeamStudios/Unknown'), /no validated release policy/);
});
test('owner-authorized 10.7.3 assumption is explicit and uses verified consumer source', async () => {
  const baselines = await resolvePolicyBaselines({ repo }, async config => {
    if (config.target === 'ios-consumer') return proof;
    throw Object.assign(Error('missing'), { code: 'missing' });
  });
  assert.equal(baselines[1].commit, proof.commit);
  assert.equal(baselines[1].assumed, true);
  assert.match(baselines[1].assumption, /not independently verified/);
});
test('assumption cannot override contradictory proof or move to a future version', async () => {
  for (const code of ['unverified', 'invalid', 'ambiguous', 'conflict']) {
    await assert.rejects(resolvePolicyBaselines({ repo }, async config => {
      if (config.target === 'ios-consumer') return proof;
      throw Object.assign(Error(code), { code });
    }), new RegExp(code));
  }
  await assert.rejects(resolvePolicyBaselines({ repo }, async config => {
    if (config.target === 'ios-consumer') return { ...proof, version: '10.8.0' };
    throw Object.assign(Error('missing'), { code: 'missing' });
  }), /missing/);
});
test('real Enterprise proof supersedes the assumption', async () => {
  const baselines = await resolvePolicyBaselines({ repo }, async config => ({ ...proof, commit: config.target === 'ios-enterprise' ? 'c'.repeat(40) : proof.commit }));
  assert.equal(baselines[1].assumed, undefined);
  assert.equal(baselines[1].commit, 'c'.repeat(40));
});
