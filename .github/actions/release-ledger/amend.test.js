const {test}=require('node:test');
const assert=require('node:assert/strict');
const {amend}=require('./amend');
const {hash,rich}=require('./record');
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
 const writes=calls.filter(c=>c.method==='PATCH');assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].body.properties),['Announcements']);
});
test('uncertain or pending announcements cannot be replaced by a recovery attempt',async()=>{
 const {config,api,build,row}=setup();row.properties.Announcements=rich(JSON.stringify({version:1,batches:[{state:'Sending'}]}));
 await assert.rejects(amend(config,api,build),/outstanding Slack/);
});
test('published entries cannot change IDs or wording',async()=>{
 const {config,api,row,original}=setup();original.changes=[{id:'one',summary:'Original',workItems:[]}];row.properties.Manifest=rich(JSON.stringify(original));row.properties['Manifest Hash']=rich(hash(original));row.properties.Announcements=rich(JSON.stringify({version:1,batches:[{state:'Sent',ids:['one']}]}));
 await assert.rejects(amend(config,api,async()=>({...original,changes:[{id:'one',summary:'Changed',workItems:[]}]})),/cannot rewrite/);
});
