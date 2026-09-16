const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initialSnapshot,IDENTITY}=require('./initial-snapshot');
const {hash,rich,text}=require('./record');
const {amend}=require('./amend');
const original={schemaVersion:2,key:'release',...IDENTITY,product:'Site Audit Pro',event:'release',prs:[],changes:[],workItemSnapshots:[],completeChangelog:'',issues:['Missing baseline'],provenanceComplete:false,source:'https://github.com/run'};
const raw='## 4.0.0\n\n### New\n\n- Cloud arrived.\n';
const shipped="# What's New in 4.0.0\n\n#### New\n- Cloud arrived.\n";
const pr={number:10,merged_at:'today',base:{repo:{full_name:IDENTITY.repository}},head:{sha:'b'.repeat(40)},merge_commit_sha:'c'.repeat(40),user:{login:'author'},html_url:'https://github.com/repo/pull/10'};
const gh=async path=>path.includes('/reviews')?[{user:{login:'reviewer',type:'User'},state:'APPROVED',commit_id:pr.head.sha}]:path.includes('/contents/')?{encoding:'base64',content:Buffer.from(raw).toString('base64')}:pr;
test('recovery preserves frozen identity and refuses to infer feature/PR history',async()=>{
  const m=await initialSnapshot({wordingPr:10,expectedHash:hash(original)},original,gh,()=>shipped);
  for(const [key,value] of Object.entries(IDENTITY))assert.equal(m[key],value);
  assert.equal(m.provenanceComplete,false);assert.deepEqual(m.prs,[]);assert.deepEqual(m.changes[0].workItems,[]);assert.ok(m.changes[0].blocked.length);assert.match(m.completeChangelog,/Cloud arrived/);
});
test('stale hash, wrong release, unreviewed or changed asset never recover',async()=>{
  const config={wordingPr:10,expectedHash:hash(original)};
  await assert.rejects(()=>initialSnapshot({...config,expectedHash:'stale'},original,gh),/exact frozen/);
  await assert.rejects(()=>initialSnapshot(config,{...original,build:'1'},gh),/only supplements/);
  await assert.rejects(()=>initialSnapshot(config,original,async p=>p.includes('/reviews')?[]:gh(p),()=>shipped),/human review/);
  await assert.rejects(()=>initialSnapshot(config,original,gh,()=>shipped.replace('Cloud','Something else')),/differ/);
});
test('amend preview is read only, preserves receipts, and detects concurrent writes',async()=>{
  const row={id:'page',parent:{data_source_id:'db'},properties:{Manifest:rich(JSON.stringify(original)),'Manifest Hash':rich(hash(original)),Announcements:rich(JSON.stringify({version:1,batches:[],receipt:'retain'}))}};
  let reads=0;const writes=[];
  const api={gh,notion:async(path,method,body)=>{if(method==='PATCH'){writes.push(body);return {}};reads++;return reads===1?row:{...row,properties:{...row.properties,Announcements:rich('concurrent')}}}};
  const config={repo:IDENTITY.repository,pageId:'page',releasesId:'db',dryRun:true};
  await amend(config,api,async()=>original);assert.equal(writes.length,0);
  reads=0;await assert.rejects(()=>amend({...config,dryRun:false},api,async()=>original),/changed during/);assert.equal(writes.length,0);
});
