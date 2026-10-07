'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {collectEvidence, evidenceDigest, MAX_INPUT_BYTES} = require('./changelog-evidence');

const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const RELEASED = '# App\n\n## 1.0.0\n### Fixed\n- Released correction.\n';
const upcoming = (note = 'New correction.') => `# App\n\n## 1.1.0\n### Fixed\n- ${note}\n\n## 1.0.0\n### Fixed\n- Released correction.\n`;

function fixture(t, files = {'CHANGELOG.md': RELEASED, 'App.js': 'const value = 1;\n'}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-evidence-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'});
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitInput = (args, input) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  const write = (filePath, text) => { fs.mkdirSync(path.dirname(path.join(cwd, filePath)), {recursive: true}); fs.writeFileSync(path.join(cwd, filePath), text); };
  const commit = message => { git('add', '--all'); git('commit', '--quiet', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet', '--initial-branch=main'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const [filePath, text] of Object.entries(files)) write(filePath, text);
  const releaseCommit = commit('Synthetic released source');
  const config = overrides => ({cwd, repository: REPOSITORY, head: git('rev-parse', 'HEAD'), base: releaseCommit, releaseCommit,
    changelogPaths: ['CHANGELOG.md'], changelogFormat: 'categorized', ...overrides});
  return {cwd, git, gitInput, write, commit, releaseCommit, config};
}

test('all exact-commit changed files and entire head entries are bound into deterministic evidence', t => {
  const f = fixture(t, {'CHANGELOG.md': RELEASED, 'App.js': 'before\n', 'deleted.txt': 'deleted content\n', 'untouched.txt': 'unchanged\n'});
  f.write('CHANGELOG.md', upcoming()); f.write('App.js', 'after\n'); f.write('new.txt', 'complete new content\n');
  fs.unlinkSync(path.join(f.cwd, 'deleted.txt'));
  const head = f.commit('Synthetic feature');
  f.write('App.js', 'uncommitted misleading code'); f.write('CHANGELOG.md', 'uncommitted invalid changelog');
  const evidence = collectEvidence(f.config({head}));
  assert.equal(evidence.schemaVersion, 1); assert.equal(evidence.head, head); assert.equal(evidence.base, f.releaseCommit);
  assert.deepEqual(evidence.files.map(file => [file.path, file.status]), [['App.js', 'M'], ['CHANGELOG.md', 'M'], ['deleted.txt', 'D'], ['new.txt', 'A']]);
  assert.deepEqual(evidence.files[0], {path: 'App.js', status: 'M', before: 'before\n', after: 'after\n'});
  assert.deepEqual(evidence.files[2], {path: 'deleted.txt', status: 'D', before: 'deleted content\n', after: null});
  assert.deepEqual(evidence.files[3], {path: 'new.txt', status: 'A', before: null, after: 'complete new content\n'});
  assert.deepEqual(evidence.entries, [
    {id: 'CHANGELOG.md:5', path: 'CHANGELOG.md', line: 5, heading: '1.1.0 / Fixed', text: '- New correction.', eligible: true},
    {id: 'CHANGELOG.md:9', path: 'CHANGELOG.md', line: 9, heading: '1.0.0 / Fixed', text: '- Released correction.', eligible: false},
  ]);
  assert.match(evidence.digest, /^[a-f0-9]{64}$/); assert.equal(evidence.digest, evidenceDigest(evidence));
  assert.deepEqual(collectEvidence(f.config({head})), evidence);
});

test('digest uses canonical sorted keys, excludes only digest and changes when evidence changes', () => {
  const a = {schemaVersion: 1, files: [{before: null, after: 'source', status: 'A', path: 'a.js'}], head: 'a'.repeat(40)};
  const b = {head: a.head, files: [{path: 'a.js', status: 'A', after: 'source', before: null}], schemaVersion: 1, digest: 'old'};
  assert.equal(evidenceDigest(a), evidenceDigest(b));
  const expected = createHash('sha256').update('{"files":[{"after":"source","before":null,"path":"a.js","status":"A"}],"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","schemaVersion":1}').digest('hex');
  assert.equal(evidenceDigest(a), expected);
  assert.notEqual(evidenceDigest(a), evidenceDigest({...a, files: [{...a.files[0], after: 'altered'}]}));
  assert.notEqual(evidenceDigest(a), evidenceDigest({...a, releaseCommits: ['b'.repeat(40)]}));
  const cycle = {}; cycle.self = cycle; assert.throws(() => evidenceDigest(cycle), /acyclic JSON/);
  assert.throws(() => evidenceDigest({missing: undefined}), /complete, acyclic JSON/);
});

test('tracked rename preserves the old and new paths, full contents and deletion/addition status', t => {
  const f = fixture(t); fs.renameSync(path.join(f.cwd, 'App.js'), path.join(f.cwd, 'Renamed.js'));
  f.commit('Synthetic rename');
  const evidence = collectEvidence(f.config());
  assert.deepEqual(evidence.files, [
    {path: 'App.js', status: 'D', before: 'const value = 1;\n', after: null},
    {path: 'Renamed.js', status: 'A', before: null, after: 'const value = 1;\n'},
  ]);
});

test('unchanged upcoming notes added after release remain eligible across separate code PRs', t => {
  const f = fixture(t); f.write('CHANGELOG.md', upcoming('Several photographs can be attached.'));
  const base = f.commit('Synthetic shared upcoming note');
  f.write('App.js', 'first code change\n'); const firstHead = f.commit('Synthetic first PR');
  const first = collectEvidence(f.config({base, head: firstHead}));
  f.git('checkout', '--quiet', '--detach', base); f.write('App.js', 'second code change\n'); const secondHead = f.commit('Synthetic second PR');
  const second = collectEvidence(f.config({base, head: secondHead}));
  assert.equal(first.files.some(file => file.path === 'CHANGELOG.md'), false);
  assert.equal(second.files.some(file => file.path === 'CHANGELOG.md'), false);
  assert.equal(first.entries[0].eligible, true); assert.equal(second.entries[0].eligible, true);
  assert.equal(first.entries[0].text, second.entries[0].text); assert.notEqual(first.digest, second.digest);
});

test('preexisting rewritten notes or later additions inside shipped release sections cannot become eligible', t => {
  const f = fixture(t);
  f.write('CHANGELOG.md', '# App\n\n## v1.0\n### Added\n- Entirely rewritten shipped wording.\n- A new bullet in an old version.\n');
  const base = f.commit('Synthetic rewrite already on base');
  f.write('App.js', 'unrelated code change\n'); f.commit('Synthetic feature preserves base history');
  assert.deepEqual(collectEvidence(f.config({base})).entries.map(entry => entry.eligible), [false, false]);
});

test('a historical version omitted from the release snapshot is still below its shipped frontier', t => {
  const f = fixture(t, {'CHANGELOG.md': '# App\n\n## 2.0.0\n### Fixed\n- Current released correction.\n'});
  f.write('CHANGELOG.md', '# App\n\n## 3.0.0\n### Added\n- Future change.\n\n## 2.0.0\n### Fixed\n- Current released correction.\n\n## 1.9.0\n### Fixed\n- Inserted historical change.\n');
  f.commit('Synthetic historical note');
  assert.deepEqual(collectEvidence(f.config()).entries.map(entry => entry.eligible), [true, false, false]);
});

test('shipped wording cannot be reused under an upcoming heading through style, metadata, case or whitespace changes', t => {
  const f = fixture(t, {'CHANGELOG.md': '# App\n\n## 1.0.0\n### Fixed\n- Released correction.\n  With complete details.\n  rcValue: old-flag\n'});
  f.write('CHANGELOG.md', '# App\n\n## Unreleased\n### Added\n* RELEASED   correction. With complete details.\n  rcValue: new-flag\n\n## 1.1.0\n### Fixed\n- Entirely new correction.\n\n## 1.0.0\n### Fixed\n- Released correction.\n  With complete details.\n  rcValue: old-flag\n');
  f.commit('Synthetic note reuse');
  const evidence = collectEvidence(f.config());
  assert.equal(evidence.entries[0].eligible, false); assert.equal(evidence.entries[1].eligible, true); assert.equal(evidence.entries[2].eligible, false);
  assert.equal(evidence.entries[0].text, '* RELEASED   correction. With complete details.\n  rcValue: new-flag');
});

test('notes present under Unreleased at verified shipped source are conservatively ineligible', t => {
  const f = fixture(t, {'CHANGELOG.md': '# App\n\n## Unreleased\n### Fixed\n- A note present in distributed source.\n\n## 1.0.0\n### Fixed\n- Released correction.\n'});
  f.write('CHANGELOG.md', '# App\n\n## Unreleased\n### Added\n- An actual upcoming feature.\n- A note present in distributed source.\n\n## 1.0.0\n### Fixed\n- Released correction.\n');
  f.commit('Synthetic upcoming source');
  assert.deepEqual(collectEvidence(f.config()).entries.map(entry => entry.eligible), [true, false, false]);
});

test('deployment sections use their shipped frontier and do not depend on text differences', t => {
  const f = fixture(t, {'CHANGELOG.md': '## deploy-12\n### Fixed\n- A deployed correction.\n'});
  f.write('CHANGELOG.md', '## deploy-13\n### Fixed\n- An upcoming deployment.\n\n## deploy-12\n### Fixed\n- A deployed correction.\n\n## deploy-11\n### Fixed\n- Inserted old deployment.\n');
  f.commit('Synthetic deployment note');
  assert.deepEqual(collectEvidence(f.config()).entries.map(entry => entry.eligible), [true, false, false]);
});

test('multiple verified targets conservatively union shipped notes and canonicalize identical source commits', t => {
  const f = fixture(t, {'CHANGELOG.md': '## Unreleased\n### Fixed\n- First target shipped wording.\n\n## 1.0.0\n### Fixed\n- Released correction.\n'});
  f.write('CHANGELOG.md', '## 1.1.0\n### Fixed\n- Second target shipped wording.\n\n## 1.0.0\n### Fixed\n- Released correction.\n');
  const secondRelease = f.commit('Synthetic second shipped target');
  f.write('CHANGELOG.md', '## Unreleased\n### Added\n- First target shipped wording.\n- Second target shipped wording.\n- Upcoming wording.\n\n## 1.1.0\n### Fixed\n- Second target shipped wording.\n\n## 1.0.0\n### Fixed\n- Released correction.\n');
  f.commit('Synthetic multi-target future');
  const commits = [secondRelease, f.releaseCommit];
  const evidence = collectEvidence(f.config({base: secondRelease, releaseCommit: undefined, releaseCommits: commits}));
  assert.deepEqual(evidence.releaseCommits, [...commits].sort()); assert.equal(evidence.releaseCommit, evidence.releaseCommits[0]);
  assert.deepEqual(evidence.entries.map(entry => entry.eligible), [false, false, true, false, false]);
  const repeated = collectEvidence(f.config({base: secondRelease, releaseCommit: undefined, releaseCommits: [secondRelease, secondRelease]}));
  assert.deepEqual(repeated.releaseCommits, [secondRelease]);
  assert.notEqual(evidence.digest, repeated.digest);
  assert.throws(() => collectEvidence(f.config({releaseCommits: [secondRelease]})), /singular release commit must belong/);
});

test('multiple maintained paths retain independent version frontiers and all entries, including unchanged files', t => {
  const first = 'packages/first/CHANGELOG.md', second = 'packages/second/CHANGELOG.md';
  const f = fixture(t, {[first]: '## 20.0.0\n### Fixed\n- First package shipped.\n', [second]: RELEASED, 'App.js': 'before\n'});
  f.write(first, '## 21.0.0\n### Added\n- First package future.\n\n## 20.0.0\n### Fixed\n- First package shipped.\n');
  f.write(second, upcoming('Second package future.')); const base = f.commit('Synthetic package notes');
  f.write('App.js', 'after\n'); f.commit('Synthetic code PR');
  const evidence = collectEvidence(f.config({base, changelogPaths: [second, first]}));
  assert.deepEqual(evidence.entries.map(entry => [entry.path, entry.eligible]), [[first, true], [first, false], [second, true], [second, false]]);
  assert.deepEqual(evidence.files.map(file => file.path), ['App.js']);
});

test('component and flat formats preserve complete source entries and one-based CRLF locations', t => {
  for (const [format, released, current, expectedHeading, expectedText] of [
    ['flat', '## 1.0.0\n- Shipped flat note.\n', '## 1.1.0\r\n- Future flat note.\r\n  Complete continuation.\r\n\r\n## 1.0.0\r\n- Shipped flat note.\r\n', '1.1.0', '- Future flat note.\n  Complete continuation.'],
    ['components', '## 1.0.0\n### App\n#### Fixed\n- Shipped component note.\n', '## 1.1.0\r\n### App\r\n#### Added\r\n- Future component note.\r\n  previewTag: internal\r\n\r\n## 1.0.0\r\n### App\r\n#### Fixed\r\n- Shipped component note.\r\n', '1.1.0 / App / Added', '- Future component note.\n  previewTag: internal'],
  ]) {
    const f = fixture(t, {'CHANGELOG.md': released}); f.write('CHANGELOG.md', current); f.commit('Synthetic format feature');
    const evidence = collectEvidence(f.config({changelogFormat: format}));
    assert.equal(evidence.entries[0].heading, expectedHeading); assert.equal(evidence.entries[0].text, expectedText);
    assert.equal(evidence.entries[0].line, format === 'flat' ? 2 : 4); assert.equal(evidence.entries[0].eligible, true);
    assert.equal(evidence.files[0].after, current);
  }
});

test('full SHA commit identities and a verified release baseline are mandatory', t => {
  const f = fixture(t);
  for (const overrides of [{head: 'main'}, {base: f.releaseCommit.slice(0, 10)}, {head: [f.releaseCommit]}, {releaseCommit: [f.releaseCommit]}, {head: 'e'.repeat(40)}, {base: 'e'.repeat(40)}, {releaseCommit: 'e'.repeat(40)}]) {
    assert.throws(() => collectEvidence(f.config(overrides)), /full|could not be read completely/);
  }
  assert.throws(() => collectEvidence(f.config({releaseCommit: undefined})), /verified release baseline is required/);
  assert.throws(() => collectEvidence(f.config({releaseCommit: undefined, releaseCommits: []})), /one to eight/);
  f.git('tag', '-a', 'synthetic-tag', '-m', 'Synthetic tag');
  assert.throws(() => collectEvidence(f.config({head: f.git('rev-parse', 'synthetic-tag')})), /without peeling another object/);
});

test('verified released PR source remains exact after a squash merge and does not ship intervening main notes', t => {
  const f = fixture(t); f.git('checkout', '--quiet', '-b', 'release-source');
  f.write('CHANGELOG.md', upcoming('Actually shipped branch correction.')); f.write('released.js', 'distributed behaviour\n');
  const releasedSource = f.commit('Synthetic independently verified released source');
  f.git('checkout', '--quiet', 'main'); f.write('main-only.js', 'not distributed in that source\n'); f.commit('Synthetic intervening main work');
  f.git('merge', '--squash', 'release-source');
  const current = '# App\n\n## 1.2.0\n### Added\n- Unshipped main addition.\n\n' + upcoming('Actually shipped branch correction.').replace(/^# App\n\n/, '');
  f.write('CHANGELOG.md', current); const base = f.commit('Synthetic squash merge retaining unreleased main note');
  assert.throws(() => f.git('merge-base', '--is-ancestor', releasedSource, base));
  assert.notEqual(f.git('rev-parse', `${releasedSource}^{tree}`), f.git('rev-parse', `${base}^{tree}`));
  f.write('App.js', 'new PR change\n'); f.commit('Synthetic refreshed PR');
  const evidence = collectEvidence(f.config({base, releaseCommit: releasedSource}));
  assert.equal(evidence.releaseCommit, releasedSource);
  assert.deepEqual(evidence.entries.map(entry => entry.eligible), [true, false, false]);
  assert.equal(evidence.entries[0].text, '- Unshipped main addition.');
  f.write('CHANGELOG.md', current.replace('Actually shipped branch correction.', 'PR rewrites the published wording.')); f.commit('Synthetic history rewrite');
  assert.throws(() => collectEvidence(f.config({base, releaseCommit: releasedSource})), error => error.code === 'published_history_change');
});

test('stale or diverged PR heads fail before unrelated base changes can enter the evidence', t => {
  const f = fixture(t); f.git('checkout', '--quiet', '-b', 'feature'); f.write('App.js', 'feature code\n');
  const head = f.commit('Synthetic PR head'); f.git('checkout', '--quiet', 'main');
  f.write('unrelated-main.txt', 'unrelated main behavior\n'); const base = f.commit('Synthetic advanced main');
  assert.throws(() => collectEvidence(f.config({head, base})), error => error.code === 'stale_base' && /Update the PR branch.*no changelog coverage was assessed/.test(error.message));
  assert.throws(() => collectEvidence(f.config({head: f.releaseCommit, base})), error => error.code === 'stale_base');
});

test('missing configured head or release changelog paths fail complete-history input', t => {
  const f = fixture(t); f.write('docs/CHANGELOG.md', upcoming()); f.commit('Synthetic new path');
  assert.throws(() => collectEvidence(f.config({changelogPaths: ['docs/CHANGELOG.md']})), /missing.*complete release history/);
  fs.unlinkSync(path.join(f.cwd, 'CHANGELOG.md')); f.commit('Synthetic removed changelog');
  assert.throws(() => collectEvidence(f.config()), /missing.*complete release history/);
});

test('malformed released or head changelogs fail parsing and preserve the configured source path', t => {
  const filePath = 'packages/example/CHANGELOG.md';
  for (const malformedRelease of [false, true]) {
    const bad = '## 1.0.0\n- A category is missing.\n';
    const f = fixture(t, {[filePath]: malformedRelease ? bad : RELEASED});
    f.write(filePath, malformedRelease ? upcoming() : bad); f.commit('Synthetic malformed source');
    assert.throws(() => collectEvidence(f.config({changelogPaths: [filePath]})), error => error.code === 'invalid_changelog' && error.details.ref.path === filePath);
  }
});

test('binary and invalid UTF8 changed blobs fail instead of being omitted, including deleted files', t => {
  for (const binary of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe]), Buffer.from([1, 2, 3])]) {
    const f = fixture(t); f.write('binary.bin', binary); f.commit('Synthetic binary file');
    assert.throws(() => collectEvidence(f.config()), /binary control bytes|valid UTF-8/);
  }
  const f = fixture(t, {'CHANGELOG.md': RELEASED, 'deleted.bin': Buffer.from([0, 1])});
  fs.unlinkSync(path.join(f.cwd, 'deleted.bin')); f.commit('Synthetic binary deletion');
  assert.throws(() => collectEvidence(f.config()), /binary control bytes/);
});

test('symlinks and submodule objects on either side are unsupported regular-file evidence', t => {
  const f = fixture(t); fs.symlinkSync('App.js', path.join(f.cwd, 'linked.js')); f.commit('Synthetic symlink');
  assert.throws(() => collectEvidence(f.config()), /tracked regular Git blob/);
  const g = fixture(t); fs.unlinkSync(path.join(g.cwd, 'App.js')); fs.symlinkSync('CHANGELOG.md', path.join(g.cwd, 'App.js')); g.commit('Synthetic type change');
  assert.throws(() => collectEvidence(g.config()), /tracked regular Git blob/);
  const h = fixture(t); h.git('update-index', '--add', '--cacheinfo', `160000,${h.releaseCommit},submodule`);
  h.git('commit', '--quiet', '-m', 'Synthetic submodule');
  assert.throws(() => collectEvidence(h.config()), /tracked regular Git blob/);
});

test('permission changes fail explicitly because the evidence schema cannot represent them', t => {
  const f = fixture(t); fs.chmodSync(path.join(f.cwd, 'App.js'), 0o755); f.commit('Synthetic executable permission');
  assert.throws(() => collectEvidence(f.config()), error => error.code === 'unsupported_permission_change' && /changes executable permissions.*No coverage was assessed/.test(error.message));
  const g = fixture(t); g.write('added.sh', '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(g.cwd, 'added.sh'), 0o755); g.commit('Synthetic new executable text');
  assert.equal(collectEvidence(g.config()).files[0].after, '#!/bin/sh\nexit 0\n');
});

test('PR changes to shipped wording, metadata or version placement fail before assessment', t => {
  for (const changed of [
    '## 1.0.0\n### Fixed\n- Rewritten released correction.\n',
    '## 1.0.0\n### Fixed\n- Different retained note.\n',
    '## 1.1.0\n### Fixed\n- Released correction.\n\n## 1.0.0\n### Fixed\n- Other historical note.\n',
    '## 1.0.0\n### Fixed\n- Released correction.\n  rcValue: new-flag\n',
  ]) {
    const f = fixture(t); f.write('CHANGELOG.md', changed); f.commit('Synthetic published-history change');
    assert.throws(() => collectEvidence(f.config()), error => error.code === 'published_history_change');
  }
});

test('published history comparison accepts parsed cosmetic changes and preserves duplicate counts', t => {
  const f = fixture(t); f.write('CHANGELOG.md', '## v1.0\r\n### FIXED\r\n* RELEASED   correction.\r\n'); f.commit('Synthetic cosmetic formatting');
  assert.equal(collectEvidence(f.config()).entries[0].eligible, false);
  const g = fixture(t, {'CHANGELOG.md': '## 1.0.0\n### Fixed\n- Duplicate published note.\n- Duplicate published note.\n'});
  g.write('CHANGELOG.md', '## 1.0.0\n### Fixed\n- Duplicate published note.\n'); g.commit('Synthetic removed duplicate');
  assert.throws(() => collectEvidence(g.config()), error => error.code === 'published_history_change');
});

test('baseline Unreleased notes cannot be deleted while a later duplicate can be removed', t => {
  const f = fixture(t, {'CHANGELOG.md': '## Unreleased\n### Fixed\n- Shipped without a numbered heading.\n\n## 1.0.0\n### Fixed\n- Released correction.\n'});
  f.write('CHANGELOG.md', RELEASED); f.commit('Synthetic removed distributed Unreleased note');
  assert.throws(() => collectEvidence(f.config()), error => error.code === 'published_history_change');
  const g = fixture(t); g.write('CHANGELOG.md', upcoming('Released correction.')); const base = g.commit('Synthetic unshipped duplicate note');
  g.write('CHANGELOG.md', RELEASED); g.commit('Synthetic upcoming duplicate cleanup');
  assert.equal(collectEvidence(g.config({base})).entries[0].eligible, false);
});

test('shell-looking filenames and repository external helpers remain inert data', t => {
  const f = fixture(t); const marker = path.join(f.cwd, 'COLLECTOR_EXECUTED');
  const helper = path.join(f.cwd, '.git', 'unsafe-helper'); fs.writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, {mode: 0o755});
  f.git('config', 'diff.external', helper); f.git('config', 'diff.untrusted.command', helper); f.git('config', 'diff.untrusted.textconv', helper); f.git('config', 'core.fsmonitor', helper);
  const filePath = '$(touch COLLECTOR_EXECUTED);`unsafe`\t\n.js';
  f.write(filePath, 'literal filename contents\n'); f.write('.gitattributes', '*.js diff=untrusted\n'); f.write('App.js', 'changed source\n'); f.commit('Synthetic hostile names/config');
  const evidence = collectEvidence(f.config());
  assert.ok(evidence.files.some(file => file.path === filePath && file.after === 'literal filename contents\n'));
  assert.equal(fs.existsSync(marker), false);
});

test('inherited Git configuration/workspace overrides and replace objects cannot alter exact evidence', t => {
  const f = fixture(t); f.write('App.js', 'original exact source\n'); const head = f.commit('Synthetic original head');
  f.write('App.js', 'replacement source\n'); const replacement = f.commit('Synthetic replacement'); f.git('replace', head, replacement);
  const keys = ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = keys.map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.GIT_DIR = path.join(f.cwd, 'missing-git'); process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'diff.external'; process.env.GIT_CONFIG_VALUE_0 = '/missing-untrusted-executable';
  const evidence = collectEvidence(f.config({head}));
  assert.equal(evidence.files[0].after, 'original exact source\n');
});

test('unavailable blob objects fail complete reads without falling back to working-tree copies', t => {
  const f = fixture(t); f.write('App.js', 'committed exact source\n'); const head = f.commit('Synthetic head');
  const blob = f.git('rev-parse', `${head}:App.js`);
  fs.unlinkSync(path.join(f.cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  assert.throws(() => collectEvidence(f.config({head})), /could not be read completely/);
});

test('invalid UTF8 tracked filenames fail rather than being replaced or dropped', t => {
  // Construct a real tree without checking out an invalid name on filesystems
  // that require Unicode filenames (including this macOS execution workspace).
  const f = fixture(t), changelog = f.git('rev-parse', `${f.releaseCommit}:CHANGELOG.md`);
  const source = f.gitInput(['hash-object', '-w', '--stdin'], 'source\n');
  const tree = f.gitInput(['mktree', '-z'], Buffer.concat([
    Buffer.from(`100644 blob ${changelog}\tCHANGELOG.md\0`), Buffer.from(`100644 blob ${source}\t`), Buffer.from([0xff]), Buffer.from('.txt\0'),
  ]));
  const head = f.gitInput(['commit-tree', tree, '-p', f.releaseCommit], 'Synthetic non-UTF8 filename\n');
  assert.throws(() => collectEvidence(f.config({head})), /valid UTF-8/);
});

test('a single oversized file and aggregate complete before/after input fail explicit bounds', t => {
  const f = fixture(t); f.write('large.txt', 'x'.repeat(MAX_INPUT_BYTES + 1)); f.commit('Synthetic oversized source');
  assert.throws(() => collectEvidence(f.config()), /input bound.*no input was truncated/);
  const g = fixture(t, {'CHANGELOG.md': RELEASED, 'one.txt': 'a'.repeat(600000), 'two.txt': 'b'.repeat(600000)});
  g.write('one.txt', 'c'.repeat(600000)); g.write('two.txt', 'd'.repeat(600000)); g.commit('Synthetic aggregate source');
  assert.throws(() => collectEvidence(g.config()), /input bound.*no input was truncated/);
});

test('full serialized entry/diff duplication is bounded too; no entries are truncated', t => {
  const f = fixture(t);
  const notes = Array.from({length: 3000}, (_, index) => `- Future ${index}: ${'ordinary wording '.repeat(23)}\n`).join('');
  f.write('CHANGELOG.md', `## 1.1.0\n### Added\n${notes}\n${RELEASED.replace(/^# App\n\n/, '')}`); f.commit('Synthetic oversized serialized evidence');
  assert.throws(() => collectEvidence(f.config()), /serialized changelog evidence exceeds.*no source or entries were truncated/);
});

test('oversized individual changelog lines fail before link parsing without truncation', t => {
  const f = fixture(t); f.write('CHANGELOG.md', upcoming('x'.repeat(4097))); f.commit('Synthetic long source line');
  assert.throws(() => collectEvidence(f.config()), /4096-byte complete source-line bound.*no line was truncated/);
});

test('too many changed files fail the whole input instead of sampling files', t => {
  const f = fixture(t); for (let index = 0; index < 4097; index++) f.write(`many/${index}.txt`, 'x\n'); f.commit('Synthetic many-file change');
  assert.throws(() => collectEvidence(f.config()), /file bound.*no files were omitted/);
});

test('untrusted repository scope, path globs/traversal and unsupported formats are rejected', t => {
  const f = fixture(t);
  for (const repository of ['OtherOrg/App', 'VeamStudios/..', 'VeamStudios/App/extra']) assert.throws(() => collectEvidence(f.config({repository})), /supported VeamStudios/);
  for (const changelogPaths of [[], ['CHANGELOG.md', 'CHANGELOG.md'], ['../CHANGELOG.md'], ['packages/*/CHANGELOG.md'], ['/CHANGELOG.md'], ['source.js']]) {
    assert.throws(() => collectEvidence(f.config({changelogPaths})), /distinct exact maintained/);
  }
  assert.throws(() => collectEvidence(f.config({changelogFormat: 'unknown'})), /supported explicit changelog format/);
});
