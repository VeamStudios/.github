'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectInput, REPOSITORY } = require('./coverage-input');
const { validateBaseline } = require('./coverage-baseline');
const { validateAssessment, renderAssessment, exitCode } = require('./coverage-result');
const MAX_ENVELOPE_BYTES = 20 * 1024 * 1024;

// This only excludes PR-controlled files. Authenticity still depends on the
// trusted workflow creating the envelopes; a hash or temp path is not a grant.
function readTrustedEnvelope(filename, workspace) {
  if (!filename) throw Error('A fresh trusted release baseline is not configured.');
  const file = fs.realpathSync(filename), root = fs.realpathSync(workspace);
  const relative = path.relative(root, file);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Baseline and assessment envelopes must come from trusted automation outside the PR checkout. Author-managed JSON cannot supply a judgment.');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_ENVELOPE_BYTES) throw Error('The trusted coverage envelope is unavailable or exceeds the complete-input limit.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function fallback(input) {
  const changelogOnly = input.files.every(file => file.path === 'CHANGELOG.md');
  const identity = { schemaVersion: 1, repository: input.repository, headSha: input.headSha, baseSha: input.baseSha, digest: input.digest };
  if (input.files.length === 0 || changelogOnly) return { ...identity, outcome: 'pass', reason: input.files.length ? 'Only unpublished changelog wording changed; published history is intact. Ordinary PR review approves the wording.' : 'There are no changes from the PR merge base. No new release note is needed.', findings: [] };
  return { ...identity, outcome: 'review', reason: 'No approved semantic assessor is configured. Review whether the actual effects need New, Fixed or Internal wording and whether an eligible upcoming entry covers them. Routine tests, formatting, behavior-preserving refactors and ordinary CI/docs maintenance need no note unless they have a material effect. An empty or unchanged changelog is not by itself a failure.', findings: [] };
}
function evaluate({ repository, headSha, baseSha, workspace, snapshot, assessment, baselineError, assessmentError, pr, mode = 'pilot', now = Date.now(), readGit, limits }) {
  if (!['pilot', 'enforce'].includes(mode)) throw Error('Unknown coverage mode.');
  let input = { schemaVersion: 1, repository, headSha, baseSha, digest: '0'.repeat(64), files: [], eligibleEntries: [] };
  let result;
  try {
    if (baselineError) throw Error(baselineError);
    const baseline = validateBaseline(snapshot, { repository, now });
    input = collectInput({ cwd: workspace, repository, headSha, baseSha, baseline, pr, readGit, limits });
    if (assessmentError) throw Error(assessmentError);
    result = validateAssessment(assessment || fallback(input), input);
  } catch (error) {
    result = { schemaVersion: 1, repository, headSha, baseSha, digest: input.digest, outcome: 'error', reason: `Changelog coverage could not be assessed. ${error.message} Repair the trusted baseline or complete input, then rerun. No missing changelog entry is inferred.`, findings: [] };
  }
  const rendered = renderAssessment(result, input);
  rendered.summary += `\n\n${mode === 'pilot' ? 'Pilot diagnostics only: this job does not block merging or establish changelog coverage. Gate activation needs separate approval.' : 'Enforcement contract evaluation; deployment and required-gate activation are separate decisions.'}\n`;
  return { input, ...rendered, code: exitCode(rendered.result, mode) };
}
function main(env = process.env) {
  const workspace = env.COVERAGE_WORKSPACE || process.cwd();
  const config = { repository: env.COVERAGE_REPOSITORY || REPOSITORY, headSha: env.COVERAGE_HEAD_SHA, baseSha: env.COVERAGE_BASE_SHA, workspace, mode: env.COVERAGE_MODE || 'pilot', pr: { number: env.COVERAGE_PR_NUMBER ? Number(env.COVERAGE_PR_NUMBER) : null, title: env.COVERAGE_PR_TITLE || '', body: env.COVERAGE_PR_BODY || '' } };
  const envelopes = {};
  try { envelopes.snapshot = readTrustedEnvelope(env.COVERAGE_BASELINE_PATH, workspace); }
  catch (error) { envelopes.baselineError = `Baseline envelope: ${error.message}`; }
  if (env.COVERAGE_ASSESSMENT_PATH) {
    try { envelopes.assessment = readTrustedEnvelope(env.COVERAGE_ASSESSMENT_PATH, workspace); }
    catch (error) { envelopes.assessmentError = `Assessment envelope: ${error.message}`; }
  }
  const evaluated = evaluate({ ...config, ...envelopes });
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, evaluated.summary + '\n');
  else process.stdout.write(evaluated.summary + '\n');
  // Pilot errors/missing notes are warnings because they are diagnostic only.
  for (const annotation of evaluated.annotations) process.stdout.write(annotation.command.replace(/^::error/, config.mode === 'pilot' ? '::warning' : '::error') + '\n');
  return evaluated.code;
}
if (require.main === module) process.exitCode = main();
module.exports = { evaluate, fallback, readTrustedEnvelope, main };
