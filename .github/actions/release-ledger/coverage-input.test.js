'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectInput, digest } = require('./coverage-input');
const { validateBaseline } = require('./coverage-baseline');
const { evaluate, readTrustedEnvelope, fallback } = require('./coverage-check');
const { validateAssessment, renderAssessment } = require('./coverage-result');
const { makeSnapshot, DEFAULT_SOURCE, REPOSITORY } = require('./fixtures/coverage-baseline/snapshot');

// Real isolated Git histories, synthetic source only. No provider or PR code runs.
function repository(t, initial = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-git-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), content); };
  git('init', '--quiet'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  write('CHANGELOG.md', DEFAULT_SOURCE); for (const [name, content] of Object.entries(initial)) write(name, content);
  const commit = () => { git('add', '--all'); git('commit', '--quiet', '-m', 'Synthetic fixture'); return git('rev-parse', 'HEAD'); };
  const baseSha = commit();
  const snapshot = makeSnapshot();
  const baseline = validateBaseline(snapshot);
  const collect = headSha => collectInput({ cwd, repository: REPOSITORY, baseSha, headSha, baseline });
  return { cwd, git, write, commit, baseSha, snapshot, baseline, collect };
}
function upcoming(text = 'Capture several photos.') { return '# Synthetic app\n\n## Unreleased\n\n### New\n\n- ' + text + '\n\n' + DEFAULT_SOURCE.replace(/^# Synthetic app\n\n/, ''); }
function result(input, outcome, findings = []) { return { schemaVersion: 1, repository: input.repository, baseSha: input.baseSha, headSha: input.headSha, digest: input.digest, outcome, reason: 'A human-labelled synthetic assessment tests result transport, not assessor accuracy.', findings }; }

test('collector retains unchanged upcoming entry and exact changed source lines', t => {
  const r = repository(t, { 'Capture.swift': 'one()\nkeep()\n' });
  r.write('CHANGELOG.md', upcoming()); const sharedHead = r.commit();
  r.write('Capture.swift', 'many()\nkeep()\n'); const headSha = r.commit();
  const input = collectInput({ cwd: r.cwd, repository: REPOSITORY, baseSha: sharedHead, headSha, baseline: r.baseline });
  assert.equal(input.eligibleEntries.length, 1);
  assert.equal(input.eligibleEntries[0].summary, 'Capture several photos.');
  assert.equal(input.files.length, 1); assert.equal(input.files[0].path, 'Capture.swift');
  assert.deepEqual(input.files[0].changedBaseLines, [1]); assert.deepEqual(input.files[0].changedHeadLines, [1]);
  assert.ok(input.excludedEntries.length > 0);
  const { digest: stored, ...rest } = input; assert.equal(stored, digest(rest));
  assert.equal(fallback(input).outcome, 'review');
});
test('stale base binds current base but reads and cites PR changes at merge base', t => {
  const r = repository(t, { 'Capture.swift': 'one()\n' });
  r.write('Capture.swift', 'many()\n'); const headSha = r.commit();
  r.git('checkout', '--detach', r.baseSha); r.write('MainOnly.swift', 'newMain()\n'); const baseSha = r.commit();
  const input = collectInput({ cwd: r.cwd, repository: REPOSITORY, baseSha, headSha, baseline: r.baseline });
  assert.equal(input.staleBase, true); assert.equal(input.mergeBaseSha, r.baseSha);
  assert.deepEqual(input.files.map(file => file.path), ['Capture.swift']);
  const assessment = result(input, 'missing_note', [{ effect: 'Capture now permits several photos.', sources: [{ path: 'Capture.swift', side: 'base', lineStart: 1, lineEnd: 1 }], heading: 'New', correction: 'Add a New bullet to CHANGELOG.md covering multi-photo capture.' }]);
  assert.match(renderAssessment(assessment, input).summary, new RegExp('/blob/' + r.baseSha + '/Capture.swift'));
});
test('exact blob diffs handle rename and old-path recreation without mixing hunks', t => {
  const r = repository(t, { 'Old.swift': 'one()\nkeep()\nkeep2()\nkeep3()\n' });
  fs.renameSync(path.join(r.cwd, 'Old.swift'), path.join(r.cwd, 'New.swift'));
  r.write('New.swift', 'many()\nkeep()\nkeep2()\nkeep3()\n'); r.write('Old.swift', 'replacement()\n');
  const input = r.collect(r.commit());
  for (const file of input.files) {
    assert.ok(file.changedHeadLines.every(line => line <= file.headLines));
    assert.ok(file.changedBaseLines.every(line => line <= file.baseLines));
    if (file.path === 'New.swift' && file.status.startsWith('R')) assert.deepEqual(file.changedHeadLines, [1]);
  }
});
test('renamed old path becoming a directory cannot lend child hunks to an unchanged rename', t => {
  const r = repository(t, { Old: 'unchanged()\n' });
  fs.renameSync(path.join(r.cwd, 'Old'), path.join(r.cwd, 'New'));
  r.write('Old/child.swift', 'first()\nsecond()\nthird()\n');
  const input = r.collect(r.commit());
  const renamed = input.files.find(file => file.path === 'New');
  assert.equal(renamed.status, 'R100');
  assert.deepEqual(renamed.changedBaseLines, []); assert.deepEqual(renamed.changedHeadLines, []);
  assert.deepEqual(input.files.find(file => file.path === 'Old/child.swift').changedHeadLines, [1, 2, 3]);
});
test('PR attributes cannot hide UTF8 hunks and glob characters are literal paths', t => {
  const r = repository(t, { '.gitattributes': '*.swift -diff\n', 'Capture.swift': 'one()\n', 'Other.swift': 'other()\n', '[C]*.swift': 'literal()\n' });
  r.write('Capture.swift', 'many()\n'); r.write('[C]*.swift', 'changedLiteral()\n');
  const input = r.collect(r.commit());
  assert.deepEqual(input.files.map(file => file.path).sort(), ['Capture.swift', '[C]*.swift']);
  assert.ok(input.files.every(file => !file.binary && file.changedHeadLines.length === 1));
});
test('additions, deletions, mode changes and binary changes remain accounted for', t => {
  const r = repository(t, { 'Deleted.swift': 'gone()\n', 'Mode.sh': 'neverExecuteThis\n' });
  fs.unlinkSync(path.join(r.cwd, 'Deleted.swift')); fs.chmodSync(path.join(r.cwd, 'Mode.sh'), 0o755);
  r.write('Added.swift', 'first()\nsecond()\n'); r.write('asset.bin', Buffer.from([0, 1, 2]));
  const input = r.collect(r.commit());
  assert.equal(input.files.length, 4);
  assert.deepEqual(input.files.find(f => f.path === 'Added.swift').changedHeadLines, [1, 2]);
  assert.deepEqual(input.files.find(f => f.path === 'Deleted.swift').changedBaseLines, [1]);
  assert.equal(input.files.find(f => f.path === 'Mode.sh').mode.head, '100755');
  assert.equal(input.files.find(f => f.path === 'asset.bin').binary, true);
  assert.equal(fallback(input).outcome, 'review');
});
test('limits, invalid scope and unavailable objects are execution problems, not omissions', t => {
  const r = repository(t, { 'Capture.swift': 'one()\n' }); r.write('Capture.swift', 'many()\nmore()\n'); const headSha = r.commit();
  const opts = { cwd: r.cwd, repository: REPOSITORY, baseSha: r.baseSha, headSha, baseline: r.baseline };
  for (const limits of [{ fileBytes: 1 }, { totalBytes: 2 }, { fileLines: 1 }]) assert.throws(() => collectInput({ ...opts, limits }), /limit|exceeds/);
  assert.throws(() => collectInput({ ...opts, repository: 'VeamStudios/Other' }), /SAP iOS/);
  assert.throws(() => collectInput({ ...opts, headSha: 'e'.repeat(40) }), /could not be read/);
});
test('published history edits cannot become upcoming coverage', t => {
  const r = repository(t); r.write('CHANGELOG.md', DEFAULT_SOURCE.replace(/- /, '- Edited published '));
  assert.throws(() => r.collect(r.commit()), /Published changelog history changed/);
});
test('default assessor never invents missing notes or semantic maintenance exemptions', t => {
  const r = repository(t, { 'Capture.swift': 'one()\n' }); r.write('Capture.swift', 'many()\n'); const headSha = r.commit();
  const config = { repository: REPOSITORY, workspace: r.cwd, baseSha: r.baseSha, headSha, snapshot: r.snapshot };
  const review = evaluate(config); assert.equal(review.result.outcome, 'review'); assert.equal(review.code, 0);
  assert.match(review.summary, /No approved semantic assessor/);
  const absent = evaluate({ ...config, snapshot: undefined }); assert.equal(absent.result.outcome, 'error'); assert.equal(absent.code, 0); assert.equal(absent.result.findings.length, 0);
  assert.match(absent.summary, /No missing changelog entry is inferred/);
  assert.equal(evaluate({ ...config, snapshot: undefined, mode: 'enforce' }).code, 1);
});
test('trusted supported finding gives exact author action; malformed/stale result is execution error', t => {
  const r = repository(t, { 'Capture.swift': 'one()\n' }); r.write('Capture.swift', 'many()\n'); const headSha = r.commit();
  const config = { repository: REPOSITORY, workspace: r.cwd, baseSha: r.baseSha, headSha, snapshot: r.snapshot };
  const input = evaluate(config).input;
  const assessment = result(input, 'missing_note', [{ effect: 'Multi-photo capture is uncovered.', sources: [{ path: 'Capture.swift', side: 'head', lineStart: 1, lineEnd: 1, snippet: 'many()' }], heading: 'New', correction: 'Add a New bullet to CHANGELOG.md describing multiple photos in one session.' }]);
  const missing = evaluate({ ...config, assessment }); assert.equal(missing.result.outcome, 'missing_note'); assert.equal(missing.code, 0); assert.match(missing.summary, /Author correction/);
  assert.equal(evaluate({ ...config, assessment, mode: 'enforce' }).code, 1);
  assert.equal(evaluate({ ...config, assessment: { ...assessment, headSha: 'e'.repeat(40) } }).result.outcome, 'error');
  const broken = evaluate({ ...config, assessmentError: 'Assessment envelope JSON is unreadable.' });
  assert.equal(broken.result.outcome, 'error'); assert.equal(broken.input.digest, input.digest); assert.match(broken.summary, /Assessment envelope JSON is unreadable/);
});
test('changelog-only upcoming edits pass without asking authors for another file', t => {
  const r = repository(t); r.write('CHANGELOG.md', upcoming());
  const checked = evaluate({ repository: REPOSITORY, workspace: r.cwd, baseSha: r.baseSha, headSha: r.commit(), snapshot: r.snapshot });
  assert.equal(checked.result.outcome, 'pass'); assert.equal(checked.input.eligibleEntries.length, 1);
});
test('PR JSON and symlinks into checkout cannot supply trusted baseline or judgments', t => {
  const r = repository(t); r.write('baseline.json', JSON.stringify(r.snapshot));
  assert.throws(() => readTrustedEnvelope(path.join(r.cwd, 'baseline.json'), r.cwd), /outside the PR checkout/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-envelope-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(path.join(r.cwd, 'baseline.json'), path.join(outside, 'link.json'));
  assert.throws(() => readTrustedEnvelope(path.join(outside, 'link.json'), r.cwd), /outside the PR checkout/);
  fs.writeFileSync(path.join(outside, 'trusted.json'), JSON.stringify(r.snapshot));
  assert.equal(readTrustedEnvelope(path.join(outside, 'trusted.json'), r.cwd).repository, REPOSITORY);
});
test('existing PR Work Item mapping and body edits are collected as data and invalidate results', t => {
  const r = repository(t, { 'Capture.swift': 'one()\n' }); r.write('Capture.swift', 'many()\n'); const headSha = r.commit();
  const config = { cwd: r.cwd, repository: REPOSITORY, headSha, baseSha: r.baseSha, baseline: r.baseline };
  const body = 'Work Items:\n- https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const input = collectInput({ ...config, pr: { number: 123, title: 'feat: camera', body } });
  assert.equal(input.pr.number, 123); assert.equal(input.pr.workItems.length, 1);
  const edited = collectInput({ ...config, pr: { number: 123, title: 'feat: camera', body: body + '\nAdditional context.' } });
  assert.notEqual(input.digest, edited.digest);
  assert.equal(validateAssessment(result(input, 'review'), edited).outcome, 'error');
});
