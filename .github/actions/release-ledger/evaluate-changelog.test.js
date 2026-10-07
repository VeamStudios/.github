'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cases, evaluate, CLI_VERSION, MODEL } = require('./evaluate-changelog');
function answer(evidence, disposition) {
  const finding = { effect: disposition === 'exempt' ? 'Additional test coverage only' : 'CSV report export', disposition, evidence: [{ path: evidence.files[0].path, side: 'after', line: 3 }], entryIds: disposition === 'covered' ? [evidence.entries[0].id] : [], reason: disposition === 'exempt' ? 'Only a test assertion is added; production behavior is unchanged.' : disposition === 'covered' ? 'The upcoming note describes CSV export.' : 'The newly supported CSV export format has no eligible entry.' };
  if (disposition === 'missing') Object.assign(finding, { correction: 'Add a CSV report export bullet to CHANGELOG.md.', heading: 'New' });
  return { schemaVersion: 1, repository: evidence.repository, head: evidence.head, base: evidence.base, evidenceDigest: evidence.digest, outcome: disposition === 'missing' ? 'missing_note' : 'pass', findings: [finding] };
}
test('three synthetic policy cases pass the actual validator with representative valid answers', async () => {
  let calls = 0;
  const report = await evaluate({ executable: '/fake/agent', apiKey: 'fake-key' }, { runAssessment: async (evidence, options) => {
    assert.equal(options.timeoutMs, 60000); assert.equal(options.expectedVersion, CLI_VERSION); assert.equal(options.model, MODEL);
    return answer(evidence, ['missing', 'covered', 'exempt'][calls++]);
  } });
  assert.equal(calls, 3); assert.deepEqual(report, { total: 3, passed: 3, mismatched: 0, errors: 0, skipped: 0, diagnostics: [], exitCode: 0 });
});
test('existing upcoming coverage does not require a changelog edit', () => {
  const covered = cases()[1];
  assert.equal(covered.evidence.files.some(file => file.path === 'CHANGELOG.md'), false);
  assert.equal(covered.evidence.entries[0].eligible, true);
});
test('valid but incorrect semantic answers fail acceptance', async () => {
  const report = await evaluate({}, { runAssessment: async evidence => answer(evidence, 'exempt') });
  assert.deepEqual(report, { total: 3, passed: 1, mismatched: 2, errors: 0, skipped: 0, diagnostics: [], exitCode: 1 });
});
test('malformed output is an error rather than an outcome mismatch', async () => {
  const report = await evaluate({}, { runAssessment: async () => ({ secret: 'must never be logged' }) });
  assert.equal(report.errors, 1); assert.equal(report.skipped, 2); assert.equal(report.diagnostics[0].code, 'assessment_validation'); assert.equal(report.exitCode, 1);
});
test('provider errors are bounded to one invocation per case with no retry', async () => {
  let calls = 0;
  const report = await evaluate({}, { runAssessment: async () => { calls++; throw Error('private provider content'); } });
  assert.equal(calls, 1); assert.equal(report.errors, 1); assert.equal(report.skipped, 2); assert.equal(report.exitCode, 1);
});
