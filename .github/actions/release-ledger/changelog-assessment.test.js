'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {evidenceDigest, collectEvidence} = require('./changelog-evidence');
const {AssessmentValidationError, validateAssessment, renderAssessment, assessmentExitCode} = require('./changelog-assessment');

// Synthetic contract fixtures. These tests do not establish assessor accuracy.
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), RELEASE = 'c'.repeat(40);
const digest = evidenceDigest;
function fixture() {
  const evidence = {schemaVersion: 1, repository: 'VeamStudios/SyntheticApp', head: HEAD, base: BASE, releaseCommit: RELEASE,
    files: [{path: 'Capture.swift', status: 'M', before: 'captureOne()\n', after: 'captureMany()\nshowPreview()\n'}],
    entries: [{id: 'CHANGELOG.md:5', path: 'CHANGELOG.md', line: 5, heading: 'Unreleased / New',
      text: '- Capture multiple photos with a preview.', eligible: true}]};
  evidence.digest = digest(evidence);
  const assessment = {schemaVersion: 1, repository: evidence.repository, head: HEAD, base: BASE, evidenceDigest: evidence.digest,
    outcome: 'pass', findings: [{effect: 'Multiple-photo capture with a preview.', disposition: 'covered',
      evidence: [{path: 'Capture.swift', side: 'after', line: 1}], entryIds: ['CHANGELOG.md:5'],
      reason: 'The eligible note describes the related capture change.'}]};
  return {evidence, assessment};
}
function rebind(evidence, assessment) { evidence.digest = digest(evidence); assessment.evidenceDigest = evidence.digest; }
function invalid(evidence, assessment, message) {
  assert.throws(() => validateAssessment(evidence, assessment), error => error instanceof AssessmentValidationError &&
    (!message || message.test(error.message)));
  assert.equal(assessmentExitCode(evidence, assessment), 1);
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'error'); assert.equal(output.exitCode, 1);
  assert.match(output.summary, /Assessment could not be checked/);
  assert.match(output.summary, /No missing-note conclusion was made/);
  assert.equal(output.annotations.length, 1);
  assert.match(output.annotations[0], /^::error title=Changelog assessment could not be checked::/);
}
function missing(assessment) {
  assessment.outcome = 'missing_note';
  Object.assign(assessment.findings[0], {disposition: 'missing', entryIds: [],
    reason: 'No eligible note describes multiple-photo capture.', heading: 'New',
    correction: 'Add a bullet under New in the upcoming release describing multiple-photo capture and preview.'});
}

test('valid covered judgment is bound to exact evidence and links actual supplied note and source', () => {
  const {evidence, assessment} = fixture();
  const snapshot = JSON.stringify({evidence, assessment});
  assert.equal(validateAssessment(evidence, assessment), assessment);
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'pass'); assert.equal(output.exitCode, 0); assert.deepEqual(output.annotations, []);
  assert.ok(output.summary.includes(`/blob/${HEAD}/Capture.swift#L1`));
  assert.ok(output.summary.includes(`/blob/${HEAD}/CHANGELOG.md#L5`));
  assert.ok(output.summary.includes(`/compare/${BASE}...${HEAD}`));
  assert.equal(JSON.stringify({evidence, assessment}), snapshot);
});

test('collector output supports an unchanged upcoming note and rejects an already shipped note', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-contract-'));
  t.after(() => fs.rmSync(workspace, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    {cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '--quiet'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const published = '## 1.0.0\n### Fixed\n- Published capture fix.\n';
  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# App\n\n' + published);
  fs.writeFileSync(path.join(workspace, 'Capture.swift'), 'captureOne()\n');
  git('add', '--all'); git('commit', '--quiet', '-m', 'Synthetic published baseline');
  const releaseCommit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# App\n\n## 1.1.0\n### New\n- Capture multiple photos.\n\n' + published);
  git('add', '--all'); git('commit', '--quiet', '-m', 'Synthetic upcoming related note');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(workspace, 'Capture.swift'), 'captureMany()\n');
  git('add', '--all'); git('commit', '--quiet', '-m', 'Synthetic related source change');
  const head = git('rev-parse', 'HEAD');
  const evidence = collectEvidence({cwd: workspace, repository: 'VeamStudios/SyntheticApp', head, base, releaseCommit,
    changelogPaths: ['CHANGELOG.md']});
  const upcoming = evidence.entries.find(entry => entry.eligible), shipped = evidence.entries.find(entry => !entry.eligible);
  assert.ok(upcoming); assert.ok(shipped);
  assert.equal(evidence.files.some(file => file.path === 'CHANGELOG.md'), false);
  const assessment = {schemaVersion: 1, repository: evidence.repository, head, base, evidenceDigest: evidence.digest,
    outcome: 'pass', findings: [{effect: 'Multiple-photo capture.', disposition: 'covered',
      evidence: [{path: 'Capture.swift', side: 'after', line: 1}], entryIds: [upcoming.id], reason: 'Human-labeled synthetic related-note fixture.'}]};
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  assessment.findings[0].entryIds = [shipped.id]; invalid(evidence, assessment, /already shipped/);
});

test('maintenance exemption supplies a reason without requiring a new changelog entry', () => {
  const {evidence, assessment} = fixture();
  evidence.files[0].path = '.github/workflows/check.yml'; evidence.entries = [];
  Object.assign(assessment.findings[0], {effect: 'Update CI naming.', disposition: 'exempt', entryIds: [],
    evidence: [{path: evidence.files[0].path, side: 'after', line: 1}], reason: 'This is routine CI maintenance with no operational effect.'});
  rebind(evidence, assessment);
  assert.equal(validateAssessment(evidence, assessment), assessment);
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  assert.match(renderAssessment(evidence, assessment).summary, /No note needed/);
});

test('missing note fails with a code location, heading, effect and precise correction', () => {
  const {evidence, assessment} = fixture(); missing(assessment);
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'missing_note'); assert.equal(output.exitCode, 1);
  assert.equal(assessmentExitCode(evidence, assessment), 1);
  assert.match(output.summary, /Suggested heading: \*\*New\*\*/);
  assert.match(output.summary, /Author correction: Add a bullet/);
  assert.match(output.annotations[0], /^::error file=Capture.swift,line=1,title=Missing changelog entry::/);
});

test('uncertainty stays nonblocking and contains a review explanation without inventing a correction', () => {
  const {evidence, assessment} = fixture();
  assessment.outcome = 'review'; Object.assign(assessment.findings[0], {disposition: 'uncertain', entryIds: [],
    reason: 'A reviewer needs to establish whether this changes observable capture behavior.'});
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'review'); assert.equal(output.exitCode, 0);
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  assert.match(output.annotations[0], /^::warning /);
  assert.doesNotMatch(output.summary, /Missing changelog entry|Author correction/);
});

test('missing overrides uncertainty, and every outcome must agree with its findings', () => {
  const {evidence, assessment} = fixture();
  const uncertain = structuredClone(assessment.findings[0]); uncertain.disposition = 'uncertain'; uncertain.entryIds = [];
  missing(assessment); assessment.findings.push(uncertain);
  assert.equal(validateAssessment(evidence, assessment).outcome, 'missing_note');
  for (const outcome of ['pass', 'review', 'error', 'success']) {
    assessment.outcome = outcome; invalid(evidence, assessment, /outcome/);
  }
  const covered = fixture(); covered.assessment.outcome = 'review'; invalid(covered.evidence, covered.assessment, /outcome/);
});

test('an empty diff can pass; changed files cannot pass with no findings', () => {
  const {evidence, assessment} = fixture(); evidence.files = []; assessment.findings = []; rebind(evidence, assessment);
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  assert.match(renderAssessment(evidence, assessment).summary, /No changed files/);
  const changed = fixture(); changed.assessment.findings = []; invalid(changed.evidence, changed.assessment, /empty assessment/);
  const notes = fixture(); notes.evidence.files = [{path: 'CHANGELOG.md', status: 'M', before: '- Old note.\n', after: '- Revised note.\n'}];
  notes.evidence.entries = []; notes.assessment.findings = []; rebind(notes.evidence, notes.assessment);
  invalid(notes.evidence, notes.assessment, /empty assessment/);
});

test('empty-file maintenance has an explicit exemption without fabricated line references', () => {
  const {evidence, assessment} = fixture();
  evidence.files = [{path: '.gitkeep', status: 'A', before: null, after: ''}]; evidence.entries = [];
  Object.assign(assessment.findings[0], {effect: 'Add an empty directory marker.', disposition: 'exempt', evidence: [], entryIds: [],
    reason: 'The empty marker has no product or operational effect.'}); rebind(evidence, assessment);
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  assessment.findings[0].evidence = [{path: '.gitkeep', side: 'after', line: 1}];
  invalid(evidence, assessment, /nonexistent source line/);
});

test('repository, head, base and digest mismatch are stale execution failures', () => {
  for (const [key, value] of [['repository', 'VeamStudios/OtherApp'], ['head', 'd'.repeat(40)], ['base', 'e'.repeat(40)], ['evidenceDigest', 'f'.repeat(64)]]) {
    const {evidence, assessment} = fixture(); assessment[key] = value; invalid(evidence, assessment, /stale/);
  }
  const {evidence, assessment} = fixture(); evidence.releaseCommit = 'd'.repeat(40); evidence.digest = digest(evidence);
  invalid(evidence, assessment, /stale/);
});

test('mutating any supplied source, note eligibility or release baseline invalidates its digest', () => {
  for (const mutate of [e => {e.files[0].after = 'differentEffect()\n';}, e => {e.entries[0].text = '- Different note.';},
    e => {e.entries[0].eligible = false;}, e => {e.releaseCommit = 'd'.repeat(40);}]) {
    const {evidence, assessment} = fixture(); mutate(evidence);
    invalid(evidence, assessment, /contents do not match the supplied digest/);
  }
});

test('multiple release baseline identifiers are bounded, unique, sorted and digest-bound', () => {
  const valid = fixture(); valid.evidence.releaseCommits = [RELEASE, 'd'.repeat(40)]; rebind(valid.evidence, valid.assessment);
  assert.equal(assessmentExitCode(valid.evidence, valid.assessment), 0);
  for (const releaseCommits of [[], [RELEASE, RELEASE], ['d'.repeat(40), RELEASE], ['d'.repeat(40)], ['0'.repeat(40), RELEASE],
    Array.from({length: 9}, (_, index) => String(index + 1).repeat(40))]) {
    const {evidence, assessment} = fixture(); evidence.releaseCommits = releaseCommits; rebind(evidence, assessment);
    invalid(evidence, assessment, /release commits/);
  }
});

test('unknown fields are rejected throughout the output and evidence contract', () => {
  for (const target of ['assessment', 'finding', 'reference', 'evidence', 'file', 'entry']) {
    const {evidence, assessment} = fixture();
    const objects = {assessment, finding: assessment.findings[0], reference: assessment.findings[0].evidence[0], evidence,
      file: evidence.files[0], entry: evidence.entries[0]};
    objects[target].unexpected = true; invalid(evidence, assessment, /unknown/);
  }
  const {evidence, assessment} = fixture();
  Object.defineProperty(assessment, '__proto__', {value: {outcome: 'pass'}, enumerable: true});
  invalid(evidence, assessment, /unknown/);
});

test('non-JSON objects, accessors, missing fields, sparse arrays and malformed JSON are not accepted', () => {
  const cases = [null, [], '"not an assessment"', new Date(), Object.create({outcome: 'pass'})];
  for (const assessment of cases) invalid(fixture().evidence, assessment, /JSON object/);
  const {evidence, assessment} = fixture();
  let invoked = false; Object.defineProperty(assessment, 'outcome', {enumerable: true, get() {invoked = true; return 'pass';}});
  invalid(evidence, assessment, /non-JSON/); assert.equal(invoked, false);
  const absent = fixture(); delete absent.assessment.findings[0].reason; invalid(absent.evidence, absent.assessment, /required field/);
  const sparse = fixture(); sparse.assessment.findings = new Array(1); invalid(sparse.evidence, sparse.assessment, /JSON array/);
  const getterArray = fixture(); let read = false;
  Object.defineProperty(getterArray.assessment.findings, '0', {enumerable: true, get() {read = true; return {};}});
  invalid(getterArray.evidence, getterArray.assessment, /non-JSON/); assert.equal(read, false);
});

test('all source references must identify a supplied side and actual 1-based line', () => {
  for (const ref of [
    {path: 'unknown.swift', side: 'after', line: 1}, {path: 'Capture.swift', side: 'workingTree', line: 1},
    {path: 'Capture.swift', side: 'after', line: 0}, {path: 'Capture.swift', side: 'after', line: 3},
    {path: 'Capture.swift', side: 'before', line: 2}, {path: 'Capture.swift', side: 'after', line: 1.5},
    {path: 'Capture.swift', side: 'after', line: '1'},
  ]) {
    const {evidence, assessment} = fixture(); assessment.findings[0].evidence = [ref]; invalid(evidence, assessment, /source/);
  }
  const empty = fixture(); empty.assessment.findings[0].evidence = []; invalid(empty.evidence, empty.assessment, /supporting/);
  const duplicate = fixture(); duplicate.assessment.findings[0].evidence.push({...duplicate.assessment.findings[0].evidence[0]});
  invalid(duplicate.evidence, duplicate.assessment, /duplicate source/);
  const crlf = fixture(); crlf.evidence.files[0].after = 'first\r\nsecond\r\n'; crlf.assessment.findings[0].evidence[0].line = 2;
  rebind(crlf.evidence, crlf.assessment); assert.equal(assessmentExitCode(crlf.evidence, crlf.assessment), 0);
  const loneCR = fixture(); loneCR.evidence.files[0].after = 'first\rsecond'; loneCR.assessment.findings[0].evidence[0].line = 2;
  rebind(loneCR.evidence, loneCR.assessment); invalid(loneCR.evidence, loneCR.assessment, /nonexistent source line/);
});

test('coverage requires a known eligible note and cannot be borrowed from shipped history', () => {
  for (const ids of [[], ['unknown'], ['CHANGELOG.md:5', 'CHANGELOG.md:5']]) {
    const {evidence, assessment} = fixture(); assessment.findings[0].entryIds = ids; invalid(evidence, assessment, /entry/);
  }
  const shipped = fixture(); shipped.evidence.entries[0].eligible = false; rebind(shipped.evidence, shipped.assessment);
  invalid(shipped.evidence, shipped.assessment, /ineligible or already shipped/);
  const exempt = fixture(); exempt.assessment.findings[0].disposition = 'exempt'; invalid(exempt.evidence, exempt.assessment, /cannot claim entry/);
  const absent = fixture(); absent.evidence.files.push({path: 'CHANGELOG.md', status: 'D', before: '- Historical.\n', after: null});
  rebind(absent.evidence, absent.assessment); invalid(absent.evidence, absent.assessment, /not present/);
});

test('every missing finding has explicit effect, reason, heading and author correction', () => {
  for (const key of ['effect', 'reason', 'heading', 'correction']) {
    for (const value of ['', '   ', undefined, 2]) {
      const {evidence, assessment} = fixture(); missing(assessment); assessment.findings[0][key] = value;
      invalid(evidence, assessment, /bounded text/);
    }
  }
  const covered = fixture(); covered.assessment.findings[0].correction = 'Invent a note.';
  invalid(covered.evidence, covered.assessment, /Only a missing/);
});

test('no outcome can omit a nonempty changed file, while notes need no independent code finding', () => {
  const {evidence, assessment} = fixture();
  evidence.files.push({path: 'Permissions.swift', status: 'M', before: 'oldPermission()\n', after: 'newPermission()\n'});
  rebind(evidence, assessment); invalid(evidence, assessment, /omitted/);
  const review = structuredClone(assessment); review.outcome = 'review'; review.findings[0].disposition = 'uncertain';
  invalid(evidence, review, /omitted/);
  const missingNote = structuredClone(assessment); missing(missingNote); invalid(evidence, missingNote, /omitted/);
  assessment.findings[0].evidence.push({path: 'Permissions.swift', side: 'after', line: 1});
  assert.equal(assessmentExitCode(evidence, assessment), 0);
  evidence.files.push({path: 'CHANGELOG.md', status: 'M', before: 'one\ntwo\nthree\nfour\nold note\n', after: 'one\ntwo\nthree\nfour\nnew note\n'});
  rebind(evidence, assessment); assert.equal(assessmentExitCode(evidence, assessment), 0);
});

test('renames represented as deletion and addition need both supplied paths referenced', () => {
  const {evidence, assessment} = fixture();
  evidence.files = [{path: 'old.swift', status: 'D', before: 'sameBehavior()\n', after: null},
    {path: 'new.swift', status: 'A', before: null, after: 'sameBehavior()\n'}];
  Object.assign(assessment.findings[0], {disposition: 'exempt', entryIds: [], reason: 'The source move preserves behavior.',
    evidence: [{path: 'new.swift', side: 'after', line: 1}]}); rebind(evidence, assessment);
  invalid(evidence, assessment, /omitted/);
  assessment.findings[0].evidence.push({path: 'old.swift', side: 'before', line: 1});
  assert.equal(assessmentExitCode(evidence, assessment), 0);
});

test('evidence cannot contain duplicate paths, invalid commit identity, traversal or missing/binary blobs', () => {
  const mutators = [
    e => e.files.push({...e.files[0]}), e => {e.head = 'main';}, e => {e.releaseCommit = null;}, e => {e.digest = 'partial';},
    e => {e.files[0].before = null; e.files[0].after = null;}, e => {e.files[0].after = '\0binary';},
    e => {e.files[0].after = '\ud800';}, e => {e.entries[0].eligible = 'yes';}, e => e.entries.push({...e.entries[0]}),
  ];
  for (const mutate of mutators) {const {evidence, assessment} = fixture(); mutate(evidence); invalid(evidence, assessment);}
  for (const path of ['../Capture.swift', '/Capture.swift', 'src/../Capture.swift', 'src//Capture.swift', 'C:/Capture.swift', 'evil\n::error::path', 'src\\Capture.swift']) {
    const {evidence, assessment} = fixture(); evidence.files[0].path = path; invalid(evidence, assessment, /relative repository path/);
  }
});

test('bounded output and complete evidence limits reject partial or oversized work', () => {
  const long = fixture(); long.assessment.findings[0].effect = 'x'.repeat(2001); invalid(long.evidence, long.assessment, /bounded/);
  const many = fixture(); many.assessment.findings = Array.from({length: 257}, () => many.assessment.findings[0]); invalid(many.evidence, many.assessment, /bounded JSON array/);
  const blob = fixture(); blob.evidence.files[0].after = 'x'.repeat(2 * 1024 * 1024 + 1); invalid(blob.evidence, blob.assessment, /complete-input limit/);
  const total = fixture(); missing(total.assessment);
  Object.assign(total.assessment.findings[0], {effect: 'e'.repeat(2000), reason: 'r'.repeat(4000), correction: 'c'.repeat(4000)});
  total.assessment.findings = Array.from({length: 128}, () => structuredClone(total.assessment.findings[0]));
  invalid(total.evidence, total.assessment, /complete-output limit/);
});

test('arbitrary markdown, HTML, bidirectional text and workflow commands render only as data', () => {
  const {evidence, assessment} = fixture(); missing(assessment);
  const attack = '<script>bad()</script> & [link](javascript:evil) `code`\n::error file=other,line=1::forged\r\n# Forged heading %0A\u202e';
  Object.assign(assessment.findings[0], {effect: attack, reason: attack, correction: attack, heading: attack.slice(0, 140)});
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'missing_note');
  assert.ok(output.summary.includes('&lt;script&gt;'));
  assert.ok(output.summary.includes('\\[link\\]\\(javascript:evil\\)'));
  assert.doesNotMatch(output.summary, /<script>|\u202e|\n# Forged heading/);
  assert.equal(output.annotations.length, 1);
  assert.equal(output.annotations[0].split(/[\r\n]/).length, 1);
  assert.ok(output.annotations[0].includes('%250A'));
  assert.match(output.annotations[0], /^::error file=Capture.swift,line=1,title=Missing changelog entry::/);
});

test('unusual source paths are URL-encoded and annotation properties cannot inject another property', () => {
  const {evidence, assessment} = fixture(); missing(assessment);
  const sourcePath = "src/a,b:%[odd]雪'().swift";
  evidence.files[0].path = sourcePath; assessment.findings[0].evidence[0].path = sourcePath; rebind(evidence, assessment);
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'missing_note');
  assert.ok(output.summary.includes('/src/a%2Cb%3A%25%5Bodd%5D%E9%9B%AA%27%28%29.swift#L1'));
  assert.ok(output.annotations[0].startsWith('::error file=src/a%2Cb%3A%25[odd]'));
  assert.equal((output.annotations[0].match(/,line=/g) || []).length, 1);
});

test('deleted-source evidence links the base and is not falsely annotated at the head', () => {
  const {evidence, assessment} = fixture(); missing(assessment);
  evidence.files[0].status = 'D'; evidence.files[0].after = null;
  assessment.findings[0].evidence[0].side = 'before'; rebind(evidence, assessment);
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'missing_note');
  assert.ok(output.summary.includes(`/blob/${BASE}/Capture.swift#L1`));
  assert.match(output.annotations[0], /^::error title=Missing changelog entry::/);
  assert.doesNotMatch(output.annotations[0], / file=|,line=/);
});

test('malformed responses are execution errors rather than speculative missing-note failures', () => {
  const {evidence, assessment} = fixture(); assessment.outcome = 'invented'; assessment.findings[0].reason = '<secret>unsafe</secret>';
  const output = renderAssessment(evidence, assessment);
  assert.equal(output.outcome, 'error'); assert.equal(output.exitCode, 1);
  assert.doesNotMatch(output.summary, /<secret>|unsafe|Missing changelog entry/);
  assert.match(output.summary, /Repair the exact-head evidence or assessment output/);
});
