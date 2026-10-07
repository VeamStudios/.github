// Validate evidence and render results; this module does not assess code semantics.
'use strict';

const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const OUTCOMES = new Set(['pass', 'missing_note', 'review', 'error']);
const HEADINGS = new Set(['New', 'Fixed', 'Internal']);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const LIMITS = { findings: 50, sources: 20, text: 12000, range: 100 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function text(value, field, max = LIMITS.text) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw Error(`Invalid ${field}.`);
  }
  return value.trim();
}
function path(value) {
  text(value, 'source path', 1000);
  if (value !== value.trim() || /[\r\n\\]/.test(value) || value.startsWith('/') || /^[a-z]+:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('Invalid source path.');
  }
  return value;
}
function lines(content) {
  if (typeof content !== 'string') throw Error('Source text is unavailable.');
  if (!content) return [];
  const result = content.replace(/\r\n/g, '\n').split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}
function identity(input) {
  if (!record(input) || input.schemaVersion !== 1 || input.repository !== REPOSITORY || !SHA.test(input.headSha || '') || !SHA.test(input.baseSha || '') || !DIGEST.test(input.digest || '')) {
    throw Error('Invalid SAP iOS coverage input identity.');
  }
  if (has(input, 'mergeBaseSha') && !SHA.test(input.mergeBaseSha || '')) throw Error('Invalid exact merge-base source identity.');
}
function failure(input, reason) {
  return {
    schemaVersion: 1,
    repository: input?.repository === REPOSITORY ? REPOSITORY : '',
    headSha: SHA.test(input?.headSha || '') ? input.headSha : '',
    baseSha: SHA.test(input?.baseSha || '') ? input.baseSha : '',
    digest: DIGEST.test(input?.digest || '') ? input.digest : '',
    outcome: 'error',
    reason: `Changelog assessment could not be validated. ${reason} Rerun after repairing the input or assessor configuration. No missing changelog entry is inferred.`,
    findings: [],
  };
}

// The trusted collector supplies exact changed-line sets. Assessor claims cannot
// replace this evidence, and a missing diff fails rather than guessing from paths.
function changedLines(file) {
  const before = lines(file.before), after = lines(file.after);
  for (const [key, count] of [['baseLines', before.length], ['headLines', after.length]]) {
    if (has(file, key) && (!Number.isSafeInteger(file[key]) || file[key] !== count)) throw Error('Source line counts differ from supplied text.');
  }
  const read = (key, count) => {
    const values = file[key];
    if (!Array.isArray(values) || values.some(line => !Number.isSafeInteger(line) || line < 1 || line > count) || new Set(values).size !== values.length) throw Error('Invalid or unavailable changed-line evidence.');
    return new Set(values);
  };
  return { base: read('changedBaseLines', before.length), head: read('changedHeadLines', after.length), before, after };
}

function validateAssessment(result, input) {
  try {
    identity(input);
    if (!record(result) || result.schemaVersion !== input.schemaVersion || result.repository !== input.repository || result.headSha !== input.headSha || result.baseSha !== input.baseSha || result.digest !== input.digest) {
      throw Error('Assessment identity or input digest is stale or mismatched.');
    }
    if (!OUTCOMES.has(result.outcome)) throw Error('Unsupported assessment outcome.');
    if (result.outcome !== 'error' && input.complete !== true) throw Error('Complete input collection has not been established.');
    const reason = text(result.reason, 'assessment reason');
    if (!Array.isArray(result.findings) || result.findings.length > LIMITS.findings) throw Error('Invalid assessment findings.');
    const eligibleEntries = input.eligibleEntries;
    if (!Array.isArray(input.files) || !Array.isArray(eligibleEntries)) throw Error('Coverage evidence is unavailable.');
    const files = new Map(), entries = new Map(), diffs = new Map();
    for (const file of input.files) {
      if (!record(file) || files.has(path(file.path))) throw Error('Duplicate or invalid source evidence.');
      files.set(file.path, file);
    }
    for (const entry of eligibleEntries) {
      if (!record(entry) || typeof entry.id !== 'string' || !entry.id || entries.has(entry.id) || entry.path !== 'CHANGELOG.md' || !Number.isSafeInteger(entry.lineStart) || !Number.isSafeInteger(entry.lineEnd) || entry.lineStart < 1 || entry.lineEnd < entry.lineStart || entry.eligible === false) {
        throw Error('Invalid eligible changelog entry evidence.');
      }
      text(entry.version, 'entry version', 200);
      text(entry.heading, 'entry heading', 200);
      text(entry.summary, 'entry wording');
      entries.set(entry.id, entry);
    }
    const findings = result.findings.map(finding => {
      if (!record(finding)) throw Error('Invalid finding.');
      const effect = text(finding.effect, 'change effect');
      if (!Array.isArray(finding.sources) || finding.sources.length > LIMITS.sources) throw Error('Invalid source citations.');
      const sources = finding.sources.map(source => {
        if (!record(source) || !['head', 'base'].includes(source.side) || !Number.isSafeInteger(source.lineStart) || !Number.isSafeInteger(source.lineEnd) || source.lineStart < 1 || source.lineEnd < source.lineStart || source.lineEnd - source.lineStart >= LIMITS.range) throw Error('Invalid source line range.');
        const file = files.get(path(source.path));
        if (!file || file.binary) throw Error('Cited source file is unavailable or binary.');
        if (!diffs.has(file.path)) diffs.set(file.path, changedLines(file));
        const diff = diffs.get(file.path), supplied = source.side === 'head' ? diff.after : diff.before;
        if (source.lineEnd > supplied.length) throw Error('Cited source lines are outside supplied evidence.');
        const cited = supplied.slice(source.lineStart - 1, source.lineEnd).join('\n');
        if (has(source, 'snippet') && (typeof source.snippet !== 'string' || source.snippet.replace(/\r\n/g, '\n') !== cited)) throw Error('Source snippet differs from the cited lines.');
        let changed = false;
        for (let line = source.lineStart; line <= source.lineEnd; line++) if (diff[source.side].has(line)) changed = true;
        if (!changed) throw Error('Source citation does not intersect actual changed lines.');
        const refPath = source.side === 'base' ? file.basePath ?? file.path : file.headPath ?? file.path;
        path(refPath);
        const refSha = source.side === 'base' ? input.mergeBaseSha || input.baseSha : input.headSha;
        return { path: file.path, refPath, refSha, side: source.side, lineStart: source.lineStart, lineEnd: source.lineEnd, ...(has(source, 'snippet') ? { snippet: source.snippet } : {}) };
      });
      const normalized = { effect, sources };
      if (has(finding, 'entryId')) {
        if (typeof finding.entryId !== 'string' || !entries.has(finding.entryId)) throw Error('Cited changelog entry is not eligible at the assessed head.');
        normalized.entryId = finding.entryId;
      }
      if (has(finding, 'heading')) {
        if (!HEADINGS.has(finding.heading)) throw Error('Unsupported suggested changelog heading.');
        normalized.heading = finding.heading;
      }
      if (has(finding, 'correction')) normalized.correction = text(finding.correction, 'author correction');
      if (result.outcome === 'missing_note') {
        if (!sources.some(source => source.path !== 'CHANGELOG.md')) throw Error('Missing-note finding has no cited changed effect outside CHANGELOG.md.');
        if (!normalized.heading || !normalized.correction || !/\bCHANGELOG\.md\b/.test(normalized.correction)) throw Error('Missing-note finding lacks a heading and CHANGELOG.md correction.');
      }
      return normalized;
    });
    if (result.outcome === 'missing_note' && !findings.length) throw Error('Missing-note assessment has no specific supported finding.');
    if (result.outcome === 'error' && findings.length) throw Error('Execution errors cannot contain missing-note findings.');
    return { schemaVersion: 1, repository: input.repository, headSha: input.headSha, baseSha: input.baseSha, digest: input.digest, outcome: result.outcome, reason, findings };
  } catch (error) {
    return failure(input, error.message);
  }
}

const clean = value => String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');
const markdown = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1');
const commandData = value => clean(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const commandProperty = value => commandData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
function annotation(level, message, source) {
  const result = { level, message: clean(message), ...(source ? { path: source.path, lineStart: source.lineStart, lineEnd: source.lineEnd } : {}) };
  const properties = source ? ` file=${commandProperty(source.path)},line=${source.lineStart},endLine=${source.lineEnd}` : '';
  result.command = `::${level}${properties}::${commandData(message)}`;
  return result;
}
function sourceLink(source, input) {
  const sha = source.refSha || (source.side === 'head' ? input.headSha : input.mergeBaseSha || input.baseSha);
  const encoded = (source.refPath ?? source.path).split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `[${markdown(source.path)}:${source.lineStart}${source.side === 'base' ? ' (base)' : ''}](https://github.com/${REPOSITORY}/blob/${sha}/${encoded}#L${source.lineStart}${source.lineEnd !== source.lineStart ? `-L${source.lineEnd}` : ''})`;
}
function renderAssessment(result, input) {
  const value = validateAssessment(result, input);
  const title = { pass: 'Covered or exempt', missing_note: 'Missing changelog coverage', review: 'Reviewer assessment needed', error: 'Assessment execution problem' }[value.outcome];
  const summary = ['## Changelogs coverage', '', `**${title}**`, '', markdown(value.reason), '', `Assessed head: ${markdown(value.headSha || 'unavailable')}`, `Input digest: ${markdown(value.digest || 'unavailable')}`, ''];
  const annotations = [];
  if (value.outcome === 'error') annotations.push(annotation('error', value.reason));
  if (value.outcome === 'review') annotations.push(annotation('notice', value.reason));
  for (const finding of value.findings) {
    summary.push(`- ${markdown(finding.effect)}`);
    if (finding.sources.length) summary.push(`  Source: ${finding.sources.map(source => sourceLink(source, value)).join(', ')}`);
    if (finding.entryId) {
      const entry = input.eligibleEntries.find(entry => entry.id === finding.entryId);
      summary.push(`  Existing eligible entry: ${sourceLink({ path: 'CHANGELOG.md', side: 'head', lineStart: entry.lineStart, lineEnd: entry.lineEnd }, value)}`);
    }
    if (finding.heading) summary.push(`  Suggested heading: ${finding.heading}`);
    if (finding.correction) summary.push(`  Author correction: ${markdown(finding.correction)}`);
    if (value.outcome === 'missing_note') {
      // GitHub annotates files at the head. Deleted-line evidence links to the
      // base in the summary, so it must not be misattached to another head line.
      const head = finding.sources.find(source => source.side === 'head');
      annotations.push(annotation('error', `${finding.effect} ${finding.correction}`, head));
    }
    summary.push('');
  }
  if (value.headSha) summary.push(`[Review CHANGELOG.md at the assessed head](https://github.com/${REPOSITORY}/blob/${value.headSha}/CHANGELOG.md)`, '');
  summary.push('This validates result structure and source references; it does not establish semantic accuracy. Ordinary PR review approves wording.');
  return { result: value, summary: summary.join('\n'), annotations };
}
function exitCode(result, mode = 'pilot') {
  if (!['pilot', 'enforce'].includes(mode)) throw Error('Unknown changelog assessment mode.');
  if (!record(result) || !OUTCOMES.has(result.outcome)) return mode === 'enforce' ? 1 : 0;
  return mode === 'enforce' && ['missing_note', 'error'].includes(result.outcome) ? 1 : 0;
}

module.exports = { validateAssessment, renderAssessment, exitCode };
