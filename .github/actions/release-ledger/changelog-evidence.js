'use strict';

const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {TextDecoder} = require('node:util');
const {validateChangelog} = require('./changelog-format');

// These bounds apply to the complete input, not a truncated selection of files.
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 4096;
const MAX_CHANGELOG_LINE_BYTES = 4096;
const SHA = /^[a-f0-9]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const FORMATS = new Set(['categorized', 'flat', 'components']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

class EvidenceError extends Error {
  constructor(code, message) { super(message); this.name = 'EvidenceError'; this.code = code; }
}
const fail = (code, message) => { throw new EvidenceError(code, message); };
const label = value => JSON.stringify(value);

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) fail('invalid_evidence', 'Evidence must be complete, acyclic JSON data.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => canonical(item, ancestors));
  else result = Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, canonical(value[key], ancestors)]));
  ancestors.delete(value);
  return result;
}

// Bind the assessment to every supplied field; only the digest itself is omitted.
function evidenceDigest(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail('invalid_evidence', 'Evidence must be a JSON object.');
  const content = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'digest'));
  return createHash('sha256').update(JSON.stringify(canonical(content)), 'utf8').digest('hex');
}

function configuration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('configuration', 'Provide trusted changelog evidence configuration.');
  const {cwd = process.cwd(), repository, head, base, releaseCommit, releaseCommits, changelogPaths, changelogFormat = 'categorized'} = input;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) ||
      typeof repository !== 'string' || !/^VeamStudios\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      typeof head !== 'string' || typeof base !== 'string' || !SHA.test(head) || !SHA.test(base)) {
    fail('configuration', 'Provide an absolute workspace, supported VeamStudios repository and full exact head/base commit hashes.');
  }
  if (releaseCommit !== undefined && (typeof releaseCommit !== 'string' || !SHA.test(releaseCommit) || releaseCommit === ZERO_SHA)) fail('configuration', 'Provide a full verified release commit hash.');
  if (releaseCommits !== undefined && (!Array.isArray(releaseCommits) || releaseCommits.length < 1 || releaseCommits.length > 8 ||
      releaseCommits.some(commit => typeof commit !== 'string' || !SHA.test(commit) || commit === ZERO_SHA) ||
      (releaseCommit !== undefined && !releaseCommits.includes(releaseCommit)))) {
    fail('configuration', 'Provide one to eight verified release commit hashes; the singular release commit must belong to that list.');
  }
  const commits = releaseCommits === undefined ? (releaseCommit === undefined ? [] : [releaseCommit]) : [...new Set(releaseCommits)].sort(compare);
  if (!commits.length) fail('missing_baseline', 'A verified release baseline is required; no release commit was supplied.');
  if (!Array.isArray(changelogPaths) || changelogPaths.length < 1 || changelogPaths.length > 64 ||
      new Set(changelogPaths).size !== changelogPaths.length || changelogPaths.some(value => typeof value !== 'string' || value.length > 256 ||
        !/^(?:[A-Za-z0-9_.-]+\/)*CHANGELOG\.md$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) || !FORMATS.has(changelogFormat)) {
    fail('configuration', 'Provide distinct exact maintained CHANGELOG.md paths and a supported explicit changelog format.');
  }
  return {cwd, repository, head, base, releaseCommit: releaseCommit ?? commits[0], commits,
    includeReleaseCommits: releaseCommits !== undefined, changelogPaths: [...changelogPaths].sort(compare), changelogFormat};
}

function reader(cwd) {
  // Never inherit Git command/config overrides, alternate workspaces, external
  // diff/textconv helpers, replace objects or automatic partial-clone fetching.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'});
  let consumed = 0;
  const cache = new Map();
  function reserve(size, context) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_INPUT_BYTES - consumed) {
      fail('input_limit', `Complete changelog evidence exceeds the ${MAX_INPUT_BYTES}-byte input bound (${context}); no input was truncated.`);
    }
    consumed += size;
  }
  function git(args, context) {
    try {
      return execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', '--no-replace-objects',
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
        '-c', 'diff.external=', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', ...args],
      {cwd, env, maxBuffer: MAX_INPUT_BYTES + 1, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (error) {
      if (error.code === 'ENOBUFS') fail('input_limit', 'Complete Git evidence exceeds the input bound; no input was truncated.');
      fail('unavailable_git_object', `${context} could not be read completely from local Git objects; fetch the exact trusted commits and rerun.`);
    }
  }
  function decode(bytes, context) {
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
    catch { fail('invalid_utf8', `${context} is not complete valid UTF-8 text.`); }
    return text;
  }
  function commit(sha, role) {
    const found = decode(git(['rev-parse', '--verify', `${sha}^{commit}`], `${role} commit`), `${role} commit`).trim();
    if (found !== sha) fail('invalid_commit', `${role} must identify the exact full commit, without peeling another object.`);
  }
  function ancestor(sha, base) {
    git(['merge-base', '--is-ancestor', sha, base], 'Exact commit ancestry');
  }
  function blob(sha, mode, context) {
    if (!['100644', '100755'].includes(mode) || !SHA.test(sha) || sha === ZERO_SHA) {
      fail('unsupported_file', `${context} must be a tracked regular Git blob; symlinks and submodules cannot be assessed.`);
    }
    if (cache.has(sha)) return cache.get(sha);
    const rawSize = decode(git(['cat-file', '-s', sha], context), context).trim();
    if (!/^(?:0|[1-9]\d*)$/.test(rawSize)) fail('incomplete_blob', `${context} has an invalid Git blob size.`);
    const size = Number(rawSize);
    reserve(size, context);
    const bytes = git(['cat-file', 'blob', sha], context);
    if (bytes.length !== size) fail('incomplete_blob', `${context} was not read completely; no input was truncated.`);
    const text = decode(bytes, context);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('binary_file', `${context} contains binary control bytes and cannot be assessed as text.`);
    cache.set(sha, text);
    return text;
  }
  function changelog(sha, filePath) {
    const bytes = git(['ls-tree', '-z', sha, '--', filePath], `Changelog ${label(filePath)} at ${sha}`);
    reserve(bytes.length, 'changelog tree metadata');
    const record = decode(bytes, 'Changelog tree metadata');
    const match = record.match(/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/);
    if (!match || match[3] !== filePath) fail('missing_changelog', `Changelog ${label(filePath)} is missing or is not a regular blob at ${sha}; complete release history is required.`);
    return blob(match[2], match[1], `Changelog ${label(filePath)} at ${sha}`);
  }
  function changedFiles(base, head) {
    // Disable rename inference: a rename is a full deletion plus addition, so
    // both paths and both complete blobs remain visible in this fixed schema.
    const bytes = git(['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', base, head, '--'], 'Complete exact-commit diff');
    reserve(bytes.length, 'complete diff metadata');
    const raw = decode(bytes, 'Complete diff metadata');
    const parts = raw ? raw.split('\0') : [];
    if (parts.length && parts.pop() !== '') fail('incomplete_diff', 'The exact-commit diff is incomplete.');
    if (parts.length % 2 || parts.length / 2 > MAX_CHANGED_FILES) fail('input_limit', 'Complete diff exceeds the supported file bound or has incomplete records; no files were omitted.');
    const files = [], seen = new Set();
    for (let index = 0; index < parts.length; index += 2) {
      const match = parts[index].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/);
      const filePath = parts[index + 1];
      if (!match || !filePath || filePath.startsWith('/') || filePath.split('/').some(part => !part || part === '.' || part === '..') || seen.has(filePath)) {
        fail('incomplete_diff', 'The exact-commit diff has unsupported or incomplete tracked-file records.');
      }
      seen.add(filePath);
      const [, beforeMode, afterMode, beforeSha, afterSha, status] = match;
      const beforeMissing = beforeMode === '000000' && beforeSha === ZERO_SHA;
      const afterMissing = afterMode === '000000' && afterSha === ZERO_SHA;
      if ((status === 'A' && (!beforeMissing || afterMissing)) || (status === 'D' && (!afterMissing || beforeMissing)) ||
          (['M', 'T'].includes(status) && (beforeMissing || afterMissing))) fail('incomplete_diff', 'The exact-commit diff has contradictory file identities.');
      if (['100644', '100755'].includes(beforeMode) && ['100644', '100755'].includes(afterMode) && beforeMode !== afterMode) {
        fail('unsupported_permission_change', `File ${label(filePath)} changes executable permissions, which the text-only evidence schema cannot represent. No coverage was assessed; review that permission change separately.`);
      }
      files.push({path: filePath, status,
        before: beforeMissing ? null : blob(beforeSha, beforeMode, `Before file ${label(filePath)}`),
        after: afterMissing ? null : blob(afterSha, afterMode, `After file ${label(filePath)}`)});
    }
    return files.sort((a, b) => compare(a.path, b.path));
  }
  return {commit, ancestor, changelog, changedFiles};
}

function parse(text, filePath, format) {
  // Bound legacy link-parser work on a single uninterrupted token. A source
  // line over this limit is an input error, never shortened for assessment.
  if (text.split(/\r?\n/).some(line => Buffer.byteLength(line, 'utf8') > MAX_CHANGELOG_LINE_BYTES)) {
    fail('input_limit', `Changelog ${label(filePath)} exceeds the ${MAX_CHANGELOG_LINE_BYTES}-byte complete source-line bound; no line was truncated.`);
  }
  try { return validateChangelog(text, {format}); }
  catch (error) {
    if (error.code === 'invalid_changelog') {
      if (error.details?.ref) error.details.ref.path = filePath;
      throw error;
    }
    fail('invalid_changelog', `Changelog ${label(filePath)} could not be parsed completely.`);
  }
}

function versionCompare(left, right, kind) {
  const a = kind === 'deployment' ? [Number(left.slice(7))] : left.split('.').map(Number);
  const b = kind === 'deployment' ? [Number(right.slice(7))] : right.split('.').map(Number);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

// Metadata, bullet style, case and whitespace changes cannot make the same
// shipped wording new. This is exact normalized identity, not semantic matching.
const noteIdentity = entry => entry.summary.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const historyIdentity = entry => JSON.stringify(canonical({version: entry.version, text: noteIdentity(entry),
  flagKeys: [...entry.flagKeys].sort(compare), previewTag: entry.previewTag}));

function shippedSection(section, frontiers, identities) {
  const frontier = frontiers.get(section.versionKind);
  return section.versionKind !== 'unreleased' && (identities.has(`${section.versionKind}:${section.version}`) ||
    Boolean(frontier && versionCompare(section.version, frontier, section.versionKind) <= 0));
}

function preserveShippedHistory(before, after, filePath, frontiers, identities, releasedUnreleasedNotes) {
  const sections = new Map(before.sections.map(section => [section.version, section]));
  const remaining = new Map();
  for (const entry of after.entries) {
    const key = historyIdentity(entry); remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  for (const entry of before.entries) {
    const section = sections.get(entry.version);
    // A duplicate of shipped wording added later under an upcoming numbered
    // version was never published in that section and may still be removed.
    const published = shippedSection(section, frontiers, identities) ||
      section.versionKind === 'unreleased' && releasedUnreleasedNotes.has(noteIdentity(entry));
    if (!published) continue;
    const key = historyIdentity(entry), count = remaining.get(key) || 0;
    if (!count) fail('published_history_change', `Published changelog entry at ${label(filePath)}:${entry.startLine} was edited, moved to another version or removed by this PR. Preserve the wording and release metadata already on the base branch; use the existing explicit amendment process for published history.`);
    remaining.set(key, count - 1);
  }
}

function collectEvidence(input) {
  const config = configuration(input);
  const git = reader(config.cwd);
  git.commit(config.head, 'Head'); git.commit(config.base, 'Base');
  // A two-tree diff from a stale/diverged PR omits current base behavior from
  // the head and can blame the PR for unrelated main changes. Require refresh
  // rather than asking the assessor to judge that incomplete combined state.
  try { git.ancestor(config.base, config.head); }
  catch { fail('stale_base', 'Exact PR head must contain the current base commit and complete ancestry. Update the PR branch, fetch both exact histories and rerun; no changelog coverage was assessed.'); }
  // Distribution is proved by the trusted caller's ledger evidence, not by
  // Git ancestry. A released PR source can be squash-merged onto main without
  // its commit becoming an ancestor. Keep its exact source and changelog;
  // substituting the squash commit could classify unshipped main notes as live.
  for (const commit of config.commits) git.commit(commit, 'Release');
  const files = git.changedFiles(config.base, config.head);
  const releasedNotes = new Set(), releasedFrontiers = new Map(), releasedSections = new Map(), releasedUnreleasedNotes = new Map();
  for (const filePath of config.changelogPaths) {
    const frontiers = new Map(), identities = new Set(), unreleasedNotes = new Set();
    for (const commit of config.commits) {
      const released = parse(git.changelog(commit, filePath), filePath, config.changelogFormat);
      // The caller proves distribution of this exact source. Even a note left
      // under Unreleased in that source cannot be assumed to be unshipped.
      for (const entry of released.entries) {
        releasedNotes.add(noteIdentity(entry));
        if (entry.version === 'Unreleased') unreleasedNotes.add(noteIdentity(entry));
      }
      for (const section of released.sections) {
        if (section.versionKind === 'unreleased') continue;
        identities.add(`${section.versionKind}:${section.version}`);
        const frontier = frontiers.get(section.versionKind);
        if (!frontier || versionCompare(section.version, frontier, section.versionKind) > 0) frontiers.set(section.versionKind, section.version);
      }
    }
    releasedFrontiers.set(filePath, frontiers); releasedSections.set(filePath, identities); releasedUnreleasedNotes.set(filePath, unreleasedNotes);
  }
  const entries = [];
  for (const filePath of config.changelogPaths) {
    const text = git.changelog(config.head, filePath);
    const parsed = parse(text, filePath, config.changelogFormat), lines = text.split(/\r?\n/);
    const onBase = parse(git.changelog(config.base, filePath), filePath, config.changelogFormat);
    preserveShippedHistory(onBase, parsed, filePath, releasedFrontiers.get(filePath), releasedSections.get(filePath), releasedUnreleasedNotes.get(filePath));
    const sections = new Map(parsed.sections.map(section => [section.version, section]));
    for (const entry of parsed.entries) {
      const section = sections.get(entry.version);
      const shipped = shippedSection(section, releasedFrontiers.get(filePath), releasedSections.get(filePath));
      entries.push({id: `${filePath}:${entry.startLine}`, path: filePath, line: entry.startLine,
        heading: [section.version, entry.component, entry.heading, entry.group].filter(Boolean).join(' / '),
        text: lines.slice(entry.startLine - 1, entry.endLine).join('\n'),
        eligible: !shipped && !releasedNotes.has(noteIdentity(entry))});
    }
  }
  const evidence = {schemaVersion: 1, repository: config.repository, head: config.head, base: config.base, releaseCommit: config.releaseCommit,
    ...(config.includeReleaseCommits ? {releaseCommits: config.commits} : {}), files, entries};
  evidence.digest = evidenceDigest(evidence);
  if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_INPUT_BYTES) fail('input_limit', 'Complete serialized changelog evidence exceeds the input bound; no source or entries were truncated.');
  return evidence;
}

module.exports = {EvidenceError, collectEvidence, evidenceDigest, MAX_INPUT_BYTES};
