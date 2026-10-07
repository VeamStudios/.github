'use strict';

// Collect Git objects as data. Never load configuration, hooks, filters or code
// from the reviewed branch, and never call an assessment provider here.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const SHA = /^[a-f0-9]{40}$/;
const DEFAULT_LIMITS = { files: 1000, fileBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, fileLines: 100000 };
const POLICY = 'sap-changelogs-coverage-v1';
class CoverageInputError extends Error { constructor(message) { super(message); this.name = 'CoverageInputError'; } }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function lineCount(text) { return text ? text.replace(/\r\n/g, '\n').split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; }
function gitReader(cwd, limits) {
  return (...args) => {
    try {
      return execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
        cwd, maxBuffer: Math.max(limits.totalBytes * 2, 1024 * 1024),
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_EXTERNAL_DIFF: '', GIT_DIFF_OPTS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { throw new CoverageInputError('A required Git object or complete diff could not be read. Fetch the exact base and head, then rerun.'); }
  };
}
function safePath(path) {
  if (!path || path.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new CoverageInputError('An unsupported source path prevents complete assessment.');
  return path;
}
function utf8(buffer, label) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new CoverageInputError(`${label} is not valid UTF-8; no partial assessment was made.`); }
}
function changedLines(patch) {
  const base = [], head = [];
  for (const line of patch.split('\n')) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const [, b, bn = '1', h, hn = '1'] = match;
    for (let n = 0; n < Number(bn); n++) base.push(Number(b) + n);
    for (let n = 0; n < Number(hn); n++) head.push(Number(h) + n);
  }
  return { changedBaseLines: [...new Set(base)], changedHeadLines: [...new Set(head)] };
}
function collectInput({ cwd = process.cwd(), repository, headSha, baseSha, baseline, pr = {}, limits: suppliedLimits = {}, readGit }) {
  if (repository !== REPOSITORY || !SHA.test(headSha || '') || !SHA.test(baseSha || '')) throw new CoverageInputError('Coverage pilot needs the SAP iOS repository and exact 40-character base/head commits.');
  const limits = { ...DEFAULT_LIMITS, ...suppliedLimits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new CoverageInputError('Invalid collection limits.');
  if (pr.number != null && (!Number.isSafeInteger(pr.number) || pr.number < 1)) throw new CoverageInputError('Invalid PR identity.');
  const title = pr.title ?? '', body = pr.body ?? '';
  if (typeof title !== 'string' || title.length > 500 || typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 65536) throw new CoverageInputError('PR metadata is incomplete or exceeds the supported limit.');
  const links = require('./work-item-links').parseWorkItemLinks(body);
  const git = readGit || gitReader(cwd, limits);
  const raw = (...args) => { const result = git(...args); return Buffer.isBuffer(result) ? result : Buffer.from(result); };
  const str = (...args) => utf8(raw(...args), 'Git metadata');
  for (const sha of [headSha, baseSha]) if (str('rev-parse', '--verify', `${sha}^{commit}`).trim() !== sha) throw new CoverageInputError('An exact requested commit is unavailable.');
  const mergeBases = str('merge-base', '--all', baseSha, headSha).trim().split('\n');
  if (mergeBases.length !== 1 || !SHA.test(mergeBases[0])) throw new CoverageInputError('The PR has no unique merge base; refresh the branch before assessment.');
  const mergeBaseSha = mergeBases[0];
  const fields = str('diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', mergeBaseSha, headSha, '--').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  while (fields.length) {
    const status = fields.shift();
    if (!/^(?:[AMDT]|R\d+)$/.test(status)) throw new CoverageInputError('An unsupported diff status prevents complete assessment.');
    const basePath = safePath(fields.shift());
    const headPath = status.startsWith('R') ? safePath(fields.shift()) : basePath;
    changes.push({ status, path: headPath, basePath, headPath });
  }
  if (changes.length > limits.files) throw new CoverageInputError('The complete changed-file set exceeds the pilot limit; no files were silently omitted.');
  let totalBytes = 0;
  function blob(ref, path, absent = false) {
    if (absent) return { text: '', mode: null, bytes: 0, binary: false };
    const tree = str('ls-tree', '-z', ref, '--', path);
    const record = tree.match(/^([0-7]{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/);
    if (!record || record[3] !== path) throw new CoverageInputError('A required source blob is missing or unsupported (for example, a submodule).');
    const size = Number(str('cat-file', '-s', record[2]).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.fileBytes) throw new CoverageInputError('A required source blob exceeds the pilot limit.');
    totalBytes += size;
    if (totalBytes > limits.totalBytes) throw new CoverageInputError('Complete source evidence exceeds the pilot byte limit.');
    const content = raw('cat-file', 'blob', record[2]);
    if (content.length !== size) throw new CoverageInputError('Source blob size changed or is incomplete.');
    let text = null;
    if (!content.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); } catch {} }
    return { text, mode: record[1], bytes: size, binary: text === null, blob: record[2] };
  }
  const files = changes.map(change => {
    const before = blob(mergeBaseSha, change.basePath, change.status === 'A');
    const after = blob(headSha, change.headPath, change.status === 'D');
    const binary = before.binary || after.binary;
    if (!binary && Math.max(lineCount(before.text), lineCount(after.text)) > limits.fileLines) throw new CoverageInputError('A required source exceeds the pilot line limit; no changed lines were silently omitted.');
    // Diff exact blobs, not pathspecs: a rename can also recreate its old path.
    // Force text for decoded text blobs so PR attributes cannot hide hunks.
    const changed = binary ? { changedBaseLines: [], changedHeadLines: [] }
      : !before.blob ? { changedBaseLines: [], changedHeadLines: Array.from({ length: lineCount(after.text) }, (_, i) => i + 1) }
      : !after.blob ? { changedBaseLines: Array.from({ length: lineCount(before.text) }, (_, i) => i + 1), changedHeadLines: [] }
      : changedLines(str('diff', '--text', '--unified=0', '--no-ext-diff', '--no-textconv', before.blob, after.blob));
    if (!binary && before.text !== after.text && !changed.changedBaseLines.length && !changed.changedHeadLines.length) throw new CoverageInputError('A changed text blob has no complete hunk evidence.');
    // Base-side citations refer to the merge base where PR changes originated.
    return { ...change, before: before.text, after: after.text, baseLines: binary ? null : lineCount(before.text), headLines: binary ? null : lineCount(after.text), ...changed, binary, mode: { base: before.mode, head: after.mode }, blobs: { base: before.blob || null, head: after.blob || null } };
  });
  const headChangelog = blob(headSha, 'CHANGELOG.md');
  const baseChangelog = blob(baseSha, 'CHANGELOG.md');
  if (headChangelog.binary || baseChangelog.binary) throw new CoverageInputError('CHANGELOG.md must be readable UTF-8 text.');
  const { eligibleEntries } = require('./coverage-baseline');
  const eligibility = eligibleEntries(headChangelog.text, baseline);
  const input = {
    schemaVersion: 1, policy: POLICY, repository, headSha, baseSha, mergeBaseSha,
    staleBase: baseSha !== mergeBaseSha, complete: true, files,
    pr: { number: pr.number ?? null, title, body, workItems: links.ids, invalidWorkItemEntries: links.invalidEntries },
    baseline: { repository: baseline.repository, target: baseline.target, version: baseline.version, build: baseline.build, commit: baseline.commit, blob: baseline.blob, releaseId: baseline.releaseId, manifestHash: baseline.manifestHash, inspectedAt: baseline.inspectedAt, verification: baseline.verification, scopeLimitations: baseline.scopeLimitations },
    changelog: { head: headChangelog.text, base: baseChangelog.text },
    eligibleEntries: eligibility.entries.map(entry => ({ ...entry, path: 'CHANGELOG.md', lineStart: entry.startLine, lineEnd: entry.endLine })),
    excludedEntries: eligibility.excludedEntries,
    reviewNotes: eligibility.reviewNotes,
  };
  input.digest = digest(input);
  return input;
}
module.exports = { collectInput, changedLines, canonical, digest, CoverageInputError, DEFAULT_LIMITS, REPOSITORY };
