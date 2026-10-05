// Read CI evidence; never check out or execute pull-request code.
const { workItemGate } = require('../release-ledger/work-item-gate');
const GROUPS = ['Build', 'Run', 'Verify'];
const APP_ID = 15368; // GitHub Actions; also bind required checks to this app.
const MARKER = 'veam-pr-flow-v1';

function evaluate(part, evidence) {
  if (part.missing) return { state: 'failure', detail: part.missing };
  if (!evidence?.run) return { state: 'failure', detail: 'Required workflow has not run for this commit.' };
  const { run, jobs } = evidence;
  if (run.status !== 'completed') return { state: 'pending', detail: 'CI is running.' };
  // A failed sibling must not label a successful test job as failed. Every
  // mandatory job is mapped separately; cancelled/incomplete runs still block.
  if (!['success', 'failure'].includes(run.conclusion)) return { state: 'failure', detail: `Workflow ${run.conclusion || 'has no conclusion'}.`, url: run.html_url };
  const matches = jobs.filter(job => job.name === part.job);
  if (matches.length !== 1) return { state: 'failure', detail: `Expected exactly one job named ${part.job}; found ${matches.length}.` };
  const job = matches[0];
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    const failedStep = (job.steps || []).find(step => step.conclusion === 'failure');
    return { state: 'failure', detail: `Required job ${job.conclusion || job.status || 'missing'}${failedStep ? `: ${failedStep.name}` : ''}.`, url: job.html_url || run.html_url };
  }
  for (const name of part.steps || []) {
    const steps = job.steps.filter(step => step.name === name);
    if (steps.length !== 1 || steps[0].conclusion !== 'success') {
      return { state: 'failure', detail: `Required step ${name}: ${steps.length === 1 ? steps[0].conclusion || steps[0].status : 'missing or ambiguous'}.` };
    }
  }
  return { state: 'success', detail: 'Passed.', url: job.html_url || run.html_url };
}

function groupState(parts) {
  if (!parts.length || parts.some(p => p.state === 'failure')) return 'failure';
  return parts.some(p => p.state === 'pending') ? 'pending' : 'success';
}

function samePull(a, b) {
  return b.state === 'open' && a.head.sha === b.head.sha && a.base.sha === b.base.sha &&
    a.title === b.title && a.body === b.body;
}

function md(text) { return String(text).replace(/[|\r\n]/g, ' ').replace(/</g, '&lt;'); }

async function report({ github, context, core, profiles }) {
  const repo = context.repo;
  const profile = profiles[repo.repo];
  if (!profile) throw new Error(`No reviewed PR-flow profile for ${repo.repo}.`);
  let pulls;
  if (context.payload.pull_request) {
    pulls = [(await github.rest.pulls.get({ ...repo, pull_number: context.payload.pull_request.number })).data];
  } else if (context.payload.workflow_run) {
    const source = context.payload.workflow_run;
    // Source metadata is only a wake-up. Fetch the current open PR and CI ourselves.
    pulls = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 }))
      .filter(pr => pr.head.sha === source.head_sha && pr.head.repo?.id === source.head_repository?.id);
  } else {
    // Manual reconciliation after initial rollout; no mutation of PRs or branches.
    pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
  }
  for (const pr of pulls.filter(pr => pr.state === 'open')) {
    const existing = await github.paginate(github.rest.checks.listForRef, {
      ...repo, ref: pr.head.sha, filter: 'all', per_page: 100,
    });
    const ids = {};
    async function publish(name, state, output) {
      const external_id = `${MARKER}:${pr.number}:${name}`;
      const fields = { ...repo, name, external_id, status: state === 'pending' ? 'in_progress' : 'completed',
        ...(state === 'pending' ? {} : { conclusion: state }), output };
      if (!ids[name]) {
        // Do not overwrite a same-name check belonging to another integration/workflow.
        ids[name] = existing.filter(c => c.app?.id === APP_ID && c.external_id === external_id)
          .sort((a, b) => b.id - a.id)[0]?.id;
      }
      if (ids[name]) await github.rest.checks.update({ ...fields, check_run_id: ids[name] });
      else ids[name] = (await github.rest.checks.create({ ...fields, head_sha: pr.head.sha })).data.id;
    }
    // Invalidate previous success before reading new evidence, including reruns and body edits.
    for (const name of GROUPS) await publish(name, 'pending', {
      title: `${name}: checking current evidence`, summary: `PR #${pr.number}, commit ${pr.head.sha}.`,
    });
    try {
      const evidence = {};
      const paths = [...new Set(GROUPS.flatMap(name => profile[name] || []).map(p => p.workflow).filter(Boolean))];
      for (const path of paths) {
        const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
          ...repo, workflow_id: path, event: 'pull_request', head_sha: pr.head.sha, per_page: 100,
        });
        const run = runs.filter(r => r.head_sha === pr.head.sha && r.event === 'pull_request' &&
          r.head_repository?.id === pr.head.repo?.id && r.head_branch === pr.head.ref &&
          (!r.pull_requests?.length || r.pull_requests.some(p => p.number === pr.number)))
          .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
        const jobs = run ? await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          ...repo, run_id: run.id, filter: 'latest', per_page: 100,
        }) : [];
        evidence[path] = { run, jobs };
      }
      const results = Object.fromEntries(GROUPS.map(name => [name, (profile[name] || []).map(part => ({
        name: part.name, ...evaluate(part, evidence[part.workflow]),
      }))]));
      const workItem = workItemGate(pr);
      results.Verify.unshift({ name: 'Work Item Linked', state: workItem.ok ? 'success' : 'failure', detail: workItem.summary });
      // A code/base/description change during API reads must not receive an old verdict.
      const current = (await github.rest.pulls.get({ ...repo, pull_number: pr.number })).data;
      if (!samePull(pr, current)) {
        core.info(`PR #${pr.number} changed during reconciliation; newer event will report it.`);
        continue;
      }
      for (const name of GROUPS) {
        const parts = results[name];
        const state = groupState(parts);
        const summary = [
          '| Check | Result | Evidence |', '| --- | --- | --- |',
          ...parts.map(p => `| ${md(p.name)} | ${p.state} | ${p.url ? `[${md(p.detail)}](${p.url})` : md(p.detail)} |`),
          '', profile.coverage || '', '',
          'Reports existing CI only. Lead review covers behavior, dependencies and deployment effects.',
        ].join('\n');
        await publish(name, state, { title: `${name}: ${state === 'pending' ? 'waiting for CI' : state}`, summary });
      }
    } catch (error) {
      for (const name of GROUPS) await publish(name, 'failure', {
        title: `${name}: evidence unavailable`, summary: 'Could not verify the current CI results. Retry PR Flow; required checks remain blocked.',
      });
      throw error;
    }
  }
}

module.exports = { evaluate, groupState, samePull, report };
