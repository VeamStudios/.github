#!/usr/bin/env node
// Generate an additive repository ruleset. This file never calls GitHub.
const base = require('../../../docs/pr-flow/ruleset.json');
const profiles = require('./profiles.json');
function policy(repo) {
  const profile = profiles[repo];
  if (!profile) throw new Error(`Unknown repository: ${repo}`);
  const parts = ['Build', 'Run', 'Verify'].flatMap(name => profile[name]);
  const missing = parts.filter(part => part.missing);
  if (missing.length) throw new Error(`Cannot activate ${repo}: ${missing.map(part => part.missing).join(' ')}`);
  const ruleset = structuredClone(base);
  const checks = ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks;
  const contexts = new Set(checks.map(check => check.context));
  // Native checks change state as CI reruns. Summaries are asynchronous and must
  // never replace these source guards; keep both bound to the Actions app.
  for (const part of parts) if (!contexts.has(part.job)) {
    checks.push({ context: part.job, integration_id: 15368 });
    contexts.add(part.job);
  }
  return ruleset;
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(policy(process.argv[2]), null, 2) + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { policy };
