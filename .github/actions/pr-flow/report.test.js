const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, groupState, samePull, report, nativeStates } = require('./report');
const profiles = require('./profiles.json');
const part = { name: 'App Store', workflow: 'ci.yml', job: 'Build app', steps: ['Compile'] };
const passing = () => ({ run: { status: 'completed', conclusion: 'success' }, jobs: [{ name: 'Build app', status: 'completed', conclusion: 'success', steps: [{ name: 'Compile', conclusion: 'success' }] }] });
test('missing, failed, cancelled and skipped evidence cannot pass', () => {
  assert.equal(evaluate(part, {}).state, 'failure');
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', null]) {
    const evidence = passing(); evidence.jobs[0].steps[0].conclusion = conclusion;
    assert.equal(evaluate(part, evidence).state, 'failure');
  }
  assert.equal(evaluate({ missing: 'No tests configured' }, passing()).state, 'failure');
  assert.equal(groupState([]), 'failure');
});
test('requires exact job and step names; ambiguous results block', () => {
  assert.equal(evaluate(part, passing()).state, 'success');
  const evidence = passing(); evidence.jobs.push(evidence.jobs[0]);
  assert.equal(evaluate(part, evidence).state, 'failure');
  assert.equal(evaluate({ ...part, steps: ['Other'] }, passing()).state, 'failure');
});
test('queued evidence stays pending and failures win over pending', () => {
  const evidence = passing(); evidence.run.status = 'in_progress';
  assert.equal(evaluate(part, evidence).state, 'pending');
  assert.equal(groupState([{ state: 'success' }, { state: 'pending' }]), 'pending');
  assert.equal(groupState([{ state: 'failure' }, { state: 'pending' }]), 'failure');
});
test('a failing sibling does not misreport successful tests; cancelled runs block', () => {
  const evidence = passing(); evidence.run.conclusion = 'failure';
  assert.equal(evaluate(part, evidence).state, 'success');
  evidence.run.conclusion = 'cancelled';
  assert.equal(evaluate(part, evidence).state, 'failure');
});
test('head, base, PR body and title races invalidate evidence', () => {
  const pr = { state: 'open', head: { sha: 'head' }, base: { sha: 'base' }, title: 'ci: checks', body: '' };
  assert.ok(samePull(pr, pr));
  for (const patch of [{ head: { sha: 'new' } }, { base: { sha: 'new' } }, { title: 'feat: new' }, { body: 'changed' }, { state: 'closed' }]) assert.ok(!samePull(pr, { ...pr, ...patch }));
});
test('all repo profiles use the three standard names and explicit evidence or gaps', () => {
  for (const p of Object.values(profiles)) for (const group of ['Build', 'Run', 'Verify']) {
    assert.ok(Array.isArray(p[group]));
    if (group !== 'Verify') assert.ok(p[group].length);
    for (const part of p[group]) assert.ok(part.name && (part.missing || (part.workflow && part.job)));
  }
});
function fixture({ failing = false, apiError = false, newerHead = false } = {}) {
  let gets = 0; const writes = [];
  const pr = { number: 1, state: 'open', title: 'ci: checks', body: '', head: { sha: 'head', ref: 'branch', repo: { id: 1 } }, base: { sha: 'base' } };
  const run = { id: 2, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: 'head', head_branch: 'branch', head_repository: { id: 1 }, pull_requests: [{ number: 1 }] };
  const actions = { listWorkflowRuns() {}, listJobsForWorkflowRun() {} };
  const checks = { listForRef() {} };
  const github = { rest: { actions, checks, pulls: { async get() { gets++; return { data: newerHead && gets > 1 ? { ...pr, head: { ...pr.head, sha: 'new' } } : pr }; } } }, async paginate(method) {
    if (method === checks.listForRef) return [];
    if (apiError) throw Error('API unavailable');
    if (method === actions.listWorkflowRuns) return [{ ...run, id: 1, head_sha: 'old' }, run];
    const jobs = passing().jobs;
    if (failing) jobs[0].conclusion = 'cancelled';
    return jobs;
  } };
  return { writes, options: { github, context: { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { number: 1 } } }, core: { info() {} }, publishResult(result) { writes.push({ ...result, status: result.state === 'pending' ? 'in_progress' : 'completed', conclusion: result.state === 'pending' ? undefined : result.state }); }, profiles: { test: { Build: [part], Run: [part], Verify: [part] } } } };
}
test('publishes pending first, then only current verified evidence succeeds', async () => {
  const { writes, options } = fixture(); await report(options);
  assert.equal(writes.length, 6);
  assert.ok(writes.slice(0, 3).every(w => w.status === 'in_progress'));
  assert.deepEqual(writes.slice(3).map(w => w.conclusion), ['success', 'success', 'success']);
});
test('a cancelled mandatory job fails all dependent summaries', async () => {
  const { writes, options } = fixture({ failing: true }); await report(options);
  assert.ok(writes.slice(3).every(w => w.conclusion === 'failure'));
});
test('API errors cannot produce successful native results', async () => {
  const { writes, options } = fixture({ apiError: true }); await assert.rejects(report(options));
  assert.ok(writes.slice(3).every(w => w.conclusion === 'failure'));
});
test('a moving PR cannot receive a successful stale verdict', async () => {
  const { writes, options } = fixture({ newerHead: true }); await report(options);
  assert.equal(writes.length, 3);
  assert.ok(writes.every(w => w.status === 'in_progress'));
});
const { policy } = require('./policy');
test('activation retains native guards alongside summaries and refuses missing coverage', () => {
  const rules = policy('SiteAuditPro-Backend').rules;
  const checks = rules.find(rule => rule.type === 'required_status_checks').parameters;
  assert.deepEqual(checks.required_status_checks.map(c => c.context), ['report / Build', 'report / Run', 'report / Verify', 'check / validate', 'check / test']);
  assert.ok(checks.required_status_checks.every(c => c.integration_id === 15368));
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.throws(() => policy('SiteAuditPro-Web'), /Cannot activate/);
  assert.throws(() => policy('unknown'), /Unknown repository/);
});

test('native results stay blocked for missing, pending, failed and raced evidence', () => {
  assert.deepEqual(nativeStates([]), { Build: 'failure', Run: 'failure', Verify: 'failure' });
  const records = ['Build', 'Run', 'Verify'].map(name => ({ pull_number: 1, name, state: 'pending' }));
  assert.deepEqual(nativeStates(records), { Build: 'pending', Run: 'pending', Verify: 'pending' });
  records.push(...['Build', 'Run', 'Verify'].map(name => ({ pull_number: 1, name, state: 'success' })));
  assert.deepEqual(nativeStates(records), { Build: 'success', Run: 'success', Verify: 'success' });
  records.push({ pull_number: 2, name: 'Verify', state: 'failure' });
  assert.equal(nativeStates(records).Verify, 'failure');
});
test('native reporter reads CI without calling or reusing custom check APIs', async () => {
  const { options } = fixture();
  options.github.rest.checks = new Proxy({}, { get() { throw Error('Custom checks must not be used'); } });
  const records = [];
  options.publishResult = result => records.push(result);
  await report(options);
  assert.deepEqual(nativeStates(records), { Build: 'success', Run: 'success', Verify: 'success' });
});
