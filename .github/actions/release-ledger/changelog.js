const crypto = require('node:crypto');
const { parseWorkItemLinks } = require('./work-item-links');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => value.replace(/\s+/g,' ').trim();
const identity = e => normalized(e.summary.replace(/\[([^\]]+)\]\((?:https:\/\/(?:www\.)?notion\.so\/|https:\/\/app\.notion\.com\/p\/|https:\/\/github\.com\/)[^)]+\)/g,'$1'));

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
function newEntries(before,after){const old=new Set(parseChangelog(before).map(identity));return parseChangelog(after).filter(e=>!old.has(identity(e)))}
function internalFiles(files){return files.length>0 && files.every(f=> /^(?:\.github\/|docs\/|README(?:\.|$)|LICENSE|.*\.md$)/.test(f.filename) && f.filename!=='CHANGELOG.md')}

async function buildChangelogManifest(config,gh,baseline,notion) {
  const {git,ancestor,reviewed,hash,releaseKey,provenanceMapping,text,allPages}=require('./record');
  const sha=git('rev-parse',`${config.commit}^{commit}`),issues=[],prs=[],changes=[];
  const mapping=await provenanceMapping(config,gh,sha,baseline);
  const validBaseline=Boolean(baseline&&/^[a-f0-9]{40}$/.test(baseline)&&(ancestor(baseline,sha)||mapping));
  if(!validBaseline)issues.push('Missing verified production baseline. Record the previous deployed commit; no announcement is inferred.');
  const commits=validBaseline?git('rev-list','--reverse',`${baseline}..${sha}`).split('\n').filter(Boolean):[];
  const numbers=new Set(),unmapped=[];
  for(const commit of commits){const associated=[];for(let page=1;;page++){const rows=await gh(`/repos/${config.repo}/commits/${commit}/pulls?per_page=100&page=${page}`);associated.push(...rows);if(rows.length<100)break};const included=associated.filter(p=>p.base?.repo?.full_name===config.repo && p.merged_at && p.merge_commit_sha && ancestor(p.merge_commit_sha,sha));if(mapping?.commits[commit])numbers.add(mapping.commits[commit]);else if(included.length===1)numbers.add(included[0].number);else unmapped.push(commit)}
  if(unmapped.length)issues.push(`Unmapped shipped commits: ${unmapped.join(', ')}. Confirm their source PRs before announcing this release.`);
  const read=ref=>{try{return git('show',`${ref}:CHANGELOG.md`)}catch{return ''}};
  let wordingPr;
  if(config.wordingPr) {
    wordingPr=await gh(`/repos/${config.repo}/pulls/${config.wordingPr}`);
    if(!wordingPr.merged_at||wordingPr.base?.repo?.full_name!==config.repo||!await reviewed(gh,config.repo,wordingPr))throw new Error('The supplemental changelog needs a merged human-reviewed PR at its current head');
  }
  const supplement=wordingPr?await gh(`/repos/${config.repo}/contents/CHANGELOG.md?ref=${wordingPr.head.sha}`):null;
  if(supplement&&supplement.encoding!=='base64')throw new Error('Supplemental changelog content is unavailable');
  const raw=supplement?Buffer.from(supplement.content,'base64').toString('utf8'):read(sha),before=validBaseline?read(baseline):'';
  if(!raw)issues.push('CHANGELOG.md is missing at the shipped commit. Add reviewed release notes before publication.');
  const contexts=[];
  for(const number of [...numbers].sort((a,b)=>a-b)) {
    const pr=await gh(`/repos/${config.repo}/pulls/${number}`),links=parseWorkItemLinks(pr.body),files=[];
    if(!pr.merged_at || pr.base?.repo?.full_name!==config.repo || (!ancestor(pr.merge_commit_sha,sha)&&!mapping))throw new Error(`PR #${number} is not proven in the shipped commit`);
    for(let page=1;;page++){const batch=await gh(`/repos/${config.repo}/pulls/${number}/files?per_page=100&page=${page}`);files.push(...batch);if(batch.length<100)break}
    const added=newEntries(read(`${pr.merge_commit_sha}^1`),read(pr.merge_commit_sha)),approved=await reviewed(gh,config.repo,pr);
    const warnings=links.invalidEntries.length?[`PR #${number}: fix the invalid Work Items link in the PR description.`]:[];
    if(!added.length&&!internalFiles(files))issues.push(`PR #${number} has no new changelog entry; a release PR may supply it.`);
    prs.push({number,url:pr.html_url,mergeCommit:pr.merge_commit_sha,headCommit:pr.head.sha,workItems:links.ids,approved,noteHash:''});
    contexts.push({pr,links:links.ids,added,approved,warnings});
  }
  const ids=[...new Set(prs.flatMap(p=>p.workItems))],workItemSnapshots=[],workItemPages=new Map(),availability=[];
  if(notion) {
    for(const id of ids)try{
      const row=await notion(`/pages/${id}`),expected=config.workItemsId||'20aeddfe-a3f7-41e9-b440-c9eb6b26887f';
      if((row.parent?.data_source_id||'').replace(/-/g,'')!==expected.replace(/-/g,'') || row.in_trash || row.archived)throw new Error('not an active canonical Work Item');
      const title=text(row.properties.Name),description=text(row.properties['Feature Changelog Text'])||title;
      const relation=row.properties['Required Availability'];
      if(relation?.has_more){const all=[];let cursor;do{const page=await notion(`/pages/${row.id}/properties/${encodeURIComponent(relation.id)}?${new URLSearchParams({page_size:'100',...(cursor?{start_cursor:cursor}:{})})}`);all.push(...page.results.map(x=>({id:x.relation.id})));cursor=page.has_more?page.next_cursor:undefined}while(cursor);row.properties['Required Availability']={...relation,relation:all,has_more:false}}
      workItemSnapshots.push({id,url:`https://www.notion.so/${id}`,title,description});workItemPages.set(id,row);
    }catch(error){issues.push(`Work Item ${id}: ${error.message}`)}
    if(ids.length)try{availability.push(...await allPages(notion,`/data_sources/${config.availabilityId||'b21439db-b5b5-433d-9b53-6e3cabf430b3'}/query`,{}))}catch(error){issues.push(`Availability lookup: ${error.message}`)}
  } else if(ids.length)issues.push('Work Item snapshots require Notion access before publication.');
  const historicalVersions=new Set(parseChangelog(before).map(e=>e.version).filter(v=>v.toLowerCase()!=='unreleased'));
  const candidates=validBaseline?newEntries(before,raw):[];
  if(wordingPr)for(const entry of candidates)if(entry.version!==config.version.replace(/^v/,''))entry.outsideSupplement=true;
  const seen=new Set();
  for(const entry of candidates) {
    const origins=contexts.filter(x=>x.added.some(e=>identity(e)===identity(entry)));
    const explicit=entry.prRefs.filter(p=>p.repository===config.repo);
    const sources=explicit.length?contexts.filter(x=>explicit.some(p=>p.number===x.pr.number)):origins;
    const wording=wordingPr?{pr:wordingPr,approved:true}:origins.at(-1),blocked=[...new Set(sources.flatMap(x=>x.warnings))];
    if(entry.outsideSupplement)continue;
    if(historicalVersions.has(entry.version))blocked.push('This edits a previously deployed changelog section. Use a reviewed correction instead of announcing it as new.');
    const linked=entry.workItems.length?entry.workItems:[...new Set(sources.flatMap(x=>x.links))];
    if(wordingPr&&!sources.length)blocked.push('Link the shipped source PR beside this supplemental changelog entry.');
    if(!wording)blocked.push('Changelog entry has no identifiable wording PR. Link the source PR beside this entry.');
    if(explicit.some(p=>!contexts.some(x=>x.pr.number===p.number)))blocked.push('Referenced PR is outside the verified shipped range.');
    if(!entry.workItems.length&&linked.length>1)blocked.push('Several Work Items match this entry. Link its Work Item beside the changelog entry.');
    const fixes=sources.length&&sources.every(x=>/^fix(?:\([^)]*\))?!?:/i.test(x.pr.title||''));
    const kind=/^internal$/i.test(entry.heading)?'internal':/^(?:fix|fixed|fixes|bug fixes|security)$/i.test(entry.heading)?'fix':fixes?'fix':'feature';
    if(kind==='feature'&&!linked.length)blocked.push('Feature changelog entry needs a linked Work Item.');
    if(linked.some(id=>!workItemPages.has(id)))blocked.push('A linked Work Item is unavailable or outside the canonical database.');
    const flagKeys=[...new Set([...entry.flagKeys,...linked.flatMap(id=>{const p=workItemPages.get(id)?.properties;const platform=config.target.startsWith('ios')?'iOS':config.target.startsWith('android')?'Android':'Web';return p&&text(p[`${platform} RC Key`])?[text(p[`${platform} RC Key`])]:[]})])];
    const gates=availability.filter(p=>p.properties['Scope Approved']?.checkbox && text(p.properties.Target)===config.target && (p.properties['Work Item']?.relation||[]).some(r=>linked.includes(r.id.replace(/-/g,''))));
    // Only scopes explicitly selected by the Work Item can constrain this change.
    const selected=new Set(linked.flatMap(id=>(workItemPages.get(id)?.properties['Required Availability']?.relation||[]).map(r=>r.id)));
    const gateKeys=gates.filter(g=>selected.has(g.id)).map(g=>text(g.properties['Availability Key']));
    const sourcePrs=sources.map(x=>x.pr.number).sort((a,b)=>a-b);
    const id=digest({repository:config.repo,sources:sourcePrs,entry:identity(entry)});
    if(seen.has(id))continue;seen.add(id);
    const summary=entry.summary.replace(/\s*\[(?:Work Item|PR|source)\]\((?:https:\/\/(?:www\.)?notion\.so\/|https:\/\/app\.notion\.com\/p\/|https:\/\/github\.com\/)[^)]+\)/gi,'').trim();
    const c={id,kind,summary,heading:entry.heading,sourceVersion:entry.version,audience:'Users of this production target',limitations:entry.previewTag?`Preview: ${entry.previewTag}`:'',scope:`changelog-${id.slice(0,24)}`,targets:[config.target],audienceGate:kind==='feature'||flagKeys.length>0,requiredReleaseKeys:[],workItems:linked,pr:wording?.pr.number||sources[0]?.pr.number||0,noteHash:hash({summary,heading:entry.heading,sourcePrs}),approved:Boolean(wording?.approved),reviewEvidence:wording?.approved?wording.pr.html_url:'',blocked,flagKeys,gateKeys,sourcePrs};
    changes.push(c);
  }
  return {schemaVersion:2,key:releaseKey(config.repo,config.target,config.version,config.event),repository:config.repo,product:config.product,target:config.target,version:config.version,build:config.build||'',commit:sha,baseline:baseline||'',event:config.event||'release',prs,changes,workItemSnapshots,completeChangelog:renderChangelog(changes.filter(c=>c.kind!=='internal')),wordingSource:wordingPr?{pr:wordingPr.number,commit:wordingPr.head.sha,url:wordingPr.html_url}:null,issues,provenanceComplete:validBaseline&&unmapped.length===0,source:config.source};
}
module.exports={parseChangelog,newEntries,renderChangelog,identity,buildChangelogManifest,internalFiles};
