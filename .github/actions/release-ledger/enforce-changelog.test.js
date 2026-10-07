'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, enforce } = require('./enforce-changelog');

test('configuration requires trusted repository policy and existing credentials', () => {
  assert.throws(() => configuration({}), /credentials/);
  assert.throws(() => configuration({ NOTION_TOKEN: 'test', CURSOR_API_KEY: 'test' }), /no validated release policy/);
  const config = configuration({ NOTION_TOKEN: 'test', CURSOR_API_KEY: 'test', RELEASE_TARGETS: 'ios-consumer', CHECK_REPOSITORY: 'VeamStudios/SiteAuditPro-iOS' });
  assert.deepEqual(config.targets, ['ios-consumer', 'ios-enterprise']);
  assert.equal(config.repository, 'VeamStudios/SiteAuditPro-iOS');
});

test('missing release evidence stops before any assessment or source transfer', async () => {
  let invoked = false;
  await assert.rejects(enforce({ targets: ['ios-consumer', 'ios-enterprise'] }, {
    resolveBaselines: async () => { throw Error('No verified Enterprise baseline'); },
    collectEvidence: () => { invoked = true; }, runAssessment: () => { invoked = true; },
  }), /Enterprise/);
  assert.equal(invoked, false);
});

test('all target proofs reach collector, and every assessment reaches validator', async () => {
  const evidence = { digest: 'bound-evidence' }, assessment = { outcome: 'missing_note' };
  let collected;
  const result = await enforce({ repository: 'VeamStudios/Test', targets: ['a', 'b'] }, {
    resolveBaselines: async () => [{ commit: 'a'.repeat(40) }, { commit: 'b'.repeat(40) }],
    collectEvidence: config => { collected = config; return evidence; },
    validateEvidence: input => { assert.equal(input, evidence); },
    runAssessment: async input => { assert.equal(input, evidence); return assessment; },
    renderAssessment: (input, output) => { assert.equal(input, evidence); assert.equal(output, assessment); return { exitCode: 1 }; },
  });
  assert.deepEqual(collected.releaseCommits, ['a'.repeat(40), 'b'.repeat(40)]);
  assert.equal(result.exitCode, 1);
});

test('incomplete collection stops before any assessment', async () => {
  let called = false;
  await assert.rejects(enforce({}, {
    resolveBaselines: async () => [{ commit: 'a'.repeat(40) }],
    collectEvidence: () => { throw Error('Incomplete evidence'); },
    runAssessment: () => { called = true; },
  }), /Incomplete/);
  assert.equal(called, false);
});
