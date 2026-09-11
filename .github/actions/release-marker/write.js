const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const shellQuote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
function writeMarker({ root = process.cwd(), repository, commit, config, output, predeploy = false }) {
  if (!/^[^/]+\/[^/]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Exact repository and commit are required');
  const marker = { schemaVersion: 1, repository, commit }, outputs = [];
  if (config) {
    const file = path.resolve(root, config), contents = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hosting = Array.isArray(contents.hosting) ? contents.hosting : [contents.hosting];
    for (const h of hosting) {
      if (!h?.public) throw new Error('Hosting public directory must be explicit');
      const target = path.join(h.public, 'release-info.json');
      outputs.push(target);
      h.headers = [...(h.headers || []).filter(x => x.source !== '/release-info.json'), { source: '/release-info.json', headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }] }];
      if (predeploy) {
        const payload = Buffer.from(JSON.stringify({ root: path.resolve(root), repository, commit, output: target })).toString('base64');
        const command = `node ${shellQuote(__filename)} --write-payload ${payload}`;
        h.predeploy = [...(Array.isArray(h.predeploy) ? h.predeploy : h.predeploy ? [h.predeploy] : []).filter(x => !x.includes(`${__filename}`)), command];
      }
    }
    fs.writeFileSync(file, JSON.stringify(contents, null, 2) + '\n');
  }
  if (output) outputs.push(output);
  if (!outputs.length) throw new Error('Specify firebase_config or output');
  for (const file of outputs) {
    const full = path.resolve(root, file);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Marker output must be inside the checkout');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(marker) + '\n');
  }
  return outputs;
}
if (require.main === module) {
  if (process.argv[2] === '--write-payload') writeMarker(JSON.parse(Buffer.from(process.argv[3], 'base64').toString()));
  else writeMarker({ repository: process.env.GITHUB_REPOSITORY, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), config: process.env.MARKER_FIREBASE_CONFIG, output: process.env.MARKER_OUTPUT, predeploy: process.env.MARKER_PREDEPLOY === 'true' });
}
module.exports = { writeMarker };
