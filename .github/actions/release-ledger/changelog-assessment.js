'use strict';

// Validate the assessor's response, not the truth of its semantic judgment.
// The trusted collector owns complete blobs, release eligibility and the digest.
// Nothing in this module executes source text, makes requests or writes files.
const SHA = /^[a-f0-9]{40}$/;
const {evidenceDigest, MAX_INPUT_BYTES} = require('./changelog-evidence');
const DIGEST = /^[a-f0-9]{64}$/;
const REPOSITORY = /^VeamStudios\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const MAX_FILES = 4096;
const MAX_ENTRIES = 10000;
const MAX_FINDINGS = 256;
const MAX_REFERENCES = 64;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 50000;
const MAX_ASSESSMENT_BYTES = 1024 * 1024;
const BAD_UTF16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const OUTCOMES = new Set(['pass', 'missing_note', 'review']);
const DISPOSITIONS = new Set(['covered', 'exempt', 'missing', 'uncertain']);

class AssessmentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssessmentValidationError';
    this.code = 'invalid_changelog_assessment';
  }
}

function requireValid(condition, message) {
  if (!condition) throw new AssessmentValidationError(message);
}

function object(value, required, optional, label) {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be a JSON object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  requireValid(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && allowed.has(key) &&
    Object.hasOwn(descriptors[key], 'value')), `${label} contains unknown or non-JSON fields.`);
  requireValid(required.every(key => Object.hasOwn(descriptors, key)), `${label} is missing a required field.`);
}

function text(value, maximum, label) {
  requireValid(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !value.includes('\0') && !BAD_UTF16.test(value), `${label} must be nonempty bounded text.`);
}

function array(value, maximum, label) {
  requireValid(Array.isArray(value) && value.length <= maximum &&
    Object.getPrototypeOf(value) === Array.prototype &&
    Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index)), `${label} must be a bounded JSON array.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValid(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' &&
    (key === 'length' || /^(?:0|[1-9]\d*)$/.test(key)) && Object.hasOwn(descriptors[key], 'value')),
  `${label} contains unknown or non-JSON fields.`);
}

function path(value, label) {
  text(value, 512, label);
  requireValid(!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\]/.test(value) &&
    !value.startsWith('/') && !/^[A-Za-z]:/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `${label} must be a safe relative repository path.`);
}

function lineCount(source) {
  if (source === null || source === '') return 0;
  const lines = source.split(/\r?\n/);
  // A terminal newline does not create another source line.
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function validateEvidence(evidence) {
  object(evidence, ['schemaVersion', 'repository', 'head', 'base', 'releaseCommit', 'files', 'entries', 'digest'], ['releaseCommits'], 'Evidence');
  requireValid(evidence.schemaVersion === 1, 'Evidence uses an unsupported schema version.');
  requireValid(typeof evidence.repository === 'string' && REPOSITORY.test(evidence.repository), 'Evidence needs a supported repository.');
  for (const key of ['head', 'base', 'releaseCommit']) {
    requireValid(typeof evidence[key] === 'string' && SHA.test(evidence[key]) && evidence[key] !== '0'.repeat(40), `Evidence ${key} must be an exact commit identifier.`);
  }
  if (Object.hasOwn(evidence, 'releaseCommits')) {
    array(evidence.releaseCommits, 8, 'Evidence release commits');
    requireValid(evidence.releaseCommits.length > 0 && evidence.releaseCommits.every((commit, index) =>
      typeof commit === 'string' && SHA.test(commit) && commit !== '0'.repeat(40) && (index === 0 || evidence.releaseCommits[index - 1] < commit)) &&
      evidence.releaseCommits.includes(evidence.releaseCommit), 'Evidence release commits must be unique, sorted exact identifiers including the primary release commit.');
  }
  requireValid(typeof evidence.digest === 'string' && DIGEST.test(evidence.digest), 'Evidence needs a complete SHA-256 digest.');
  array(evidence.files, MAX_FILES, 'Evidence files');
  array(evidence.entries, MAX_ENTRIES, 'Evidence entries');
  const files = new Map(), entries = new Map(), sourceLines = new Map();
  let bytes = 0;
  for (const file of evidence.files) {
    object(file, ['path', 'status', 'before', 'after'], [], 'Evidence file');
    path(file.path, 'Evidence file path');
    text(file.status, 40, 'Evidence file status');
    requireValid(!files.has(file.path), 'Evidence contains duplicate file paths.');
    requireValid(file.before !== null || file.after !== null, 'An evidence file needs at least one source blob.');
    const counts = {};
    for (const side of ['before', 'after']) {
      const source = file[side];
      requireValid(source === null || typeof source === 'string', 'Evidence source blobs must be complete text or null.');
      counts[side] = lineCount(source);
      if (source !== null) {
        const size = Buffer.byteLength(source, 'utf8');
        requireValid(size <= MAX_BLOB_BYTES && !source.includes('\0') && !BAD_UTF16.test(source) && counts[side] <= MAX_LINES,
          'An evidence source blob exceeds the complete-input limit or contains invalid text.');
        bytes += size;
      }
    }
    requireValid(bytes <= MAX_TOTAL_BLOB_BYTES, 'Evidence exceeds the complete-input limit.');
    files.set(file.path, file);
    sourceLines.set(file.path, counts);
  }
  for (const entry of evidence.entries) {
    object(entry, ['id', 'path', 'line', 'heading', 'text', 'eligible'], [], 'Evidence entry');
    text(entry.id, 512, 'Evidence entry ID');
    path(entry.path, 'Evidence entry path');
    requireValid(Number.isSafeInteger(entry.line) && entry.line > 0 && entry.line <= MAX_LINES, 'An evidence entry needs a valid source line.');
    text(entry.heading, 160, 'Evidence entry heading');
    text(entry.text, 8000, 'Evidence entry text');
    requireValid(typeof entry.eligible === 'boolean', 'Evidence entry eligibility must be explicit.');
    requireValid(!entries.has(entry.id), 'Evidence contains duplicate entry IDs.');
    const file = files.get(entry.path);
    if (file) requireValid(entry.line <= sourceLines.get(entry.path).after, 'An evidence entry is not present at its supplied head line.');
    entries.set(entry.id, entry);
  }
  requireValid(Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= MAX_INPUT_BYTES,
    'Evidence exceeds the complete serialized input limit.');
  requireValid(evidence.digest === evidenceDigest(evidence), 'Evidence contents do not match the supplied digest.');
  return {files, entries, sourceLines};
}

/** Throws on invalid/stale responses; returns the original validated JSON object. */
function validateAssessment(evidence, assessment) {
  const {files, entries, sourceLines} = validateEvidence(evidence);
  object(assessment, ['schemaVersion', 'repository', 'head', 'base', 'evidenceDigest', 'outcome', 'findings'], [], 'Assessment');
  requireValid(assessment.schemaVersion === 1, 'Assessment uses an unsupported schema version.');
  requireValid(assessment.repository === evidence.repository && assessment.head === evidence.head &&
    assessment.base === evidence.base && assessment.evidenceDigest === evidence.digest,
  'Assessment is stale or does not match this repository, exact head, base and evidence digest.');
  requireValid(OUTCOMES.has(assessment.outcome), 'Assessment has an unsupported outcome.');
  array(assessment.findings, MAX_FINDINGS, 'Assessment findings');
  const represented = new Set();
  const hasSourceLines = evidence.files.some(file => sourceLines.get(file.path).before > 0 || sourceLines.get(file.path).after > 0);
  for (const finding of assessment.findings) {
    object(finding, ['effect', 'disposition', 'evidence', 'entryIds', 'reason'], ['correction', 'heading'], 'Assessment finding');
    text(finding.effect, 2000, 'Finding effect');
    text(finding.reason, 4000, 'Finding reason');
    requireValid(DISPOSITIONS.has(finding.disposition), 'Finding has an unsupported disposition.');
    array(finding.evidence, MAX_REFERENCES, 'Finding source references');
    array(finding.entryIds, MAX_REFERENCES, 'Finding entry IDs');
    requireValid(finding.evidence.length > 0 || (!hasSourceLines && ['exempt', 'uncertain'].includes(finding.disposition)),
      'A finding needs supporting supplied source lines.');
    const seenReferences = new Set();
    for (const ref of finding.evidence) {
      object(ref, ['path', 'side', 'line'], [], 'Finding source reference');
      requireValid(typeof ref.path === 'string' && files.has(ref.path), 'Finding refers to an unknown source file.');
      requireValid(ref.side === 'before' || ref.side === 'after', 'Finding refers to an unknown source side.');
      requireValid(Number.isSafeInteger(ref.line) && ref.line > 0 && ref.line <= sourceLines.get(ref.path)[ref.side],
        'Finding refers to a nonexistent source line.');
      const key = JSON.stringify([ref.path, ref.side, ref.line]);
      requireValid(!seenReferences.has(key), 'Finding contains duplicate source references.');
      seenReferences.add(key);
      represented.add(ref.path);
    }
    const seenEntries = new Set();
    for (const id of finding.entryIds) {
      requireValid(typeof id === 'string' && entries.has(id), 'Finding refers to an unknown changelog entry.');
      requireValid(entries.get(id).eligible, 'Finding cannot claim coverage from an ineligible or already shipped changelog entry.');
      requireValid(!seenEntries.has(id), 'Finding contains duplicate changelog entry IDs.');
      seenEntries.add(id);
    }
    if (finding.disposition === 'covered') requireValid(finding.entryIds.length > 0, 'A covered finding needs an eligible changelog entry.');
    if (['exempt', 'missing'].includes(finding.disposition)) requireValid(finding.entryIds.length === 0, 'An exempt or missing finding cannot claim entry coverage.');
    if (finding.disposition === 'missing') {
      text(finding.correction, 4000, 'Missing-note correction');
      text(finding.heading, 160, 'Missing-note heading');
    } else {
      requireValid(!Object.hasOwn(finding, 'correction') && !Object.hasOwn(finding, 'heading'),
        'Only a missing-note finding may prescribe a correction and heading.');
    }
  }
  requireValid(assessment.findings.length > 0 || evidence.files.length === 0,
    'Changed files cannot pass with an empty assessment.');
  const expected = assessment.findings.some(finding => finding.disposition === 'missing') ? 'missing_note' :
    assessment.findings.some(finding => finding.disposition === 'uncertain') ? 'review' : 'pass';
  requireValid(assessment.outcome === expected, 'Assessment outcome does not match its findings.');
  for (const file of evidence.files) {
    if (/(?:^|\/)CHANGELOG\.md$/.test(file.path) || (sourceLines.get(file.path).before === 0 && sourceLines.get(file.path).after === 0)) continue;
    requireValid(represented.has(file.path), 'Assessment omitted a nonempty changed file.');
  }
  // All fields are now JSON data and bounded; enforce a total response limit too.
  requireValid(Buffer.byteLength(JSON.stringify(assessment), 'utf8') <= MAX_ASSESSMENT_BYTES, 'Assessment exceeds the complete-output limit.');
  return assessment;
}

const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ');
const markdown = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1');
const commandData = value => clean(value).replace(/%/g, '%25');
const commandProperty = value => commandData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
const encodedPath = value => value.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
const blobLink = (evidence, ref) => `https://github.com/${evidence.repository}/blob/${ref.side === 'before' ? evidence.base : evidence.head}/${encodedPath(ref.path)}#L${ref.line}`;

/** Returns 1 for malformed/stale output as well as a supported missing-note verdict. */
function assessmentExitCode(evidence, assessment) {
  try { return validateAssessment(evidence, assessment).outcome === 'missing_note' ? 1 : 0; }
  catch { return 1; }
}

/** Rendering is safe even when the response fails validation; errors blame execution, not author wording. */
function renderAssessment(evidence, assessment) {
  try { validateAssessment(evidence, assessment); }
  catch (error) {
    const message = error instanceof AssessmentValidationError ? error.message : 'The assessment validator could not execute.';
    const repair = 'Repair the exact-head evidence or assessment output, then rerun. No missing-note conclusion was made.';
    return {outcome: 'error', exitCode: 1,
      summary: `## Changelogs — coverage\n\n**Assessment could not be checked.**\n\n${markdown(message)}\n\n${repair}\n`,
      annotations: [`::error title=Changelog assessment could not be checked::${commandData(message)} ${repair}`]};
  }
  const titles = {pass: 'Covered or exempt.', missing_note: 'Missing changelog entry.', review: 'Reviewer assessment needed.'};
  const summary = ['## Changelogs — coverage', '', `**${titles[assessment.outcome]}**`, '',
    `Assessed head: [${evidence.head.slice(0, 12)}](https://github.com/${evidence.repository}/commit/${evidence.head})`, '',
    `[Review changelog changes at this head](https://github.com/${evidence.repository}/compare/${evidence.base}...${evidence.head})`];
  const annotations = [], entries = new Map(evidence.entries.map(entry => [entry.id, entry]));
  if (assessment.findings.length === 0) summary.push('', 'No changed files to assess.');
  for (const finding of assessment.findings) {
    const labels = {covered: 'Covered', exempt: 'No note needed', missing: 'Missing note', uncertain: 'Review needed'};
    summary.push('', `### ${labels[finding.disposition]}: ${markdown(finding.effect)}`, '', markdown(finding.reason));
    if (finding.disposition === 'missing') summary.push('', `Suggested heading: **${markdown(finding.heading)}**`, '',
      `Author correction: ${markdown(finding.correction)}`);
    for (const id of finding.entryIds) {
      const entry = entries.get(id);
      summary.push('', `Changelog: [${markdown(entry.path)}:${entry.line}](${blobLink(evidence, {...entry, side: 'after'})}) — ${markdown(entry.text)}`);
    }
    for (const ref of finding.evidence) summary.push('', `Source (${ref.side}): [${markdown(ref.path)}:${ref.line}](${blobLink(evidence, ref)})`);
    if (finding.disposition === 'missing' || finding.disposition === 'uncertain') {
      const missing = finding.disposition === 'missing';
      const title = missing ? 'Missing changelog entry' : 'Changelog wording needs review';
      // GitHub annotates the PR head; a deleted/before-only location belongs in the linked summary.
      const location = finding.evidence.find(ref => ref.side === 'after');
      const properties = location ? ` file=${commandProperty(location.path)},line=${location.line},title=${title}` : ` title=${title}`;
      const message = `${finding.effect}: ${finding.reason}${missing ? ` Suggested heading: ${finding.heading}. ${finding.correction}` : ''}`;
      annotations.push(`::${missing ? 'error' : 'warning'}${properties}::${commandData(message)}`);
    }
  }
  summary.push('', 'This assessment does not establish that a change has shipped.');
  return {outcome: assessment.outcome, exitCode: assessment.outcome === 'missing_note' ? 1 : 0,
    summary: summary.join('\n') + '\n', annotations};
}

module.exports = {AssessmentValidationError, validateEvidence, validateAssessment, renderAssessment, assessmentExitCode};
