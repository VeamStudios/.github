const { execFileSync } = require('node:child_process');
const SERVICES = ['email', 'exporter', 'main', 'pdf'];
function validateCloudRun(v, commit, repository) {
  if (v?.kind !== 'cloud-run' || v.commit !== commit || v.repository !== repository || repository !== 'VeamStudios/CloudServices' || v.project !== 'veam-cloud-services' || v.region !== 'europe-west1' || !v.evidence || !Number.isFinite(Date.parse(v.checkedAt)) || !Array.isArray(v.components) || v.components.length !== SERVICES.length) throw new Error('Incomplete CloudServices production verification');
  for (const name of SERVICES) {
    const matches = v.components.filter(c => c.service === name);
    if (matches.length !== 1 || !matches[0].revision || matches[0].commit !== commit || matches[0].ready !== true || matches[0].trafficPercent !== 100) throw new Error(`CloudServices ${name} is not fully serving the shipped commit`);
  }
  return v;
}
function collectCloudRun({commit,repository,project,region,evidence}, read = args => JSON.parse(execFileSync('gcloud', args, {encoding:'utf8',timeout:30000}))) {
  const components = SERVICES.map(service => {
    const s = read(['run','services','describe',service,'--project',project,'--region',region,'--format=json']);
    const traffic = (s.status?.traffic || []).filter(t => t.percent > 0);
    if (!s.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') || traffic.length !== 1 || traffic[0].percent !== 100 || !traffic[0].revisionName) throw new Error(`${service} does not have one ready revision serving all production traffic`);
    const revision = traffic[0].revisionName;
    const rev = read(['run','revisions','describe',revision,'--project',project,'--region',region,'--format=json']);
    return {service,revision,commit:rev.metadata?.labels?.commit_hash,ready:rev.status?.conditions?.some(c=>c.type==='Ready'&&c.status==='True')===true,trafficPercent:100};
  });
  return validateCloudRun({kind:'cloud-run',commit,repository,project,region,evidence,checkedAt:new Date().toISOString(),components},commit,repository);
}
module.exports = {validateCloudRun,collectCloudRun};
if (require.main === module) {
  let verification = '';
  try { verification = JSON.stringify(collectCloudRun({commit:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,project:process.env.VERIFY_PROJECT,region:'europe-west1',evidence:`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`})); }
  catch (error) { console.warn(`::warning::${error.message}. The release recorder will retain pending verification.`); }
  require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, `verification=${verification}\n`);
}
