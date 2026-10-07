'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {hydrateEvidenceBlobs} = require('./changelog-prefetch');
const {collectEvidence} = require('./changelog-evidence');

const REPOSITORY = 'VeamStudios/Synthetic';
const TOKEN = 'synthetic-no-permission-test-credential';
const RELEASED = '## 1.0.0\n### Fixed\n- Shipped correction.\n';
const CURRENT = '## 1.1.0\n### Fixed\n- Upcoming correction.\n\n' + RELEASED;

function fixture(t, {squashedRelease = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-fixture-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), cwd = path.join(root, 'partial'), bin = path.join(root, 'bin'), log = path.join(root, 'calls.jsonl');
  fs.mkdirSync(source); fs.mkdirSync(bin);
  const realGit = execFileSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).trim();
  const env = {PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1'};
  const git = (where, ...args) => execFileSync(realGit, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args],
    {cwd: where, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const write = (filePath, text) => { fs.mkdirSync(path.dirname(path.join(source, filePath)), {recursive: true}); fs.writeFileSync(path.join(source, filePath), text); };
  const commit = message => { git(source, 'add', '--all'); git(source, 'commit', '--quiet', '--allow-empty', '-m', message); return git(source, 'rev-parse', 'HEAD'); };
  git(source, 'init', '--quiet', '--initial-branch=main'); git(source, 'config', 'user.name', 'Synthetic fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'config', 'uploadpack.allowFilter', 'true'); git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  write('CHANGELOG.md', RELEASED); write('App.js', 'before\n'); write('rename.txt', 'renamed contents\n'); write('deleted.txt', 'deleted contents\n');
  write('unrelated.txt', 'unrelated history and unchanged contents '.repeat(5000)); let release = commit('Synthetic released source');
  if (squashedRelease) {
    git(source, 'checkout', '--quiet', '-b', 'release-source'); write('CHANGELOG.md', CURRENT);
    release = commit('Synthetic verified source later squash merged');
    git(source, 'checkout', '--quiet', 'main'); write('main-only.js', 'not distributed in the verified source\n'); commit('Synthetic intervening main work');
    git(source, 'merge', '--squash', 'release-source');
    write('CHANGELOG.md', '## 1.2.0\n### Added\n- Unshipped main addition.\n\n' + CURRENT);
  } else write('CHANGELOG.md', CURRENT);
  const base = commit('Synthetic shared upcoming note');
  write('App.js', 'after\n'); fs.renameSync(path.join(source, 'rename.txt'), path.join(source, 'new-name.txt')); fs.unlinkSync(path.join(source, 'deleted.txt'));
  const head = commit('Synthetic PR');
  execFileSync(realGit, ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--filter=blob:none', '--no-checkout', `file://${source}`, cwd], {env, stdio: ['ignore', 'pipe', 'pipe']});
  const control = path.join(root, 'control.json'); fs.writeFileSync(control, '{}');
  // The proxy forwards real local Git reads. Fetch is intercepted to copy only
  // requested synthetic blobs from our own fixture, with no network or key use.
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\n'use strict';
const fs=require('node:fs'), cp=require('node:child_process');
const args=process.argv.slice(2), input=fs.readFileSync(0), control=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,input:input.toString('utf8'),auth:process.env.GIT_CONFIG_VALUE_1,
  inheritedGitDir:process.env.GIT_DIR,providerKey:process.env.CURSOR_API_KEY})+'\\n');
const env={PATH:${JSON.stringify(env.PATH)},GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'};
if(args.includes('diff')&&typeof control.raw==='string'){process.stdout.write(control.raw,()=>process.exit(0));}
else if(args.includes('fetch')){
 if(control.fail){process.stderr.write('raw secret '+process.env.GIT_CONFIG_VALUE_1);process.exit(17);}
 if(!control.incomplete)for(const sha of input.toString('utf8').trim().split('\\n')){
  const bytes=cp.execFileSync(${JSON.stringify(realGit)},['cat-file','blob',sha],{cwd:${JSON.stringify(source)},env});
  const found=cp.execFileSync(${JSON.stringify(realGit)},['hash-object','-w','--stdin'],{cwd:process.cwd(),env,input:bytes,encoding:'utf8'}).trim();
  if(found!==sha)process.exit(18);
 }
 process.exit(0);
}else{
const result=cp.spawnSync(${JSON.stringify(realGit)},args,{cwd:process.cwd(),env,input,maxBuffer:3*1024*1024});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??19);
}
`, {mode: 0o755});
  const savedPath = process.env.PATH; process.env.PATH = `${bin}:${savedPath}`; t.after(() => { process.env.PATH = savedPath; });
  const config = overrides => ({cwd, repository: REPOSITORY, head, base, releaseCommits: [release, release], changelogPaths: ['CHANGELOG.md'], githubToken: TOKEN, ...overrides});
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const objectStatus = sha => execFileSync(realGit, ['cat-file', '--batch-check'], {cwd, env, input: sha + '\n', encoding: 'utf8'});
  return {source, cwd, root, config, calls, git, objectStatus, control, release, base, head};
}

test('partial-clone hydration batches every exact required blob and leaves unrelated history missing', async t => {
  const f = fixture(t), unrelated = f.git(f.source, 'rev-parse', `${f.head}:unrelated.txt`);
  assert.match(f.objectStatus(unrelated), /missing/);
  const result = await hydrateEvidenceBlobs(f.config());
  assert.equal(result.blobCount, 6); assert.equal(result.fetchedBlobCount, 6);
  const fetches = f.calls().filter(call => call.args.includes('fetch')); assert.equal(fetches.length, 1);
  assert.ok(fetches[0].args.includes(`https://github.com/${REPOSITORY}.git`)); assert.ok(fetches[0].args.includes('--stdin'));
  assert.ok(fetches[0].input.trim().split('\n').every(sha => /^[a-f0-9]{40}$/.test(sha))); assert.equal(fetches[0].args.join(' ').includes(TOKEN), false);
  assert.equal(fetches[0].auth, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  assert.ok(f.calls().filter(call => !call.args.includes('fetch')).every(call => !call.auth));
  const evidence = collectEvidence({...f.config(), releaseCommit: f.release, changelogFormat: 'categorized'});
  assert.deepEqual(evidence.files.map(file => [file.path, file.status]), [['App.js', 'M'], ['deleted.txt', 'D'], ['new-name.txt', 'A'], ['rename.txt', 'D']]);
  assert.equal(evidence.entries[0].eligible, true); assert.equal(evidence.entries[1].eligible, false);
  const configText = fs.readFileSync(path.join(f.cwd, '.git', 'config'), 'utf8'); assert.doesNotMatch(configText, /extraheader|synthetic-no-permission/);
  assert.match(f.objectStatus(unrelated), /missing/);
  const second = await hydrateEvidenceBlobs(f.config({githubToken: undefined})); assert.equal(second.fetchedBlobCount, 0);
  assert.equal(f.calls().filter(call => call.args.includes('fetch')).length, 1);
});

test('prefetch accepts verified release source outside main ancestry after squash and preserves its exact notes', async t => {
  const f = fixture(t, {squashedRelease: true});
  assert.throws(() => f.git(f.cwd, 'merge-base', '--is-ancestor', f.release, f.base));
  const result = await hydrateEvidenceBlobs(f.config()); assert.ok(result.fetchedBlobCount > 0);
  const evidence = collectEvidence({...f.config(), releaseCommit: f.release, changelogFormat: 'categorized'});
  assert.equal(evidence.releaseCommit, f.release); assert.deepEqual(evidence.entries.map(entry => entry.eligible), [true, false, false]);
  assert.equal(evidence.entries[0].text, '- Unshipped main addition.');
  assert.equal(f.calls().filter(call => call.args.includes('fetch')).length, 1);
});

test('missing fetch credential is an input error and never triggers a network attempt', async t => {
  const f = fixture(t); await assert.rejects(hydrateEvidenceBlobs(f.config({githubToken: undefined})), error => error.code === 'missing_credential');
  assert.equal(f.calls().some(call => call.args.includes('fetch')), false);
});

test('fetch errors and incomplete hydration report static errors without token or raw stderr', async t => {
  const f = fixture(t); fs.writeFileSync(f.control, '{"fail":true}');
  await assert.rejects(hydrateEvidenceBlobs(f.config()), error => error.code === 'git_unavailable' && !error.message.includes(TOKEN) && !error.message.includes('AUTHORIZATION') && !error.message.includes('raw secret') && error.cause === undefined);
  const g = fixture(t); fs.writeFileSync(g.control, '{"incomplete":true}');
  await assert.rejects(hydrateEvidenceBlobs(g.config()), error => error.code === 'incomplete_fetch');
});

test('inherited Git workspace/config overrides and provider credentials do not reach the fetch process', async t => {
  const f = fixture(t), changes = {GIT_DIR: '/missing/untrusted', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: 'unsafe', CURSOR_API_KEY: 'synthetic-provider-credential'};
  const saved = Object.entries(changes).map(([key]) => [key, process.env[key]]);
  for (const [key, value] of Object.entries(changes)) process.env[key] = value;
  t.after(() => { for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await hydrateEvidenceBlobs(f.config());
  assert.ok(f.calls().every(call => !call.inheritedGitDir && !call.providerKey));
});

test('invalid scopes, short hashes, empty baselines, paths and header control characters fail before Git', async t => {
  const f = fixture(t);
  for (const overrides of [{repository: 'OtherOrg/App'}, {head: 'main'}, {base: f.base.slice(0, 8)}, {releaseCommits: []},
    {changelogPaths: ['../CHANGELOG.md']}, {changelogPaths: ['packages/*/CHANGELOG.md']}, {githubToken: 'bad\r\nheader'}]) {
    await assert.rejects(hydrateEvidenceBlobs(f.config(overrides)), error => error.code === 'configuration');
  }
  assert.equal(f.calls().length, 0);
});

test('stale heads, unavailable baseline hashes and missing historical changelogs fail before fetch', async t => {
  const f = fixture(t);
  await assert.rejects(hydrateEvidenceBlobs(f.config({head: f.release})), error => error.code === 'stale_base');
  await assert.rejects(hydrateEvidenceBlobs(f.config({releaseCommits: ['e'.repeat(40)]})), error => error.code === 'git_unavailable');
  await assert.rejects(hydrateEvidenceBlobs(f.config({changelogPaths: ['docs/CHANGELOG.md']})), error => error.code === 'missing_changelog');
  assert.equal(f.calls().some(call => call.args.includes('fetch')), false);
});

test('unsupported regular-file modes fail metadata preflight without fetching', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.control, JSON.stringify({raw: `:000000 120000 ${'0'.repeat(40)} ${'a'.repeat(40)} A\0linked.js\0`}));
  await assert.rejects(hydrateEvidenceBlobs(f.config()), error => error.code === 'unsupported_file');
  assert.equal(f.calls().some(call => call.args.includes('fetch')), false);
});

test('more than 4096 required blob identities fail the whole preflight without sampling', async t => {
  const f = fixture(t);
  const raw = Array.from({length: 2049}, (_, index) => `:100644 100644 ${(index * 2 + 1).toString(16).padStart(40, '0')} ${(index * 2 + 2).toString(16).padStart(40, '0')} M\0source-${index}.js\0`).join('');
  fs.writeFileSync(f.control, JSON.stringify({raw}));
  await assert.rejects(hydrateEvidenceBlobs(f.config()), error => error.code === 'input_limit' && /4096 blobs.*no source was sampled/.test(error.message));
  assert.equal(f.calls().some(call => call.args.includes('fetch')), false);
});
