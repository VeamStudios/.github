const {test}=require('node:test');
const assert=require('node:assert/strict');
const {amend}=require('./amend');
const {hash,rich,text}=require('./record');
function setup(){
 const original={schemaVersion:2,repository:'VeamStudios/Test',target:'website',commit:'a'.repeat(40),baseline:'b'.repeat(40),key:'release',version:'v1',changes:[],workItemSnapshots:[],issues:[]};
 const row={id:'page',parent:{data_source_id:'releases'},properties:{Manifest:rich(JSON.stringify(original)),'Manifest Hash':rich(hash(original)),Announcements:rich('')}};
 const calls=[],api={notion:async(path,method,body)=>{calls.push({path,method,body});return structuredClone(row)}};
 return {row,original,calls,api,config:{repo:original.repository,pageId:'page',releasesId:'releases'},build:async()=>structuredClone(original)};
}
test('rechecking an existing source defaults to a read-only preview with immutable commit evidence',async()=>{
 const {config,api,build,calls,original}=setup();const result=await amend(config,api,build);
 assert.equal(result.dryRun,true);assert.equal(result.source,`https://github.com/${original.repository}/commit/${original.commit}`);assert.ok(calls.every(c=>!c.method));
});
test('explicit apply saves only the supplement and preserves original manifest',async()=>{
 const {config,api,build,calls}=setup();await amend({...config,dryRun:false},api,build);
 const writes=calls.filter(c=>c.method==='PATCH');assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].body.properties),['Announcement Source']);
 const source=JSON.parse(text(writes[0].body.properties['Announcement Source']));assert.equal(source.digest,hash(source.manifest));
});
test('uncertain or pending announcements cannot be replaced by a recovery attempt',async()=>{
 const {config,api,build,row}=setup();row.properties.Announcements=rich(JSON.stringify({version:1,batches:[{state:'Sending'}]}));
 await assert.rejects(amend(config,api,build),/outstanding Slack/);
});
test('after a post, a supplement may add provenance but never lose it or change wording',async()=>{
 const {config,api,row,calls,original}=setup();original.changes=[{id:'one',summary:'Original',workItems:[],sourcePrs:[]}];row.properties.Manifest=rich(JSON.stringify(original));row.properties['Manifest Hash']=rich(hash(original));row.properties.Announcements=rich(JSON.stringify({version:1,batches:[{state:'Sent',ids:['one']}]}));
 const preview=await amend(config,api,async()=>({...original,changes:[{id:'one',summary:'Original',workItems:[],sourcePrs:[7]}]}));
 assert.deepEqual(preview.changes.map(c=>c.id),['one']);
 // Once resolved, a rebuild during a GitHub failure keeps the posted source PRs.
 const resolved={...original,changes:[{id:'one',summary:'Original',workItems:[],sourcePrs:[7],pr:7,approved:true}]};
 row.properties['Announcement Source']=rich(JSON.stringify({manifest:resolved,digest:hash(resolved),evidence:`https://github.com/${original.repository}/commit/${original.commit}`}));
 await amend({...config,dryRun:false},api,async()=>({...original,changes:[{id:'one',summary:'Original',workItems:[],sourcePrs:[],pr:0,approved:false}]}));
 const saved=JSON.parse(text(calls.find(c=>c.method==='PATCH').body.properties['Announcement Source'])).manifest.changes[0];
 assert.deepEqual([saved.sourcePrs,saved.pr,saved.approved],[[7],7,true]);
 await assert.rejects(amend(config,api,async()=>({...original,changes:[{id:'one',summary:'Changed',workItems:[],sourcePrs:[7]}]})),/cannot rewrite/);
});
