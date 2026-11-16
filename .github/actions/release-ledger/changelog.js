const {readState}=require('./automation-state');
const crypto = require('node:crypto');
const { parseWorkItemLinks } = require('./work-item-links');
const { WEBSITES, verifiedSync, websiteChanges } = require('./website-changelog');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => value.replace(/\s+/g,' ').trim();
const identity = e => normalized(e.summary.replace(/\s*\[(?:Work Item|PR|source)\]\(https?:\/\/[^)]+\)/gi,'').replace(/\[([^\]]+)\]\((?:https:\/\/(?:www\.)?notion\.so\/|https:\/\/app\.notion\.com\/p\/|https:\/\/github\.com\/)[^)]+\)/g,'$1'));

function parseChangelog(input) {
  const entries=[];let version='',heading='',entry;
  for(const line of String(input).split(/\r?\n/)) {
    const h2=line.match(/^##\s+(?:\[([^\]]+)\]|(.+?))(?:\s+-\s+\d{4}-\d\d-\d\d)?\s*$/);
    if(h2){version=(h2[1]||h2[2]).replace(/^v(?=\d)/,'');heading='';entry=null;continue}
    const h3=line.match(/^###\s+(.+?)\s*$/);
    if(h3){heading=h3[1];entry=null;continue}
    if(!version)continue;
    const bullet=line.match(/^[-*]\s+(.+)/);
    if(bullet){entry={version,heading:heading||'Changes',summary:bullet[1],flagKeys:[],previewTag:'',workItems:[],prRefs:[]};entries.push(entry);continue}
    if(entry && /^\s+\S/.test(line)) {
      const metadata=line.match(/^\s+(rcValue|previewTag):\s*(.+?)\s*$/);
      if(metadata){if(metadata[1]==='rcValue')entry.flagKeys.push(metadata[2]);else entry.previewTag=metadata[2]}
      else entry.summary+='\n'+line.trim();
    }
  }
  for(const e of entries) {
    const urls=[...e.summary.matchAll(/https:\/\/(?:www\.)?(?:notion\.so|app\.notion\.com)\/[^\s)]+/g)].map(x=>x[0]);
    e.workItems=parseWorkItemLinks('Work Items:\n'+urls.map(url=>'- '+url).join('\n')).ids;
    e.prRefs=[...e.summary.matchAll(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g)].map(x=>({repository:x[1],number:Number(x[2])}));
  }
  return entries;
}
function renderChangelog(entries) {
  const lines=[];let heading='',version='';const multiple=new Set(entries.map(e=>e.version||e.sourceVersion)).size>1;
  for(const e of entries){const v=e.version||e.sourceVersion;if(multiple&&v!==version){version=v;heading='';lines.push(`## ${v}`,'')};if(e.heading!==heading){heading=e.heading;lines.push(`### ${heading}`,'')};lines.push(`- ${e.summary}`,'')}
  return lines.join('\n').trim();
}
function newEntries(before,after){
  const old=parseChangelog(before),next=parseChangelog(after),matched=new Set();
  // Preserve duplicate counts: a repeated fix in a new version is new, while a
  // section move consumes the existing occurrence and cannot announce it twice.
  for(const exactVersion of [true,false])for(let i=0;i<next.length;i++) {
    if(matched.has(i))continue;
    const j=old.findIndex(e=>e&&identity(e)===identity(next[i])&&(!exactVersion||e.version===next[i].version));
    if(j>=0){old[j]=null;matched.add(i)}
  }
  return next.filter((_,i)=>!matched.has(i));
}
function internalFiles(files){return files.length>0 && files.every(f=> /^(?:\.github\/|\.release-notes\/|docs\/|README(?:\.|$)|LICENSE|.*\.md$)/.test(f.filename) && f.filename!=='CHANGELOG.md')}

// patch-id pairs a commit with its cherry-picks; merges and empty commits have none.
function patchIds(...revs) {
  const {execFileSync}=require('node:child_process'),options={encoding:'utf8',maxBuffer:64*1024*1024};
  const log=execFileSync('git',['log','-p','--no-color','--no-ext-diff','--format=commit %H',...revs],options);
  const out=execFileSync('git',['patch-id','--verbatim'],{...options,input:log});
  return new Map(out.split('\n').filter(Boolean).map(line=>{const [id,commit]=line.split(' ');return [commit,id]}));
}
function readChangelog(ref,runGit=require('./record').git) {
  // An absent path is valid for early history; an unreadable Git object is not.
  if(!runGit('ls-tree',ref,'--','CHANGELOG.md').trim())return '';
  return runGit('show',`${ref}:CHANGELOG.md`);
}
async function mergedWording(config,gh) {
  const pr=await gh(`/repos/${config.repo}/pulls/${config.wordingPr}`);
  if(pr.number!==config.wordingPr || pr.state!=='closed' || !pr.merged_at ||
    pr.base?.repo?.full_name!==config.repo || !/^[a-f0-9]{40}$/.test(pr.head?.sha||'') ||
    !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha||''))throw new Error('The supplemental changelog needs a merged PR in the shipped repository');
  const head=await gh(`/repos/${config.repo}/contents/CHANGELOG.md?ref=${pr.head.sha}`);
  const merged=await gh(`/repos/${config.repo}/contents/CHANGELOG.md?ref=${pr.merge_commit_sha}`);
  if([head,merged].some(f=>f.encoding!=='base64'||typeof f.content!=='string'||!/^[a-f0-9]{40}$/.test(f.sha||'')))throw new Error('Merged supplemental changelog content is unavailable');
  if(head.sha!==merged.sha || Buffer.from(head.content,'base64').toString('utf8')!==Buffer.from(merged.content,'base64').toString('utf8'))throw new Error('Supplemental changelog differs from the content accepted by the merge');
  // Merge is the acceptance decision; branch protections govern its reviews.
  // Retain explicit merge evidence without claiming a separate human review.
  return {pr,file:merged,acceptance:{kind:'merged-pr',mergeCommit:pr.merge_commit_sha,mergedAt:pr.merged_at}};
}

// A fix copied onto a release branch has no PR of its own. Its subject must name
// the merged PR, and its diff must equal that PR's reviewed merge commit.
async function copiedPr(config,gh,commit,runGit=require('./record').git,ids=patchIds) {
  const number=Number(runGit('log','-1','--format=%s',commit).match(/\(#(\d+)\)$/)?.[1]);
  if(!number)return undefined;
  try{
    const pr=await gh(`/repos/${config.repo}/pulls/${number}`);
    if(!pr.merged_at||pr.base?.repo?.full_name!==config.repo||!/^[a-f0-9]{40}$/.test(pr.merge_commit_sha||''))return undefined;
    const id=ids('-1',commit).get(commit);return id&&id===ids('-1',pr.merge_commit_sha).get(pr.merge_commit_sha)?number:undefined;
  }catch{return undefined}
}
// Provenance is information for the release page: it never decides what is announced.
async function provenance(config,gh,sha,baseline,notion,website) {
  const {git,ancestor,reviewed,provenanceMapping,text}=require('./record');
  const issues=[],prs=[],contexts=[],syncs=[],workItemSnapshots=[],unmapped=[];
  let validBaseline=false,diverged=null;
  try {
    const mapping=await provenanceMapping(config,gh,sha,baseline);
    const shaBaseline=Boolean(baseline&&/^[a-f0-9]{40}$/.test(baseline));
    // A baseline on a release branch is not an ancestor of the next release; measure from where the histories meet.
    const mergeBase=shaBaseline&&!ancestor(baseline,sha)&&!mapping?(()=>{try{return git('merge-base',baseline,sha)}catch{return ''}})():'';
    diverged=/^[a-f0-9]{40}$/.test(mergeBase)?{mergeBase}:null;
    validBaseline=Boolean(shaBaseline&&(ancestor(baseline,sha)||mapping||diverged));
    if(!validBaseline)issues.push('No verified previous production commit, so shipped PRs were not listed.');
    const commits=validBaseline?git('rev-list','--reverse',`${baseline}..${sha}`).split('\n').filter(Boolean):[];
    const numbers=new Set(),commitPrs=new Map(),copied=new Set();
    for(const commit of commits){const associated=[];for(let page=1;;page++){const rows=await gh(`/repos/${config.repo}/commits/${commit}/pulls?per_page=100&page=${page}`);associated.push(...rows);if(rows.length<100)break};const included=associated.filter(p=>p.base?.repo?.full_name===config.repo && p.merged_at && p.merge_commit_sha && ancestor(p.merge_commit_sha,sha));let number=mapping?.commits[commit]||(included.length===1?included[0].number:undefined);if(!number&&(number=await copiedPr(config,gh,commit,git)))copied.add(number);if(number){numbers.add(number);commitPrs.set(commit,number)}else{const sync=website?await verifiedSync(config.repo,commit,gh,git):null;if(sync)syncs.push(sync);else unmapped.push(commit)}}
    if(unmapped.length)issues.push(`Shipped commits without a PR: ${unmapped.join(', ')}.`);
    const read=ref=>readChangelog(ref,git);
    // Main's copy of a fix the previous release already shipped belongs to that release.
    const carried=new Set(diverged?[...git('log','--format=%B',`${sha}..${baseline}`).matchAll(/\(#(\d+)\)$/gm)].map(m=>Number(m[1])):[]);
    for(const number of [...numbers].sort((a,b)=>a-b)) {
      const pr=await gh(`/repos/${config.repo}/pulls/${number}`),links=parseWorkItemLinks(pr.body),files=[];
      if(!pr.merged_at || pr.base?.repo?.full_name!==config.repo || (!ancestor(pr.merge_commit_sha,sha)&&!mapping&&!copied.has(number))){issues.push(`PR #${number} could not be confirmed in the shipped commit.`);continue}
      for(let page=1;;page++){const batch=await gh(`/repos/${config.repo}/pulls/${number}/files?per_page=100&page=${page}`);files.push(...batch);if(batch.length<100)break}
      const added=newEntries(read(`${pr.merge_commit_sha}^1`),read(pr.merge_commit_sha)),approved=await reviewed(gh,config.repo,pr);
      const prior=carried.has(number),workItems=prior?[]:links.ids;
      if(links.invalidEntries.length)issues.push(`PR #${number}: the Work Items link in the PR description is invalid.`);
      // Website repos keep no CHANGELOG.md of their own.
      if(!added.length&&!prior&&!internalFiles(files)&&!website)issues.push(`PR #${number} has no changelog entry of its own.`);
      prs.push({number,url:pr.html_url,mergeCommit:pr.merge_commit_sha,headCommit:pr.head.sha,workItems,approved,noteHash:'',...(prior?{carried:true}:{})});
      contexts.push({pr,links:workItems,added,approved,files,commits:[...commitPrs].filter(([,n])=>n===number).map(([commit])=>commit)});
    }
    const ids=[...new Set(prs.flatMap(p=>p.workItems))];
    if(notion)for(const id of ids)try{
      const row=await notion(`/pages/${id}`),expected=config.workItemsId||'20aeddfe-a3f7-41e9-b440-c9eb6b26887f';
      if((row.parent?.data_source_id||'').replace(/-/g,'')!==expected.replace(/-/g,'') || row.in_trash || row.archived)throw new Error('not an active canonical Work Item');
      const title=text(row.properties.Name);
      const scope=(await readState(notion,id,'scope')).value||{targets:[],restrictions:''};
      const platform=config.target.startsWith('ios-')?'iOS':config.target.startsWith('android-')?'Android':config.target==='web'?'Web':'';
      const delivery={targets:(scope.targets||[]).slice().sort(),restrictions:(scope.restrictions||'').trim(),rcKey:platform?text(row.properties[`${platform} RC Key`]).trim():''};
      workItemSnapshots.push({id,delivery,url:`https://www.notion.so/${id}`,title,description:title});
    }catch(error){issues.push(`Work Item ${id}: ${error.message}`)}
    else if(ids.length)issues.push('Work Item details need Notion access.');
  }catch(error){issues.push(`Provenance check failed: ${error.message}`)}
  return {issues,prs,contexts,syncs,workItemSnapshots,validBaseline,diverged,complete:validBaseline&&!unmapped.length&&!issues.some(i=>i.startsWith('Provenance check failed'))};
}
// What is announced is exactly the shipped build's `## x.y.z` section: New, Changed and
// Fixed for customers (the website uses the same entries); every other heading is internal.
function sectionChanges(config,raw,contexts) {
  const {hash}=require('./record'),{clean}=require('./customer-notes');
  const version=config.version.replace(/^v/,'');
  return parseChangelog(raw.replace(/<!--[^]*?-->/g,'')).filter(e=>e.version===version).map(entry=>{
    const customer=['New','Changed','Fixed'].includes(entry.heading),summary=customer?clean(entry.summary):entry.summary.trim();
    const sources=contexts.filter(x=>entry.prRefs.some(p=>p.repository===config.repo&&p.number===x.pr.number));
    const sourcePrs=sources.map(x=>x.pr.number).sort((a,b)=>a-b),review=sources.find(x=>x.approved);
    const kind=!customer?'internal':entry.heading==='Fixed'?'fix':'feature';
    const id=digest({repository:config.repo,version,heading:entry.heading,entry:identity(entry)});
    return {id,kind,summary,heading:entry.heading,sourceVersion:version,audience:'Users of this production target',limitations:entry.previewTag?`Preview: ${entry.previewTag}`:'',scope:`changelog-${id.slice(0,24)}`,targets:[config.target],availabilityMode:'work-item',audienceGate:false,requiredReleaseKeys:[],workItems:entry.workItems,pr:sourcePrs[0]||0,noteHash:hash({summary,heading:entry.heading,sourcePrs}),approved:Boolean(review),reviewEvidence:review?.pr.html_url||'',blocked:[],flagKeys:entry.flagKeys,gateKeys:[],sourcePrs};
  }).filter((c,i,all)=>c.summary&&all.findIndex(o=>o.id===c.id)===i);
}
async function buildChangelogManifest(config,gh,baseline,notion) {
  const {git,releaseKey}=require('./record');
  const sha=git('rev-parse',`${config.commit}^{commit}`),website=Boolean(config.target==='website'&&WEBSITES[config.repo]);
  const info=await provenance(config,gh,sha,baseline,notion,website),issues=[...info.issues];
  let wordingPr,supplement,wordingAcceptance;
  if(config.wordingPr) {
    const accepted=await mergedWording(config,gh);
    wordingPr=accepted.pr;supplement=accepted.file;wordingAcceptance=accepted.acceptance;
  }
  const raw=supplement?Buffer.from(supplement.content,'base64').toString('utf8'):readChangelog(sha,git);
  const changes=website?[]:sectionChanges(config,raw,info.contexts);
  if(!website&&!changes.some(c=>c.kind!=='internal'))issues.push(`CHANGELOG.md at the shipped commit has no customer notes under ## ${config.version.replace(/^v/,'')}.`);
  if(info.validBaseline&&website)changes.push(...websiteChanges(config,baseline,sha,info.contexts,info.syncs,git));
  return {schemaVersion:2,deliveryVersion:1,key:releaseKey(config.repo,config.target,config.version,config.event),repository:config.repo,product:config.product,target:config.target,version:config.version,build:config.build||'',commit:sha,baseline:baseline||'',event:config.event||'release',prs:info.prs,changes,workItemSnapshots:info.workItemSnapshots,completeChangelog:renderChangelog(changes.filter(c=>c.kind!=='internal')),wordingSource:wordingPr?{pr:wordingPr.number,commit:wordingPr.head.sha,url:wordingPr.html_url,acceptance:wordingAcceptance}:null,issues,provenanceComplete:info.complete,...(info.diverged?{divergedBaseline:{mergeBase:info.diverged.mergeBase}}:{}),websiteSyncs:info.syncs,source:config.source};
}
module.exports={parseChangelog,newEntries,renderChangelog,identity,buildChangelogManifest,internalFiles,readChangelog,mergedWording};
