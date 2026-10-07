'use strict';

// Deterministic format/link diagnostics only. Git blobs are data: no PR code,
// filters, external diff tools, provider calls or release credentials are used.
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const fs = require('node:fs');
const REPOSITORY = /^VeamStudios\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const FORMATS = new Set(['categorized', 'flat', 'components']);
const validPath = value => typeof value === 'string' && value.length <= 256 && /^(?:[A-Za-z0-9_.-]+\/)*CHANGELOG\.md$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
function readChangelog({ workspace = process.cwd(), repository, headSha, baseSha, changelogPath = 'CHANGELOG.md' }) {
  if (!REPOSITORY.test(repository || '') || !SHA.test(headSha || '') || (baseSha !== undefined && !SHA.test(baseSha))) throw Error('Format diagnostics need a supported VeamStudios repository and exact PR commit identifiers.');
  if (!validPath(changelogPath)) throw Error('Format diagnostics need an explicit relative CHANGELOG.md path without traversal or glob patterns.');
  const git = (...args) => execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workspace, maxBuffer: MAX_BYTES + 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bytes;
  try {
    if (git('rev-parse', '--verify', `${headSha}^{commit}`).toString('utf8').trim() !== headSha) throw Error('Exact head mismatch.');
    const tree = git('ls-tree', '-z', headSha, '--', changelogPath).toString('utf8');
    const match = tree.match(/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/);
    if (!match || match[3] !== changelogPath) throw Error(`${changelogPath} is missing or is not a regular file at this head.`);
    const size = Number(git('cat-file', '-s', match[2]).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw Error(`${changelogPath} exceeds the supported complete-input limit.`);
    bytes = git('cat-file', 'blob', match[2]);
    if (bytes.length !== size) throw Error('The complete changelog blob could not be read.');
  } catch (error) {
    if (error.message.startsWith(changelogPath) || error.message === 'The complete changelog blob could not be read.') throw error;
    throw Error('The exact PR changelog Git object could not be read. Fetch the reviewed head and rerun.');
  }
  if (bytes.includes(0)) throw Error(`${changelogPath} contains binary data and could not be checked.`);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error(`${changelogPath} is not complete UTF-8 text and could not be checked.`); }
}
function evaluate({ repository, headSha, baseSha, workspace, changelogPath = 'CHANGELOG.md', format = 'categorized', read = readChangelog }) {
  const identity = { repository, headSha, changelogPath, format };
  let source;
  try {
    if (!FORMATS.has(format)) throw Error('The shared check needs a supported categorized, flat or components changelog format.');
    source = read({ repository, headSha, baseSha, workspace, changelogPath });
  }
  catch (error) { return { ...identity, status: 'error', message: error.message, entries: [], sections: [] }; }
  try {
    const { validateChangelog } = require('./changelog-format');
    const parsed = validateChangelog(source, { format });
    return { ...identity, status: 'valid', entries: parsed.entries, sections: parsed.sections };
  } catch (error) {
    if (error.name !== 'ChangelogFormatError') return { ...identity, status: 'error', message: 'The format validator could not execute. Repair the shared check configuration and rerun.', entries: [], sections: [] };
    const line = error.details?.ref?.startLine ?? error.line;
    return { ...identity, status: error.details?.rule === 'input' ? 'error' : 'invalid', message: error.message, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), entries: [], sections: [] };
  }
}
const clean = value => String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');
const markdown = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1');
const command = value => clean(value).replace(/%/g, '%25');
const policy = ['', '**Code-to-wording coverage: not assessed.**', '', 'These diagnostic rules do not decide whether a change needs a note, whether wording covers code, whether a release shipped, or whether a linked page/PR exists. No new entry is required merely because this PR exists.', '', 'These diagnostics are advisory. Ordinary PR review decides whether the actual effects need changelog wording under the repository\'s release policy.'];
function render(result, { includePolicy = true } = {}) {
  const summary = includePolicy ? ['## Changelogs — format and links', ''] : [];
  const annotations = [];
  const changelogPath = result.changelogPath === undefined ? 'CHANGELOG.md' : validPath(result.changelogPath) ? result.changelogPath : undefined;
  if (changelogPath) summary.push(`${includePolicy ? 'File:' : '###'} \`${changelogPath}\``, '');
  if (result.status === 'valid') {
    const workItems = result.entries.reduce((n, entry) => n + entry.workItems.length, 0);
    const prs = result.entries.reduce((n, entry) => n + entry.prRefs.length, 0);
    summary.push('**Format and explicit link syntax: valid.**', '', `${result.entries.length} entries parsed; ${workItems} Work Item references and ${prs} source PR references syntax-checked.`);
  } else {
    const title = result.status === 'invalid' ? 'Changelog format or link issue' : 'Changelog could not be checked';
    const correction = result.status === 'invalid' ? `Correct the indicated structure or link in ${changelogPath || 'the configured changelog'}.` : 'Repair the readable exact-head input, then rerun.';
    summary.push(`**${title}.**`, '', markdown(result.message), '', correction);
    annotations.push(`::warning${result.line && changelogPath ? ` file=${changelogPath},line=${result.line}` : ''}::${command(result.message)} ${correction}`);
  }
  if (changelogPath && SHA.test(result.headSha || '') && REPOSITORY.test(result.repository || '')) summary.push('', `[Review ${changelogPath} at this head](https://github.com/${result.repository}/blob/${result.headSha}/${changelogPath})`);
  if (includePolicy) summary.push(...policy);
  return { summary: summary.join('\n') + '\n', annotations };
}
function main(env = process.env) {
  const config = { repository: env.CHANGELOG_REPOSITORY || env.GITHUB_REPOSITORY, headSha: env.CHANGELOG_HEAD_SHA, baseSha: env.CHANGELOG_BASE_SHA || undefined, workspace: env.CHANGELOG_WORKSPACE || process.cwd(), format: env.CHANGELOG_FORMAT || 'categorized' };
  const paths = (env.CHANGELOG_PATH === undefined ? 'CHANGELOG.md' : env.CHANGELOG_PATH).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const results = paths.length > 0 && paths.length <= 64 && new Set(paths).size === paths.length && paths.every(validPath)
    ? paths.map(changelogPath => evaluate({ ...config, changelogPath }))
    : [{ ...config, changelogPath: '', status: 'error', message: 'Configure 1–64 unique explicit relative CHANGELOG.md paths without traversal or glob patterns.', entries: [], sections: [] }];
  const writeSummary = value => env.GITHUB_STEP_SUMMARY ? fs.appendFileSync(env.GITHUB_STEP_SUMMARY, value) : process.stdout.write(value);
  if (results.length > 1) writeSummary('## Changelogs — format and links\n\n');
  for (const result of results) {
    const output = render(result, { includePolicy: results.length === 1 });
    writeSummary(output.summary + '\n');
    for (const annotation of output.annotations) process.stdout.write(annotation + '\n');
  }
  if (results.length > 1) writeSummary(policy.join('\n') + '\n');
  return 0; // Diagnostic only; enabling a gate is a separate decision.
}
if (require.main === module) process.exitCode = main();
module.exports = { readChangelog, evaluate, render, main };
