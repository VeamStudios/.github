const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const {parseWorkItemLinks}=require('./work-item-links');
const {newEntries,renderChangelog}=require('./changelog');
function check(body,sha,read=ref=>execFileSync('git',['show',ref],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),base=process.env.PR_BASE_SHA||`${sha}^1`) {
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Exact PR head SHA required');
  const warnings=[],links=parseWorkItemLinks(body);
  if(links.invalidEntries.length)warnings.push('Fix invalid Work Items links in the PR description.');
  let current='',previous='';try{current=read(`${sha}:CHANGELOG.md`)}catch{warnings.push('CHANGELOG.md is missing; a release PR can supply the customer-facing notes.');}
  try{previous=read(`${base}:CHANGELOG.md`)}catch{warnings.push('Cannot compare the changelog baseline; release-time verification will check the exact shipped range.');}
  const entries=newEntries(previous,current);
  if(current&&!entries.length)warnings.push('No new changelog entry in this PR. Internal-only changes need no customer note; customer-facing changes need one before announcement.');
  if(entries.some(e=>!/^fixed?$|^fixes$|^bug fixes$|^security$|^internal$/i.test(e.heading))&&!links.ids.length)warnings.push('Feature changelog entries need Work Items links.');
  return {warnings,changelog:renderChangelog(entries),workItems:links.ids};
}
module.exports={check};
if(require.main===module) {
  try {
    const result=check(process.env.PR_BODY,process.env.PR_HEAD_SHA);
    for(const warning of result.warnings)console.warn(`::warning::${warning}`);
    const summary=`## Release announcement preview\n\n${result.changelog||'No new customer-facing changelog entries in this PR.'}\n\n${result.workItems.length?'Work Items:\n'+result.workItems.map(id=>'- https://www.notion.so/'+id).join('\n'):'No linked Work Items.'}\n\n${result.warnings.map(w=>'- '+w).join('\n')}\n\nNormal PR review approves wording. Publication separately verifies shipped code and audience availability.\n`;
    if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
    console.log('Release preview complete. No release-note JSON file is required.');
  }catch(error){console.error(`::warning::Release preview could not complete: ${error.message}`)}
}
