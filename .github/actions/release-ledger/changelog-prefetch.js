'use strict';

const {execFile} = require('node:child_process');
const path = require('node:path');
const {TextDecoder} = require('node:util');

const SHA = /^[a-f0-9]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_BLOBS = 4096;

class PrefetchError extends Error {
  constructor(code, message) { super(message); this.name = 'PrefetchError'; this.code = code; }
}
const fail = (code, message) => { throw new PrefetchError(code, message); };
const label = value => JSON.stringify(value);

function configuration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('configuration', 'Provide trusted blob-prefetch configuration.');
  const {cwd, repository, head, base, releaseCommits, changelogPaths, githubToken} = input;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof repository !== 'string' ||
      !/^VeamStudios\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      typeof head !== 'string' || typeof base !== 'string' || !SHA.test(head) || !SHA.test(base) ||
      !Array.isArray(releaseCommits) || releaseCommits.length < 1 || releaseCommits.length > 8 ||
      releaseCommits.some(commit => typeof commit !== 'string' || !SHA.test(commit) || commit === ZERO_SHA)) {
    fail('configuration', 'Provide an absolute workspace, supported repository and full exact head/base/verified release commit hashes.');
  }
  if (!Array.isArray(changelogPaths) || changelogPaths.length < 1 || changelogPaths.length > 64 ||
      new Set(changelogPaths).size !== changelogPaths.length || changelogPaths.some(filePath => typeof filePath !== 'string' || filePath.length > 256 ||
        !/^(?:[A-Za-z0-9_.-]+\/)*CHANGELOG\.md$/.test(filePath) || filePath.split('/').some(part => part === '.' || part === '..'))) {
    fail('configuration', 'Provide distinct exact maintained changelog paths; globs and traversal are unsupported.');
  }
  if (githubToken !== undefined && (typeof githubToken !== 'string' || !githubToken || githubToken.length > 4096 || /[\r\n\0]/.test(githubToken))) {
    fail('configuration', 'Provide the existing read-only GitHub credential without header control characters.');
  }
  return {cwd, repository, head, base, releaseCommits: [...new Set(releaseCommits)].sort(), changelogPaths: [...changelogPaths].sort(), githubToken};
}

function reader(cwd) {
  // A fetch receives only its scoped ephemeral header. Other Git commands and
  // the assessment process receive neither this header nor any provider key.
  const env = {PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false'};
  let metadataBytes = 0;
  async function git(args, context, {input, fetchToken, timeout = 10000} = {}) {
    const childEnv = {...env};
    if (fetchToken !== undefined) {
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${fetchToken}`, 'utf8').toString('base64')}`;
      Object.assign(childEnv, {GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: header});
    }
    const result = await new Promise((resolve, reject) => {
      const child = execFile('git', ['--no-optional-locks', '--literal-pathspecs', '--no-replace-objects',
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=',
        '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', ...args],
      {cwd, env: childEnv, encoding: 'buffer', maxBuffer: MAX_METADATA_BYTES + 1, timeout, killSignal: 'SIGKILL'},
      (error, stdout) => {
        // Raw stderr/error objects may contain authentication details. Never
        // forward them, attach them as causes, or print the configured header.
        if (error) reject(new PrefetchError(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS' ? 'input_limit' : 'git_unavailable',
          `${context} could not complete. No source was truncated; check the trusted Git input/access and rerun.`));
        else resolve(stdout);
      });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
    metadataBytes += result.length;
    if (metadataBytes > MAX_METADATA_BYTES) fail('input_limit', 'Complete prefetch metadata exceeds the input bound; no files were omitted.');
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(result); }
    catch { fail('invalid_utf8', `${context} is not complete UTF-8 Git metadata.`); }
    return text;
  }
  async function commit(sha, role) {
    if ((await git(['rev-parse', '--verify', `${sha}^{commit}`], `${role} commit lookup`)).trim() !== sha) {
      fail('invalid_commit', `${role} must identify the exact full commit, without peeling another object.`);
    }
  }
  async function ancestor(older, newer, context) { await git(['merge-base', '--is-ancestor', older, newer], context); }
  async function objects(blobs) {
    const hashes = [...blobs].sort();
    if (!hashes.length) return [];
    const output = await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], 'Local blob completeness check', {input: hashes.join('\n') + '\n'});
    const lines = output.split('\n');
    if (lines.pop() !== '' || lines.length !== hashes.length) fail('incomplete_metadata', 'Local blob checks returned incomplete records.');
    return lines.map((line, index) => {
      if (line === `${hashes[index]} missing`) return {sha: hashes[index], missing: true};
      const match = line.match(/^([a-f0-9]{40}) blob (0|[1-9]\d*)$/);
      if (!match || match[1] !== hashes[index] || !Number.isSafeInteger(Number(match[2]))) fail('incomplete_metadata', 'A required blob has an unsupported type or incomplete size record.');
      return {sha: hashes[index], missing: false, size: Number(match[2])};
    });
  }
  return {git, commit, ancestor, objects};
}

async function hydrateEvidenceBlobs(input) {
  const config = configuration(input), local = reader(config.cwd), blobs = new Set();
  function addBlob(mode, sha, context) {
    if (!['100644', '100755'].includes(mode) || !SHA.test(sha) || sha === ZERO_SHA) fail('unsupported_file', `${context} is not a regular tracked blob; no symlinks or submodules were fetched.`);
    blobs.add(sha);
    if (blobs.size > MAX_BLOBS) fail('input_limit', `Complete evidence needs more than ${MAX_BLOBS} blobs; no source was sampled.`);
  }
  await local.commit(config.head, 'Head'); await local.commit(config.base, 'Base');
  try { await local.ancestor(config.base, config.head, 'Exact base ancestry'); }
  catch { fail('stale_base', 'Update the PR branch to contain the exact current base commit and complete ancestry, then rerun; no coverage was assessed.'); }
  // Verified distributed source may later be squash-merged. It must exist
  // exactly, but shipment is supplied by the trusted caller, not Git ancestry.
  for (const commit of config.releaseCommits) await local.commit(commit, 'Release');
  const raw = await local.git(['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules=none', config.base, config.head, '--'], 'Complete exact-commit diff');
  const records = raw ? raw.split('\0') : [];
  if (records.length && records.pop() !== '') fail('incomplete_metadata', 'Complete diff has an incomplete final record.');
  if (records.length % 2 || records.length / 2 > MAX_BLOBS) fail('input_limit', 'Complete diff exceeds its file bound or has incomplete records; no files were omitted.');
  const seen = new Set();
  for (let index = 0; index < records.length; index += 2) {
    const match = records[index].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/), filePath = records[index + 1];
    if (!match || !filePath || filePath.startsWith('/') || filePath.split('/').some(part => !part || part === '.' || part === '..') || seen.has(filePath)) fail('incomplete_metadata', 'Complete diff has an unsupported tracked-file record.');
    seen.add(filePath);
    const [, beforeMode, afterMode, beforeSha, afterSha, status] = match;
    const beforeMissing = beforeMode === '000000' && beforeSha === ZERO_SHA, afterMissing = afterMode === '000000' && afterSha === ZERO_SHA;
    if ((status === 'A' && (!beforeMissing || afterMissing)) || (status === 'D' && (!afterMissing || beforeMissing)) ||
        (['M', 'T'].includes(status) && (beforeMissing || afterMissing))) fail('incomplete_metadata', 'Complete diff has contradictory file identities.');
    if (!beforeMissing) addBlob(beforeMode, beforeSha, `Before file ${label(filePath)}`);
    if (!afterMissing) addBlob(afterMode, afterSha, `After file ${label(filePath)}`);
  }
  for (const commit of [...new Set([config.head, config.base, ...config.releaseCommits])]) {
    for (const filePath of config.changelogPaths) {
      const record = await local.git(['ls-tree', '-z', commit, '--', filePath], `Changelog tree ${label(filePath)}`);
      const match = record.match(/^(\d{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/);
      if (!match || match[3] !== filePath) fail('missing_changelog', `Changelog ${label(filePath)} is missing from an exact required commit; complete history must be restored.`);
      addBlob(match[1], match[2], `Changelog ${label(filePath)}`);
    }
  }
  const before = await local.objects(blobs), missing = before.filter(object => object.missing).map(object => object.sha);
  if (missing.length) {
    if (!config.githubToken) fail('missing_credential', 'The existing read-only GitHub credential is required to prefetch missing evidence blobs.');
    // Only reviewed repository identity and validated full object IDs reach Git.
    // The token is an environment-only scoped header, never an argv/config file.
    await local.git(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
      '--no-auto-maintenance', '--filter=blob:none', `https://github.com/${config.repository}.git`, '--stdin'], 'Trusted exact-blob fetch',
    {input: missing.join('\n') + '\n', fetchToken: config.githubToken, timeout: 120000});
  }
  const after = missing.length ? await local.objects(blobs) : before;
  if (after.some(object => object.missing)) fail('incomplete_fetch', 'Required evidence blobs remain unavailable after prefetch; no partial assessment was attempted.');
  if (after.reduce((sum, object) => sum + object.size, 0) > MAX_METADATA_BYTES) fail('input_limit', 'Complete evidence blobs exceed the two-MiB input bound; no content was truncated.');
  return {blobCount: blobs.size, fetchedBlobCount: missing.length};
}

module.exports = {hydrateEvidenceBlobs, PrefetchError};
