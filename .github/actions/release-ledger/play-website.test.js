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
  let website=historical,writes=0,dispatches=0,message='';
  const api={notion:async(path,method,body)=>{if(method==='PATCH')Object.assign(row.properties,body.properties);return structuredClone(row)},gh:async(path,method,body)=>{
    if(path.includes('/contents/CHANGELOG.md'))return {encoding:'base64',content:Buffer.from(raw).toString('base64')};
    if(path.includes(`/contents/${DESTINATION}`)){if(method==='PUT'){website=Buffer.from(body.content,'base64').toString();message=body.message;writes++;return {commit:{sha:websiteSha}}}return {encoding:'base64',content:Buffer.from(website).toString('base64'),sha:'blob'}}
    if(path.includes('/commits?path='))return [{sha:websiteSha,commit:{message}}];
    if(path.includes('/compare/'))return {status:'behind'};
    if(path.includes('/actions/workflows/')&&path.includes('/runs'))return {total_count:0,workflow_runs:[]};
    if(path.endsWith('/dispatches')){dispatches++;return {}};
    if(path.includes('/git/ref/heads/main'))return {object:{sha:websiteSha}};
    throw Error(`Unexpected ${path}`);
  }};
  return {row,m,api,counts:()=>({writes,dispatches}),website:()=>website};
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
test('publication writes once, verifies actual rendered content, persists receipt without touching announcements',async()=>{
  const {row,api,counts,website}=setup(),announcements=text(row.properties.Announcements);
  let live=false;
  const fetcher=async url=>url.includes('release-info')?{ok:true,json:async()=>({repository:WEBSITE,commit:live?websiteSha:'c'.repeat(40)})}:{ok:true,text:async()=>'<h2>4.0.1</h2><li>A <strong>complete</strong> fix.</li>'};
  const first=await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher});
  assert.equal(first.state,'pending');assert.deepEqual(counts(),{writes:1,dispatches:1});
  live=true;
  assert.equal((await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher})).state,'published');
  assert.equal((await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher})).state,'published');
  assert.deepEqual(counts(),{writes:1,dispatches:1});assert.equal(text(row.properties.Announcements),announcements);assert.doesNotMatch(website(),/Future|Private|github.com/);
});
test('website guard refuses unrelated revisions since verified production',async()=>{
  const read=(cmd,...args)=>cmd==='rev-parse'?websiteSha:cmd==='merge-base'?'':cmd==='rev-list'?'d'.repeat(40):'';
  await assert.rejects(()=>guard({repository:WEBSITE,expectedCommit:websiteSha},{},{read,fetcher:async()=>({ok:true,json:async()=>({repository:WEBSITE,commit:'c'.repeat(40)})}),verify:async()=>null}),/unrelated or unapproved/);
});
test('lost Notion receipt after a content update resumes without a second website commit',async()=>{
  const {row,api,counts}=setup(),notion=api.notion;
  let fail=true;
  api.notion=async(path,method,body)=>{if(method==='PATCH'&&fail){fail=false;throw Error('receipt write interrupted')}return notion(path,method,body)};
  const fetcher=async()=>({ok:false});
  await assert.rejects(()=>publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher}),/interrupted/);
  assert.deepEqual(counts(),{writes:1,dispatches:0});
  await publishWebsite(row.id,{publishWebsite:true,dryRun:false},api,{fetcher});
  assert.deepEqual(counts(),{writes:1,dispatches:1});
});
