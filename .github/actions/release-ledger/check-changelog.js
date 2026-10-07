'use strict';

// Deterministic format/link diagnostics only. Git blobs are data: no PR code,
// filters, external diff tools, provider calls or release credentials are used.
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const fs = require('node:fs');
const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 2 * 1024 * 1024;
function readChangelog({ workspace = process.cwd(), repository, headSha, baseSha }) {
  if (repository !== REPOSITORY || !SHA.test(headSha || '') || (baseSha !== undefined && !SHA.test(baseSha))) throw Error('Format diagnostics need the SAP iOS repository and exact PR commit identifiers.');
  const git = (...args) => execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workspace, maxBuffer: MAX_BYTES + 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bytes;
  try {
    if (git('rev-parse', '--verify', `${headSha}^{commit}`).toString('utf8').trim() !== headSha) throw Error('Exact head mismatch.');
    const tree = git('ls-tree', '-z', headSha, '--', 'CHANGELOG.md').toString('utf8');
    const match = tree.match(/^(100644|100755) blob ([a-f0-9]{40})\tCHANGELOG\.md\0$/);
    if (!match) throw Error('CHANGELOG.md is missing or is not a regular file at this head.');
    const size = Number(git('cat-file', '-s', match[2]).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw Error('CHANGELOG.md exceeds the supported complete-input limit.');
    bytes = git('cat-file', 'blob', match[2]);
    if (bytes.length !== size) throw Error('The complete changelog blob could not be read.');
  } catch (error) {
    if (error.message.startsWith('CHANGELOG.md') || error.message === 'The complete changelog blob could not be read.') throw error;
    throw Error('The exact PR changelog Git object could not be read. Fetch the reviewed head and rerun.');
  }
  if (bytes.includes(0)) throw Error('CHANGELOG.md contains binary data and could not be checked.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error('CHANGELOG.md is not complete UTF-8 text and could not be checked.'); }
}
function evaluate({ repository, headSha, baseSha, workspace, read = readChangelog }) {
  let source;
  try { source = read({ repository, headSha, baseSha, workspace }); }
  catch (error) { return { repository, headSha, status: 'error', message: error.message, entries: [], sections: [] }; }
  try {
    const { validateChangelog } = require('./changelog-format');
    const parsed = validateChangelog(source);
    return { repository, headSha, status: 'valid', entries: parsed.entries, sections: parsed.sections };
  } catch (error) {
    if (error.name !== 'ChangelogFormatError') return { repository, headSha, status: 'error', message: 'The format validator could not execute. Repair the shared check configuration and rerun.', entries: [], sections: [] };
    const line = error.details?.ref?.startLine ?? error.line;
    return { repository, headSha, status: error.details?.rule === 'input' ? 'error' : 'invalid', message: error.message, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), entries: [], sections: [] };
  }
}
const clean = value => String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');
const markdown = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1');
const command = value => clean(value).replace(/%/g, '%25');
function render(result) {
  const summary = ['## Changelogs — format and links', ''];
  const annotations = [];
  if (result.status === 'valid') {
    const workItems = result.entries.reduce((n, entry) => n + entry.workItems.length, 0);
    const prs = result.entries.reduce((n, entry) => n + entry.prRefs.length, 0);
    summary.push('**Format and explicit link syntax: valid.**', '', `${result.entries.length} entries parsed; ${workItems} Work Item references and ${prs} source PR references syntax-checked.`);
  } else {
    const title = result.status === 'invalid' ? 'Changelog format or link issue' : 'Changelog could not be checked';
    const correction = result.status === 'invalid' ? 'Correct the indicated structure or link in CHANGELOG.md.' : 'Repair the readable exact-head input, then rerun.';
    summary.push(`**${title}.**`, '', markdown(result.message), '', correction);
    annotations.push(`::warning${result.line ? ` file=CHANGELOG.md,line=${result.line}` : ''}::${command(result.message)} ${correction}`);
  }
  summary.push('', '**Code-to-wording coverage: not assessed.**', '', 'These diagnostic rules do not decide whether a change needs a note, whether wording covers code, whether a release shipped, or whether a linked page/PR exists. No new entry is required merely because this PR exists.');
  if (SHA.test(result.headSha || '') && result.repository === REPOSITORY) summary.push('', `[Review CHANGELOG.md at this head](https://github.com/${REPOSITORY}/blob/${result.headSha}/CHANGELOG.md)`);
  summary.push('', 'This draft is advisory. Ordinary PR review decides whether the actual effects need New, Fixed or Internal wording.');
  return { summary: summary.join('\n') + '\n', annotations };
}
function main(env = process.env) {
  const result = evaluate({ repository: env.CHANGELOG_REPOSITORY || REPOSITORY, headSha: env.CHANGELOG_HEAD_SHA, baseSha: env.CHANGELOG_BASE_SHA || undefined, workspace: env.CHANGELOG_WORKSPACE || process.cwd() });
  const output = render(result);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, output.summary);
  else process.stdout.write(output.summary);
  for (const annotation of output.annotations) process.stdout.write(annotation + '\n');
  return 0; // Diagnostic only; enabling a gate is a separate decision.
}
if (require.main === module) process.exitCode = main();
module.exports = { readChangelog, evaluate, render, main };
