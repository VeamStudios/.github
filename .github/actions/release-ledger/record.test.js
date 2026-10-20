const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workItems } = require('./record');
const { observeStore } = require('./monitor-store');
const id = 'a'.repeat(32);
test('explicit Work Items section only; all links preserved beyond mirror caps',()=>{const ids=Array.from({length:35},(_,i)=>i.toString(16).padStart(32,'0'));assert.deepEqual(workItems('Work Items:\n'+ids.map(x=>'- https://www.notion.so/'+x).join('\n')),ids);assert.deepEqual(workItems('Mention https://www.notion.so/'+id),[])});
function apple(build='123',phased=null){return {findAppByBundleId:async()=>({id:'app',attributes:{bundleId:'com.test.app'}}),get:async(p,_params,validate=x=>x)=>validate(p.endsWith('/build')?{data:{attributes:{version:build}}}:p.includes('/relationships/')?{data:phased?{id:'phase',type:'appStoreVersionPhasedReleases'}:null}:p.endsWith('/appStoreVersionPhasedRelease')?{data:phased?{id:'phase',type:'appStoreVersionPhasedReleases',...phased}:null}:{data:[{id:'version',attributes:{versionString:'1.2.3',platform:'IOS',appStoreState:'READY_FOR_DISTRIBUTION'}}]})}}
test('App Store exact build mismatch fails; staged rollout remains limited',async()=>{const m={version:'v1.2.3',build:'123',commit:'a'.repeat(40)};await assert.rejects(observeStore(m,'com.test.app',apple('124')),/differs/);const full=await observeStore(m,'com.test.app',apple());assert.equal(full.phase,'live');assert.equal(full.timeBasis,'first-observed');const limited=await observeStore(m,'com.test.app',apple('123',{attributes:{phasedReleaseState:'ACTIVE'}}));assert.equal(limited.phase,'rollout')});
test('failed API writes report the bounded service reason and request ID without credentials',async()=>{
  const {request}=require('./record'),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return {ok:false,status:409,headers:{get:k=>k==='x-github-request-id'?'ABCD:1234':null},json:async()=>({message:'Repository rule violations found\n\nChanges must be made through a pull request. ghs_secretValue123'})}};
  try {await assert.rejects(()=>request('https://api.github.com/x','t','PUT',{}),e=>e.status===409&&e.requestId==='ABCD:1234'&&e.message==='GitHub PUT failed (409): Repository rule violations found Changes must be made through a pull request. [redacted]')}
  finally {globalThis.fetch=original}
  assert.equal(calls,1);
});
