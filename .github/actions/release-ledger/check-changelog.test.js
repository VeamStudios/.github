'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readChangelog, evaluate, render, main } = require('./check-changelog');
const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const TEXT = '# Synthetic app\n\n## 1.0.0\n### Fixed\n- A documented fix.\n';
function fixture(t, content = TEXT) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'format-git-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), content);
  git('add', '--all'); git('commit', '--quiet', '-m', 'Synthetic format fixture');
  return { workspace, git, repository: REPOSITORY, headSha: git('rev-parse', 'HEAD') };
}
test('exact-head changelog is checked without release evidence or an assessor', t => {
  const config = fixture(t);
  const result = evaluate(config);
  assert.equal(result.status, 'valid'); assert.equal(result.entries.length, 1);
  const output = render(result);
  assert.match(output.summary, /Format and explicit link syntax: valid/);
  assert.match(output.summary, /Code-to-wording coverage: not assessed/);
  assert.match(output.summary, /No new entry is required merely/);
  assert.equal(output.annotations.length, 0);
});
test('working-tree author changes and unrelated executable code cannot affect exact-head parsing', t => {
  const config = fixture(t);
  fs.writeFileSync(path.join(config.workspace, 'CHANGELOG.md'), 'uncommitted invalid text');
  fs.writeFileSync(path.join(config.workspace, 'unrelated.js'), 'throw Error("must never run");\n');
  assert.equal(readChangelog(config), TEXT); assert.equal(evaluate(config).status, 'valid');
});
test('unavailable exact head is an execution problem without a missing-note claim', t => {
  const config = fixture(t);
  const result = evaluate({ ...config, headSha: 'e'.repeat(40) });
  assert.equal(result.status, 'error'); assert.equal(result.entries.length, 0);
  assert.match(render(result).summary, /Changelog could not be checked/);
  assert.doesNotMatch(render(result).summary, /Missing changelog entry/);
});
test('malformed changelog produces a clear line-specific author correction', t => {
  const config = fixture(t, '# App\n\n## 1.0.0\n- Missing category.\n');
  const result = evaluate(config);
  assert.equal(result.status, 'invalid'); assert.equal(result.line, 4);
  const output = render(result);
  assert.match(output.annotations[0], /^::warning file=CHANGELOG.md,line=4::/);
  assert.match(output.summary, /Correct the indicated structure or link in CHANGELOG/);
});
test('symlinks and binary or invalid UTF8 changelogs are not silently treated as valid', t => {
  for (const content of [Buffer.from([0, 1]), Buffer.from([0xff, 0xfe])]) {
    const config = fixture(t, content); assert.equal(evaluate(config).status, 'error');
  }
  const config = fixture(t);
  fs.unlinkSync(path.join(config.workspace, 'CHANGELOG.md'));
  fs.symlinkSync('other.md', path.join(config.workspace, 'CHANGELOG.md'));
  config.git('add', '--all'); config.git('commit', '--quiet', '-m', 'Synthetic symlink fixture');
  assert.equal(evaluate({ ...config, headSha: config.git('rev-parse', 'HEAD') }).status, 'error');
});
test('unsupported repository, branch name or oversized source fails the complete-input check', t => {
  const config = fixture(t);
  for (const repository of ['OtherOrg/App', 'VeamStudios/App/other', 'VeamStudios/..', 'VeamStudios/App?q=other', undefined]) {
    assert.throws(() => readChangelog({ ...config, repository }), /supported VeamStudios/);
  }
  assert.throws(() => readChangelog({ ...config, headSha: 'main' }), /exact PR commit/);
  const large = fixture(t, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(evaluate(large).status, 'error');
});
test('applicable repositories retain their own exact-head review links', t => {
  const config = fixture(t);
  for (const repository of ['VeamStudios/ChecklistInspectorPro-iOS', 'VeamStudios/SiteAuditPro-Models', 'VeamStudios/siteauditpro.com', 'VeamStudios/.github']) {
    const result = evaluate({ ...config, repository });
    assert.equal(result.status, 'valid');
    assert.ok(render(result).summary.includes(`https://github.com/${repository}/blob/${config.headSha}/CHANGELOG.md`));
  }
  const output = render({repository:'VeamStudios/App](https://example.invalid)',headSha:config.headSha,status:'error',message:'Invalid repository',entries:[],sections:[]});
  assert.doesNotMatch(output.summary, /Review CHANGELOG/);
});
test('configured changelog paths read only their exact blobs and give path-specific feedback', t => {
  const config = fixture(t);
  fs.mkdirSync(path.join(config.workspace, 'docs'));
  fs.writeFileSync(path.join(config.workspace, 'docs/CHANGELOG.md'), '# App\n\n## 1.0.0\n- Missing category.\n');
  config.git('add', '--all'); config.git('commit', '--quiet', '-m', 'Synthetic docs fixture');
  const docs = { ...config, headSha: config.git('rev-parse', 'HEAD'), changelogPath:'docs/CHANGELOG.md' };
  const result = evaluate(docs);
  assert.equal(result.status, 'invalid');
  assert.match(render(result).annotations[0], /file=docs\/CHANGELOG.md,line=4/);
  assert.ok(render(result).summary.includes(`/blob/${docs.headSha}/docs/CHANGELOG.md`));
  for (const changelogPath of ['../CHANGELOG.md', '/CHANGELOG.md', 'packages/*/CHANGELOG.md', 'docs/../CHANGELOG.md', 'other.txt']) {
    assert.equal(evaluate({ ...docs, changelogPath }).status, 'error');
  }
  assert.equal(evaluate({ ...docs, format:'unknown' }).status, 'error');
});
test('one diagnostic job reads each configured package changelog without ignoring missing input', t => {
  const config = fixture(t);
  const packagePath = 'packages/synthetic/CHANGELOG.md';
  fs.mkdirSync(path.join(config.workspace, 'packages/synthetic'), {recursive:true});
  fs.writeFileSync(path.join(config.workspace, packagePath), TEXT);
  config.git('add', '--all'); config.git('commit', '--quiet', '-m', 'Synthetic package fixture');
  const summary = path.join(config.workspace, 'summary.md');
  const env = {CHANGELOG_REPOSITORY:REPOSITORY,CHANGELOG_HEAD_SHA:config.git('rev-parse','HEAD'),CHANGELOG_WORKSPACE:config.workspace,CHANGELOG_PATH:`CHANGELOG.md\n${packagePath}\npackages/missing/CHANGELOG.md`,GITHUB_STEP_SUMMARY:summary};
  assert.equal(main(env), 0);
  const output = fs.readFileSync(summary, 'utf8');
  assert.equal((output.match(/Format and explicit link syntax: valid/g)||[]).length, 2);
  assert.match(output, /packages\/missing\/CHANGELOG.md is missing/);
  assert.equal((output.match(/Code-to-wording coverage: not assessed/g)||[]).length, 1);
  fs.writeFileSync(summary, '');
  main({...env,CHANGELOG_PATH:'CHANGELOG.md\nCHANGELOG.md'});
  assert.doesNotMatch(fs.readFileSync(summary,'utf8'), /syntax: valid/);
});
test('workflow annotations and summaries treat any reported text as data', () => {
  const output = render({ repository: REPOSITORY, headSha: 'a'.repeat(40), status: 'invalid', message: 'Bad <script> & 10%\n::error::fake', line: 2, entries: [], sections: [] });
  assert.match(output.summary, /&lt;script&gt; &amp;/);
  assert.equal(output.annotations[0].split('\n').length, 1); assert.match(output.annotations[0], /10%25/);
  assert.doesNotMatch(output.summary, /<script>/);
});
test('unchanged changelog remains structurally valid after arbitrary code changes', t => {
  const config = fixture(t);
  fs.writeFileSync(path.join(config.workspace, 'Capture.swift'), 'manyPhotos()\n');
  config.git('add', '--all'); config.git('commit', '--quiet', '-m', 'Synthetic code fixture');
  const result = evaluate({ ...config, headSha: config.git('rev-parse', 'HEAD') });
  assert.equal(result.status, 'valid');
  assert.match(render(result).summary, /Code-to-wording coverage: not assessed/);
  assert.doesNotMatch(render(result).summary, /Covered or exempt/);
});
