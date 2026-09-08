const { execFileSync } = require('node:child_process');
const { workItems, validateNote } = require('./record');
function check(body, sha, read = (ref) => execFileSync('git', ['show', ref], { encoding: 'utf8' })) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Exact PR head SHA required');
  const path = String(body).match(/^Release note:\s*(\.release-notes\/[A-Za-z0-9_-]+\.json)\s*$/m)?.[1];
  if (!path) throw new Error('Add Release note: .release-notes/<change>.json to the PR description');
  return validateNote(JSON.parse(read(`${sha}:${path}`)), workItems(body));
}
module.exports = { check };
if (require.main === module) { try { check(process.env.PR_BODY, process.env.PR_HEAD_SHA); console.log('Release wording, classification, scope and Work Item links are valid.'); } catch(e) { console.error(e.message); process.exitCode=1; } }
