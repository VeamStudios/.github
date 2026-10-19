const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sourceNotes,mergeSection,renderedNotes,publishWebsite,WEBSITE,DESTINATION}=require('./play-website');
const {guard}=require('./guard-website-notes');
const {hash,rich,text}=require('./record');
const {customerSection}=require('./customer-notes');
const {ROOT}=require('./google-play');
const sha='a'.repeat(40),websiteSha='b'.repeat(40);
const raw='## Unreleased\n### New\n- Future secret\n\n## 4.0.1\n### Fixed\n- A **complete** fix. [PR](https://github.com/org/repo/pull/1)\n\n### Internal\n- Private work\n';
const section='## 4.0.1\n\n### Fixed\n\n- A **complete** fix.\n';
const historical='# Site Audit Pro\n\n## 3.2.6\n\n### Feature\n\n- A rotation option for images.\n';
function setup(){
  const m={schemaVersion:2,key:'VeamStudios/SiteAuditPro-AndroidNew/android-consumer/release/v4.0.1',repository:'VeamStudios/SiteAuditPro-AndroidNew',target:'android-consumer',version:'v4.0.1',build:'222',commit:sha,baseline:'c'.repeat(40),event:'release',provenanceComplete:true,changes:[{kind:'fix',summary:'A **complete** fix.',heading:'Fixed',sourceVersion:'4.0.1',approved:true,reviewEvidence:'https://github.com/review'}]};
  const v={kind:'google-play',packageName:'com.veamstudios.siteauditpro',track:'production',repository:m.repository,commit:sha,build:'222',versionCode:'222',lifecycle:'RELEASE_LIFECYCLE_STATE_PUBLISHED',rolloutStatus:'completed',checkedAt:new Date().toISOString(),evidence:`${ROOT}/tracks/production/releases`,rolloutEvidence:`${ROOT}/edits/123/tracks/production`};
  const row={id:'abc',properties:{Manifest:rich(JSON.stringify(m)),'Manifest Hash':rich(hash(m)),Observation:rich(JSON.stringify({phase:'live',verification:v})),Announcements:rich(JSON.stringify({version:1,batches:[{key:'already sent',state:'Sent'}]}))}};
  // In-memory website repository: main accepts changes only through squash-merged pull requests, as its ruleset does.
  const W=`/repos/${WEBSITE}`,commits=new Map(),refs=new Map(),prs=[];let writes=0,dispatches=0,merges=0,n=0;const threads={unresolved:0};
  const commit=(parent,content,message)=>{const id=hash([parent,content,message,n++]).slice(0,40);commits.set(id,{parent,content,message});return id};
  const fail=(status,message)=>Object.assign(Error(`GitHub failed (${status}): ${message}`),{status});
  const resolve=ref=>refs.get(decodeURIComponent(ref))||ref;
  const ancestor=(a,b)=>{let count=0;for(let c=b;c;c=commits.get(c)?.parent,count++)if(c===a)return count;return -1};
  refs.set('main',commit(null,historical,'Initial'));
  const api={notion:async(path,method,body)=>{if(method==='PATCH')Object.assign(row.properties,body.properties);return structuredClone(row)},gh:async(path,method='GET',body)=>{
    const [route,query='']=path.split('?'),q=new URLSearchParams(query);
    if(route.includes('/contents/CHANGELOG.md'))return {encoding:'base64',content:Buffer.from(raw).toString('base64')};
    if(route===`${W}/contents/${DESTINATION}`&&method==='GET'){const c=commits.get(resolve(q.get('ref')));if(!c)throw fail(404,'Not Found');return {encoding:'base64',content:Buffer.from(c.content).toString('base64'),sha:hash(c.content)}}
    if(route===`${W}/contents/${DESTINATION}`&&method==='PUT'){if(body.branch==='main')throw fail(409,'Repository rule violations found');const head=refs.get(body.branch);if(body.sha!==hash(commits.get(head).content))throw fail(409,'does not match');writes++;const id=commit(head,Buffer.from(body.content,'base64').toString(),body.message);refs.set(body.branch,id);return {commit:{sha:id}}}
    if(route.startsWith(`${W}/git/ref/heads/`)){const sha=refs.get(route.slice(`${W}/git/ref/heads/`.length));if(!sha)throw fail(404,'Not Found');return {object:{sha}}}
    if(route===`${W}/git/refs`&&method==='POST'){refs.set(body.ref.replace('refs/heads/',''),body.sha);return {}}
    if(route.startsWith(`${W}/git/refs/heads/`)&&method==='PATCH'){refs.set(route.slice(`${W}/git/refs/heads/`.length),body.sha);return {}}
    if(route.startsWith(`${W}/compare/`)){const [a,b]=route.slice(`${W}/compare/`.length).split('...'),ahead=ancestor(a,b);return {status:ahead>0?'ahead':ahead===0?'identical':'behind',ahead_by:Math.max(ahead,0),behind_by:ahead<0?1:0,files:ahead>0?[{filename:DESTINATION}]:[]}}
    if(route===`${W}/pulls`&&method==='GET')return prs.filter(p=>`${WEBSITE.split('/')[0]}:${p.head.ref}`===q.get('head'));
    if(route===`${W}/pulls`&&method==='POST'){if(prs.some(p=>p.head.ref===body.head&&p.state==='open'))throw fail(422,'A pull request already exists');const pr={number:prs.length+1,state:'open',title:body.title,head:{ref:body.head},base:{ref:body.base},merged_at:null,merge_commit_sha:null};prs.push(pr);return structuredClone(pr)}
    if(route==='/graphql')return {data:{repository:{pullRequest:{reviewThreads:{nodes:[{isResolved:true},...Array.from({length:threads.unresolved},()=>({isResolved:false}))]}}}}};
    if(/\/pulls\/\d+\/merge$/.test(route)){const pr=prs.find(p=>p.number===Number(route.split('/').at(-2))),head=refs.get(pr.head.ref);if(pr.state!=='open'||body.sha!==head)throw fail(409,'Head branch was modified');if(commits.get(head).parent!==refs.get('main'))throw fail(405,'Pull Request is not mergeable');if(body.merge_method!=='squash')throw fail(405,'Merge method not allowed');merges++;const id=commit(refs.get('main'),commits.get(head).content,`${body.commit_title}\n\n${body.commit_message}`);refs.set('main',id);refs.delete(pr.head.ref);Object.assign(pr,{state:'closed',merged_at:new Date().toISOString(),merge_commit_sha:id});return {merged:true,sha:id}}
    if(/\/pulls\/\d+$/.test(route))return structuredClone(prs.find(p=>p.number===Number(route.split('/').at(-1))));
    if(route===`${W}/commits`){const list=[];for(let c=refs.get('main');c;c=commits.get(c).parent)list.push({sha:c,commit:{message:commits.get(c).message}});return list}
    if(route.startsWith(`${W}/commits/`)){const id=route.split('/').at(-1);return {sha:id,commit:{message:commits.get(id)?.message}}}
    if(route.includes('/actions/workflows/')&&route.includes('/runs'))return {total_count:0,workflow_runs:[]};
    if(route.endsWith('/dispatches')){dispatches++;return {}};
    throw Error(`Unexpected ${method} ${path}`);
  }};
  const main=()=>commits.get(refs.get('main'));
  return {row,m,api,prs,refs,commits,commit,threads,counts:()=>({writes,merges,prs:prs.length,dispatches}),website:()=>main().content,main};
}
test('customer projection excludes unreleased/internal/metadata and preserves all historical bytes',()=>{
  assert.equal(customerSection(raw,'v4.0.1'),section);
  const merged=mergeSection(historical,section,'v4.0.1');
  assert.ok(merged.endsWith(historical.slice(historical.indexOf('## '))));
  assert.equal(mergeSection(merged,section,'4.0.1'),merged);
  assert.throws(()=>mergeSection(merged,section.replace('fix','change'),'4.0.1'),/different notes/);
  assert.equal(renderedNotes('<h2>4.0.1</h2><li>A <strong>complete</strong> fix.</li>',section,'4.0.1'),true);
  assert.equal(renderedNotes('<h2>4.0.1</h2><li>Future secret</li>',section,'4.0.1'),false);
});
test('partial/halted/wrong evidence and unreviewed wording cannot sync',async()=>{
  for(const mutation of [r=>{const o=JSON.parse(text(r.properties.Observation));o.verification.rolloutStatus='halted';r.properties.Observation=rich(JSON.stringify(o))},r=>{const m=JSON.parse(text(r.properties.Manifest));m.changes[0].approved=false;r.properties.Manifest=rich(JSON.stringify(m));r.properties['Manifest Hash']=rich(hash(m))}]) {
    const {row,api}=setup();mutation(row);await assert.rejects(()=>sourceNotes(row,api));
  }
});
test('publication squash-merges one release PR without writing main, verifies rendered content, persists receipt without touching announcements',async()=>{
  const {row,api,counts,website,refs,main,threads}=setup(),announcements=text(row.properties.Announcements);
  let live=false;
  const fetcher=async url=>url.includes('release-info')?{ok:true,json:async()=>({repository:WEBSITE,commit:live?refs.get('main'):'c'.repeat(40)})}:{ok:true,text:async()=>'<h2>4.0.1</h2><li>A <strong>complete</strong> fix.</li>'};
  // An unresolved review thread on the bot PR blocks the ruleset: hold without merging, then resume the same PR.
  threads.unresolved=2;
  const held=await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher});
  assert.equal(held.state,'held');assert.match(held.reason,/pull request #1 has 2 unresolved review threads/);assert.deepEqual(counts(),{writes:1,merges:0,prs:1,dispatches:0});
  threads.unresolved=0;
  const first=await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher});
  assert.equal(first.state,'pending');assert.equal(first.commit,refs.get('main'));assert.equal(first.pullRequest,1);
  assert.deepEqual(counts(),{writes:1,merges:1,prs:1,dispatches:1});
  // The squash commit keeps the exact sync title and trailers the deployment guard recognises.
  assert.match(main().message,new RegExp(`^Update changelog for v4\\.0\\.1\\n\\nRelease-Source-Repository: [^]*Release-Ledger-Page: ${row.id}`));
  live=true;
  assert.equal((await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher})).state,'published');
  assert.equal((await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher})).state,'published');
  assert.deepEqual(counts(),{writes:1,merges:1,prs:1,dispatches:1});assert.equal(text(row.properties.Announcements),announcements);
  // The receipt lives only in its owned column; the shared Observation is never written.
  assert.equal(JSON.parse(text(row.properties['Website Receipt'])).state,'published');assert.equal(JSON.parse(text(row.properties.Observation)).website,undefined);assert.doesNotMatch(website(),/Future|Private|github.com/);
});
test('website guard refuses unrelated revisions since verified production',async()=>{
  const read=(cmd,...args)=>cmd==='rev-parse'?websiteSha:cmd==='merge-base'?'':cmd==='rev-list'?'d'.repeat(40):'';
  await assert.rejects(()=>guard({repository:WEBSITE,expectedCommit:websiteSha},{},{read,fetcher:async()=>({ok:true,json:async()=>({repository:WEBSITE,commit:'c'.repeat(40)})}),verify:async()=>null}),/unrelated or unapproved/);
});
test('lost Notion receipts before or after the merge resume without a second PR, commit or deployment',async()=>{
  for(const failing of [1,2]) {
    const {row,api,counts}=setup(),notion=api.notion;
    let patches=0;
    api.notion=async(path,method,body)=>{if(method==='PATCH'&&++patches===failing)throw Error('receipt write interrupted');return notion(path,method,body)};
    const fetcher=async()=>({ok:false});
    await assert.rejects(()=>publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher}),/interrupted/);
    assert.equal(counts().dispatches,0);
    await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher});
    assert.deepEqual(counts(),{writes:1,merges:1,prs:1,dispatches:1});
  }
});
test('an unmerged or closed release PR never deploys, and a concurrent website change is preserved',async()=>{
  const fetcher=async()=>({ok:false}),other='## 4.0.0\n\n### Fixed\n\n- Another release.\n';
  // Another release lands on main after the first read: before the branch is prepared, or before the merge.
  for(const trigger of ['/git/ref/heads/main','/merge']) {
    const {row,api,counts,refs,commit,website}=setup(),gh=api.gh;
    let race=true;
    api.gh=async(path,method,body)=>{if(race&&path.endsWith(trigger)){race=false;refs.set('main',commit(refs.get('main'),mergeSection(website(),other,'v4.0.0'),'Update changelog for v4.0.0'))}return gh(path,method,body)};
    for(let attempt=0;attempt<2&&!counts().merges;attempt++)await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher}).catch(()=>{});
    assert.deepEqual({...counts(),writes:undefined},{writes:undefined,merges:1,prs:1,dispatches:1});
    assert.ok(website().includes(other.trim())&&website().includes('## 4.0.1\n\n### Fixed\n\n- A complete fix.'),trigger);
  }
  const closed=setup(),closedGh=closed.api.gh;
  closed.api.gh=async(path,method,body)=>{if(path.endsWith('/merge'))throw Object.assign(Error('GitHub PUT failed (405)'),{status:405});return closedGh(path,method,body)};
  await assert.rejects(()=>publishWebsite(closed.row.id,{publishWebsite:true,dryRun:false},closed.api,{fetcher}),/405/);
  closed.prs[0].state='closed';
  const held=await publishWebsite(closed.row.id,{publishWebsite:true,dryRun:false},closed.api,{fetcher});
  assert.equal(held.state,'held');assert.match(held.reason,/closed without merging/);
  assert.deepEqual(closed.counts(),{writes:1,merges:0,prs:1,dispatches:0});
});
