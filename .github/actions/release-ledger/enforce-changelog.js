'use strict';
const fs = require('node:fs');
const { clients } = require('./record');
const { collectEvidence } = require('./changelog-evidence');
const { hydrateEvidenceBlobs } = require('./changelog-prefetch');
const { policyFor, resolvePolicyBaselines } = require('./changelog-policy');
const { runAssessment } = require('./changelog-cursor');
const { validateEvidence, renderAssessment } = require('./changelog-assessment');

const CLI_VERSION = '2026.10.01-e373342';
const MODEL = 'grok-4.6'; // Existing shared Cursor issue-worker model; no automatic fallback.
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function safeError(error) {
  if (['BaselineError', 'EvidenceError', 'AssessmentValidationError', 'PrefetchError'].includes(error?.name) ||
      /^(Changelog assessment|Complete changelog evidence|Existing Notion|Missing-entry enforcement|Notion (?:GET|POST) failed \(\d{3}\)|GitHub (?:GET|POST) failed \(\d{3}\))/.test(error?.message || '')) return error.message;
  return 'Unexpected changelog check execution error; inspect its configuration and dependency availability.';
}
const commandData = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
function configuration(env) {
  if (!env.NOTION_TOKEN || !env.CURSOR_API_KEY || !env.READ_GITHUB_TOKEN) throw Error('Existing Notion, Cursor and read-only GitHub credentials must be forwarded by the caller.');
  return { ...policyFor(env.CHECK_REPOSITORY), head: env.PR_HEAD_SHA, base: env.PR_BASE_SHA };
}
async function enforce(config, dependencies) {
  const baselines = await dependencies.resolveBaselines({ api: dependencies.api, repo: config.repository, targets: config.targets, releasesId: config.releasesId });
  await dependencies.hydrateEvidenceBlobs({ cwd: config.cwd, repository: config.repository, head: config.head, base: config.base,
    releaseCommits: [...new Set(baselines.map(x => x.commit))], changelogPaths: config.changelogPaths });
  const evidence = dependencies.collectEvidence({ cwd: config.cwd, repository: config.repository, head: config.head, base: config.base,
    releaseCommits: [...new Set(baselines.map(x => x.commit))], changelogPaths: config.changelogPaths, changelogFormat: config.changelogFormat });
  dependencies.validateEvidence(evidence);
  const assessment = await dependencies.runAssessment(evidence);
  const result = dependencies.renderAssessment(evidence, assessment);
  for (const baseline of baselines.filter(x => x.assumed)) result.summary += '\nBaseline assumption: ' + escape(baseline.assumption) + '\n';
  return result;
}
async function main(env = process.env) {
  let result;
  try {
    const config = { ...configuration(env), cwd: process.cwd() };
    result = await enforce(config, { api: clients({ notionToken: env.NOTION_TOKEN }), resolveBaselines: resolvePolicyBaselines, collectEvidence, validateEvidence, renderAssessment,
      hydrateEvidenceBlobs: config => hydrateEvidenceBlobs({ ...config, githubToken: env.READ_GITHUB_TOKEN }),
      runAssessment: evidence => runAssessment(evidence, { executable: env.CURSOR_EXECUTABLE, expectedVersion: CLI_VERSION, model: MODEL, apiKey: env.CURSOR_API_KEY, timeoutMs: 180000 }) });
  } catch (error) {
    // Do not print provider output, tokens, raw source or Notion response bodies.
    const message = safeError(error);
    result = { exitCode: 1, annotations: [], summary: '## Changelogs — check could not complete\n\n' +
      escape(message) + '\n\nThis is an assessment/input error, not a finding that the author forgot a changelog entry. Restore the release evidence or check configuration, then rerun.\n' };
    console.log('::error::' + commandData(message));
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary + '\n');
  for (const annotation of result.annotations) console.log(annotation);
  return result.exitCode;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Changelog check failed before reporting its result.'); process.exitCode = 1; });
module.exports = { configuration, enforce, main, safeError, CLI_VERSION, MODEL };
