'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAssessment, renderAssessment, exitCode } = require('./coverage-result');

// Synthetic transport fixtures exercise evidence validation, not model accuracy.
function fixture(outcome = 'missing_note') {
  const input = {
    schemaVersion: 1, complete: true, repository: 'VeamStudios/SiteAuditPro-iOS', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), digest: 'c'.repeat(64),
    files: [{ path: 'Camera/Capture.swift', status: 'modified', binary: false, before: 'let count = 1\nreturn count\n', after: 'let count = 10\nreturn count\n', baseLines: 2, headLines: 2, changedBaseLines: [1], changedHeadLines: [1] }],
    eligibleEntries: [{ id: 'upcoming-camera', path: 'CHANGELOG.md', lineStart: 4, lineEnd: 4, version: 'Unreleased', heading: 'New', summary: 'Capture several photos.', workItems: [], prRefs: [] }],
  };
  const source = { path: 'Camera/Capture.swift', side: 'head', lineStart: 1, lineEnd: 1, snippet: 'let count = 10' };
  const result = {
    schemaVersion: 1, repository: input.repository, headSha: input.headSha, baseSha: input.baseSha, digest: input.digest, outcome,
    reason: outcome === 'missing_note' ? 'The assessed capture effect has no adequate upcoming note.' : 'This synthetic assessment requires review.',
    findings: outcome === 'missing_note' ? [{ effect: 'Capture now permits multiple photos.', sources: [source], heading: 'New', correction: 'Add a New bullet in CHANGELOG.md describing multi-photo capture.' }] : [],
  };
  return { input, result, source };
}
function rejected(result, input, expected) {
  const value = validateAssessment(result, input);
  assert.equal(value.outcome, 'error');
  assert.equal(value.findings.length, 0);
  assert.match(value.reason, expected);
  assert.match(value.reason, /Rerun after repairing/);
  assert.match(value.reason, /No missing changelog entry is inferred/);
  return value;
}

test('a supported result is bound to its exact source identity without claiming semantic validation', () => {
  const { input, result } = fixture();
  const value = validateAssessment(result, input);
  assert.equal(value.outcome, 'missing_note');
  assert.equal(value.headSha, input.headSha);
  assert.equal(value.digest, input.digest);
  assert.equal(value.findings[0].sources[0].refPath, 'Camera/Capture.swift');
  assert.equal(exitCode(value, 'pilot'), 0);
  assert.equal(exitCode(value, 'enforce'), 1);
  assert.match(renderAssessment(value, input).summary, /does not establish semantic accuracy/);
});
test('scope, protocol version, both commits and the full input digest must match', () => {
  for (const [field, value] of [['repository', 'VeamStudios/Other'], ['schemaVersion', 2], ['headSha', 'd'.repeat(40)], ['baseSha', 'd'.repeat(40)], ['digest', 'd'.repeat(64)]]) {
    const { input, result } = fixture();
    rejected({ ...result, [field]: value }, input, /identity or input digest/);
  }
});
test('non-error conclusions require explicitly complete collection; execution-error rendering remains possible', () => {
  for (const outcome of ['pass', 'review', 'missing_note']) for (const complete of [false, undefined]) {
    const { input, result } = fixture(outcome);
    input.complete = complete;
    rejected(result, input, /Complete input collection has not been established/);
  }
  for (const complete of [false, undefined]) {
    const { input, result } = fixture('error');
    input.complete = complete;
    result.reason = 'Collection could not read all supplied source blobs; repair the inputs and rerun.';
    const rendered = renderAssessment(result, input);
    assert.equal(rendered.result.outcome, 'error');
    assert.equal(rendered.result.reason, result.reason);
    assert.match(rendered.summary, /Assessment execution problem/);
  }
});
test('malformed input identities, unknown outcomes and incomplete result contracts become execution problems', () => {
  for (const inputChange of [{ repository: 'VeamStudios/Other' }, { headSha: 'main' }, { baseSha: '' }, { digest: 'hash' }, { schemaVersion: 2 }]) {
    const { input, result } = fixture();
    rejected(result, { ...input, ...inputChange }, /input identity/);
  }
  for (const resultChange of [{ outcome: 'probably_missing' }, { findings: null }, { reason: '' }, { reason: 42 }, { findings: new Array(51).fill({}) }]) {
    const { input, result } = fixture();
    rejected({ ...result, ...resultChange }, input, /Unsupported|Invalid/);
  }
});
test('missing-note claims require a concrete finding, changed effect citation and exact author correction', () => {
  for (const change of [{ effect: '' }, { sources: [] }, { heading: 'Changed' }, { heading: undefined }, { correction: 'Please write notes.' }, { correction: undefined }]) {
    const { input, result } = fixture();
    rejected({ ...result, findings: [{ ...result.findings[0], ...change }] }, input, /Invalid|Unsupported|no cited|lacks/);
  }
  const { input, result } = fixture();
  rejected({ ...result, findings: [] }, input, /no specific supported finding/);
});
test('nonexistent files, binary files and invented or invalid source ranges are rejected', () => {
  for (const change of [{ path: 'Other.swift' }, { side: 'merge' }, { lineStart: 0 }, { lineStart: 2, lineEnd: 1 }, { lineEnd: 3 }, { lineStart: 1.5 }, { lineEnd: 101 }]) {
    const { input, result, source } = fixture();
    rejected({ ...result, findings: [{ ...result.findings[0], sources: [{ ...source, ...change }] }] }, input, /unavailable|Invalid|outside/);
  }
  const { input, result } = fixture();
  input.files[0].binary = true;
  rejected(result, input, /unavailable or binary/);
});
test('a matching source snippet proves bytes only and cannot substitute for changed-line evidence', () => {
  const { input, result, source } = fixture();
  for (const change of [{ snippet: 'captureManyPhotos()' }, { snippet: 'let count = 1' }, { snippet: 'let count = 10\n' }]) {
    rejected({ ...result, findings: [{ ...result.findings[0], sources: [{ ...source, ...change }] }] }, input, /snippet differs/);
  }
  const unchanged = { ...source, lineStart: 2, lineEnd: 2, snippet: 'return count' };
  rejected({ ...result, findings: [{ ...result.findings[0], sources: [unchanged] }] }, input, /does not intersect actual changed lines/);
  rejected({ ...result, findings: [{ ...result.findings[0], sources: [source, unchanged] }] }, input, /does not intersect actual changed lines/);
});
test('each citation uses the correct diff side and cannot invent changes from line membership on another side', () => {
  const { input, result, source } = fixture();
  input.files[0].changedBaseLines = [];
  const baseSource = { ...source, side: 'base', snippet: 'let count = 1' };
  rejected({ ...result, findings: [{ ...result.findings[0], sources: [baseSource] }] }, input, /does not intersect actual changed lines/);
});
test('changed-line arrays and line counts are mandatory collector evidence', () => {
  for (const fileChange of [{ headLines: 3 }, { baseLines: '2' }, { changedHeadLines: undefined }, { changedBaseLines: [3] }, { changedHeadLines: [1, 1] }, { after: undefined }]) {
    const { input, result } = fixture();
    Object.assign(input.files[0], fileChange);
    rejected(result, input, /line counts|changed-line|text is unavailable/);
  }
});
test('CRLF text is counted consistently and snippets must correspond exactly to the cited range', () => {
  const { input, result } = fixture();
  input.files[0].before = input.files[0].before.replace(/\n/g, '\r\n');
  input.files[0].after = input.files[0].after.replace(/\n/g, '\r\n');
  assert.equal(validateAssessment(result, input).outcome, 'missing_note');
});
test('only supplied eligible entries can be cited, including unchanged shared entries', () => {
  const { input, result } = fixture('pass');
  result.reason = 'The assessor identifies shared upcoming coverage.';
  result.findings = [{ effect: 'Capture follow-up is covered by the same upcoming camera entry.', sources: [], entryId: 'upcoming-camera' }];
  const rendered = renderAssessment(result, input);
  assert.equal(rendered.result.outcome, 'pass');
  assert.match(rendered.summary, /CHANGELOG\.md:4/);
  rejected({ ...result, findings: [{ ...result.findings[0], entryId: 'already-shipped' }] }, input, /not eligible/);
  input.eligibleEntries[0].eligible = false;
  rejected(result, input, /eligible changelog entry evidence/);
});
test('an insufficient existing entry can accompany a missing effect without pretending its citation is coverage', () => {
  const { input, result } = fixture();
  result.findings[0].entryId = 'upcoming-camera';
  const rendered = renderAssessment(result, input);
  assert.equal(rendered.result.outcome, 'missing_note');
  assert.match(rendered.summary, /Existing eligible entry/);
  assert.doesNotMatch(rendered.summary, /Covered wording/);
});
test('a changelog edit alone cannot substantiate a missing code-effect finding', () => {
  const { input, result } = fixture();
  input.files[0].path = 'CHANGELOG.md';
  result.findings[0].sources[0].path = 'CHANGELOG.md';
  rejected(result, input, /no cited changed effect outside CHANGELOG/);
});
test('deleted and renamed source evidence links to the base without attaching a wrong head annotation', () => {
  const { input, result } = fixture();
  input.files[0].status = 'renamed';
  input.files[0].basePath = 'Old Camera/Capture.swift';
  input.files[0].headPath = 'Camera/Capture.swift';
  result.findings[0].sources[0].side = 'base';
  result.findings[0].sources[0].snippet = 'let count = 1';
  const rendered = renderAssessment(result, input);
  assert.equal(rendered.result.outcome, 'missing_note');
  assert.match(rendered.summary, new RegExp(`/blob/${input.baseSha}/Old%20Camera/Capture\\.swift#L1`));
  assert.equal(rendered.annotations[0].path, undefined);
  assert.doesNotMatch(rendered.annotations[0].command, /file=/);
});
test('stale branches bind the result to the current base while cited old lines link to the immutable merge base', () => {
  const { input, result } = fixture();
  input.mergeBaseSha = 'd'.repeat(40);
  input.staleBase = true;
  result.findings[0].sources[0].side = 'base';
  result.findings[0].sources[0].snippet = 'let count = 1';
  result.findings[0].sources[0].refSha = 'e'.repeat(40);
  const rendered = renderAssessment(result, input);
  assert.equal(rendered.result.outcome, 'missing_note');
  assert.equal(rendered.result.baseSha, input.baseSha);
  assert.equal(rendered.result.findings[0].sources[0].refSha, input.mergeBaseSha);
  assert.match(rendered.summary, new RegExp(`/blob/${input.mergeBaseSha}/Camera/Capture\\.swift#L1`));
  assert.doesNotMatch(rendered.summary, new RegExp(`/blob/${input.baseSha}/Camera/`));
});
test('a provided merge-base identity must be an exact SHA even when current base and result match', () => {
  for (const mergeBaseSha of ['main', '', undefined, 'd'.repeat(39), 'D'.repeat(40)]) {
    const { input, result } = fixture();
    input.mergeBaseSha = mergeBaseSha;
    rejected(result, input, /merge-base source identity/);
  }
});
test('path traversal, absolute paths, line breaks and duplicate evidence fail validation', () => {
  for (const value of ['../secret', '/tmp/source.swift', 'file://source.swift', 'Camera\\Capture.swift', 'Camera/\n.swift', 'Camera//Capture.swift']) {
    const { input, result } = fixture();
    input.files[0].path = value;
    result.findings[0].sources[0].path = value;
    rejected(result, input, /source path/);
  }
  const { input, result } = fixture();
  input.files.push(structuredClone(input.files[0]));
  rejected(result, input, /Duplicate/);
});
test('execution-error and review results never claim missing notes or require author-managed declarations', () => {
  for (const outcome of ['error', 'review']) {
    const { input, result } = fixture(outcome);
    result.reason = outcome === 'error' ? 'The verified baseline was unavailable; repair configuration and rerun.' : 'Dependency effects remain uncertain; the ordinary reviewer should assess them.';
    const rendered = renderAssessment(result, input);
    assert.equal(rendered.result.outcome, outcome);
    assert.equal(exitCode(rendered.result, 'pilot'), 0);
    assert.equal(exitCode(rendered.result, 'enforce'), outcome === 'error' ? 1 : 0);
    assert.equal(rendered.annotations[0].level, outcome === 'error' ? 'error' : 'notice');
    assert.doesNotMatch(rendered.summary, /Missing changelog coverage|Author correction/);
  }
  const { input, result } = fixture();
  rejected({ ...result, outcome: 'error' }, input, /Execution errors cannot contain/);
});
test('PR-controlled text is escaped in Markdown and encoded as single annotation data', () => {
  const { input, result } = fixture();
  result.reason = '[secret](https://attacker.invalid) <img src="https://attacker.invalid">';
  result.findings[0].effect = 'Unsafe\n::notice title=Injected::text %0A\n<script>alert(1)</script>';
  const rendered = renderAssessment(result, input);
  assert.doesNotMatch(rendered.summary, /<img|<script|\[secret\]\(https:\/\/attacker/);
  assert.match(rendered.summary, /&lt;img/);
  assert.match(rendered.summary, /\\\[secret\\\]/);
  assert.equal(rendered.annotations.length, 1);
  assert.equal(rendered.annotations[0].command.split('\n').length, 1);
  assert.match(rendered.annotations[0].command, /%250A/);
});
test('annotation properties safely encode punctuation in legitimate filenames', () => {
  const { input, result } = fixture();
  input.files[0].path = 'Camera/a,b:c%20.swift';
  result.findings[0].sources[0].path = input.files[0].path;
  const rendered = renderAssessment(result, input);
  assert.match(rendered.annotations[0].command, /file=Camera\/a%2Cb%3Ac%2520\.swift,line=1,endLine=1/);
});
test('source links encode Markdown delimiters in filenames and use only the known GitHub repository', () => {
  const { input, result } = fixture();
  input.files[0].path = 'Camera/a)!([secret].swift';
  result.findings[0].sources[0].path = input.files[0].path;
  const rendered = renderAssessment(result, input);
  assert.equal(rendered.result.outcome, 'missing_note');
  assert.match(rendered.summary, /Camera\/a%29%21%28%5Bsecret%5D\.swift#L1/);
  assert.doesNotMatch(rendered.summary, /\[secret\]/);
});
test('only enforce mode can fail and uncertainty remains nonblocking in every supported mode', () => {
  for (const outcome of ['pass', 'missing_note', 'review', 'error']) {
    assert.equal(exitCode({ outcome }, 'pilot'), 0);
    assert.equal(exitCode({ outcome }, 'enforce'), ['missing_note', 'error'].includes(outcome) ? 1 : 0);
  }
  assert.equal(exitCode(null, 'pilot'), 0);
  assert.equal(exitCode(null, 'enforce'), 1);
  assert.throws(() => exitCode({ outcome: 'pass' }, 'automatic'), /Unknown/);
});
