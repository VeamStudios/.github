const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');
const { writeMarker } = require('../release-marker/write');

const repository = 'VeamStudios/Test';
const commit = 'a'.repeat(40);

test('Firebase predeploy payloads avoid assignment syntax for every Base64 padding length', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-firebase-'));
  try {
    // Consecutive output lengths exercise zero, one, and two padding characters.
    const directories = ['dist', 'dista', 'distab'];
    const configPath = path.join(root, 'firebase.json');
    fs.writeFileSync(configPath, JSON.stringify({ hosting: directories.map((publicDir, i) => ({
      target: `site-${i}`, public: publicDir, predeploy: ['true'],
    })) }));
    const options = { root, repository, commit, config: 'firebase.json', predeploy: true };
    writeMarker(options);
    writeMarker(options);
    const { hosting } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const paddingLengths = new Set();
    for (const site of hosting) {
      const output = path.join(site.public, 'release-info.json');
      const payload = { root, repository, commit, output };
      const padded = Buffer.from(JSON.stringify(payload)).toString('base64');
      paddingLengths.add((padded.match(/=+$/) || [''])[0].length);
      assert.equal(site.predeploy.length, 2, 'repeated setup must not duplicate the hook');
      assert.equal(site.predeploy[0], 'true');
      const command = site.predeploy[1];
      const encoded = command.split('--write-payload ')[1];
      assert.ok(encoded);
      // Firebase passes the whole command to cross-env-shell, whose assignment
      // parser treats padded Base64 as an env setter and silently skips execution.
      assert.doesNotMatch(encoded, /=/);
      assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), payload);
      fs.rmSync(path.join(root, site.public), { recursive: true });
      execSync(command, { cwd: root });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, output), 'utf8')),
        { schemaVersion: 1, repository, commit });
      assert.deepEqual(site.headers, [{ source: '/release-info.json', headers: [
        { key: 'Cache-Control', value: 'no-store, max-age=0' },
      ] }]);
    }
    assert.deepEqual([...paddingLengths].sort(), [0, 1, 2]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the marker CLI still accepts previously generated padded payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-legacy-'));
  try {
    for (const output of ['dist/release-info.json', 'dista/release-info.json', 'distab/release-info.json']) {
      const payload = Buffer.from(JSON.stringify({ root, repository, commit, output })).toString('base64');
      execFileSync(process.execPath, [require.resolve('../release-marker/write'), '--write-payload', payload]);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, output), 'utf8')),
        { schemaVersion: 1, repository, commit });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
