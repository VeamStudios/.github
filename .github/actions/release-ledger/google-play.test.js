const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GooglePlayMonitor,observePlay,resolveBuild,snapshotBuilds,validGooglePlay,PACKAGE,REPOSITORY,ROOT}=require('./google-play');
const {ensureRelease,monitor}=require('./monitor-play');
const {hash,rich}=require('./record');
const identity={repository:REPOSITORY,target:'android-consumer',version:'v4.0.0',build:'211481388',commit:'a'.repeat(40),internalTag:'internal/4.0.0-211481388'};
function snapshot(state='PUBLISHED',status='completed') {return {packageName:PACKAGE,track:'production',checkedAt:new Date().toISOString(),evidence:`${ROOT}/tracks/production/releases`,rolloutEvidence:`${ROOT}/edits/123/tracks/production`,lifecycle:{releases:[{track:'production',activeArtifacts:[{versionCode:211481388}],releaseLifecycleState:`RELEASE_LIFECYCLE_STATE_${state}`}]},rollout:{track:'production',releases:[{versionCodes:['211481388'],status,...(status==='inProgress'?{userFraction:0.2}:{})}]}}}
for(const state of ['DRAFT','NOT_SENT_FOR_REVIEW','IN_REVIEW','APPROVED_NOT_PUBLISHED','NOT_APPROVED'])test(`${state} is waiting even if edit reports completed`,()=>assert.equal(observePlay(identity,snapshot(state)).phase,'uploaded'));
for(const [status,phase] of [['inProgress','rollout'],['halted','halted'],['completed','live']])test(`published ${status} produces ${phase}`,()=>{const o=observePlay(identity,snapshot('PUBLISHED',status));assert.equal(o.phase,phase);assert.equal(validGooglePlay(o.verification,identity),status==='completed')});
test('wrong package, build, track, unknown state, duplicates and restricted rollout fail closed',()=>{
  const variations=[s=>s.packageName+='enterprise',s=>s.track='internal',s=>s.rollout.track='internal',s=>s.lifecycle.releases[0].activeArtifacts[0].versionCode++,s=>s.lifecycle.releases.push(s.lifecycle.releases[0]),s=>s.rollout.releases.push(s.rollout.releases[0]),s=>s.lifecycle.releases[0].releaseLifecycleState='PUBLISHED',s=>s.rollout.releases[0].status='newStatus',s=>s.rollout.releases[0].countryTargeting={countries:['GB']},s=>s.rollout.releases[0].userFraction=0.5];
  for(const change of variations){const s=snapshot();change(s);assert.throws(()=>observePlay(identity,s))}
});
test('exact internal tag resolves marketing version; duplicates never pick highest/main',()=>{
  const resolve=tag=>{assert.equal(tag,identity.internalTag);return identity.commit};
  assert.deepEqual(resolveBuild(identity.build,[identity.internalTag,'internal/8.0.0-999999999'],resolve),identity);
  assert.throws(()=>resolveBuild(identity.build,[],resolve),/exactly one/);
  assert.throws(()=>resolveBuild(identity.build,[identity.internalTag,`internal/4.0.1-${identity.build}`],resolve),/exactly one/);
  assert.throws(()=>resolveBuild(identity.build,[`internal/main-${identity.build}`],resolve),/marketing/);
});
test('monitor identity must differ from uploader and match configured account',()=>{
  assert.throws(()=>new GooglePlayMonitor({type:'service_account',client_email:'same',private_key:'key'},{expectedEmail:'same',uploaderEmail:'same'}),/dedicated/);
});
test('temporary edit is always deleted after failed read and is never committed',async()=>{
  const calls=[];
  const client=new GooglePlayMonitor({type:'service_account',client_email:'monitor',private_key:'key'},{expectedEmail:'monitor',uploaderEmail:'uploader',fetcher:async(url,options)=>{
    calls.push([url,options.method]);
    if(url.endsWith('/tracks/production/releases'))return {ok:true,json:async()=>snapshot().lifecycle};
    if(url.endsWith('/edits'))return {ok:true,json:async()=>({id:'123'})};
    if(options.method==='DELETE')return {ok:true,status:204};
    return {ok:false,status:403};
  }});
  client.token=async()=>'redacted';
  await assert.rejects(()=>client.snapshot(),/403/);
  assert.equal(calls.at(-1)[1],'DELETE');
  assert.equal(calls.some(([url])=>url.includes(':commit')),false);
});
test('lifecycle changes during inspection are rejected',async()=>{
  let count=0;
  const client=new GooglePlayMonitor({type:'service_account',client_email:'monitor',private_key:'key'},{expectedEmail:'monitor',uploaderEmail:'uploader',fetcher:async(url,options)=>({ok:true,status:options.method==='DELETE'?204:200,json:async()=>url.endsWith('/releases')?snapshot(++count===1?'PUBLISHED':'IN_REVIEW').lifecycle:url.endsWith('/edits')?{id:'123'}:snapshot().rollout})});client.token=async()=>'';
  await assert.rejects(()=>client.snapshot(),/changed during/);
});
function github() {
  let tag=null,release=null;const writes=[];
  const gh=async(path,method='GET',body)=>{
    if(method==='POST'){writes.push(path);if(path.endsWith('/git/refs')){tag=body.sha;return {}};if(path.endsWith('/releases')){release={...body,html_url:'https://github.com/release'};return release}}
    if(path.includes('/git/ref/tags/')){if(tag)return {object:{type:'commit',sha:tag}}}
    else if(path.includes('/releases/tags/')&&release)return release;
    throw Object.assign(Error('not found'),{status:404});
  };
  return {gh,writes,setTag:sha=>tag=sha,setRelease:r=>release=r};
}
test('missing tag/release created once; retry reuses exact identity and rejects different build',async()=>{
  const api=github();
  await ensureRelease(identity,api.gh,false);await ensureRelease(identity,api.gh,false);
  assert.equal(api.writes.length,2);
  await assert.rejects(()=>ensureRelease({...identity,build:'211481389'},api.gh,false),/conflicts/);
  assert.equal(api.writes.length,2);
});
test('conflicting production tag never writes',async()=>{const api=github();api.setTag('b'.repeat(40));await assert.rejects(()=>ensureRelease(identity,api.gh,false),/different commit/);assert.equal(api.writes.length,0)});
test('shadow monitor performs no writes; completed and rollout releases cannot be confused',async()=>{
  for(const status of ['completed','inProgress','halted']){
    const api=github();let recorded=0,published=0;
    const result=await monitor({repo:REPOSITORY,releasesId:'db',dryRun:true},{gh:api.gh,notion:async()=>({results:[]})},{snapshot:async()=>snapshot('PUBLISHED',status)},{resolve:()=>identity,recorder:async(config)=>{assert.equal(config.dryRun,true);recorded++;return {pageId:'page'}},publish:async()=>{published++;return {state:'preview'}}});
    assert.equal(result.errors.length,0);assert.equal(recorded,1);assert.equal(published,status==='completed'?1:0);assert.equal(api.writes.length,0);
  }
});
test('API failure invalidates pending availability and never calls recorder or publisher',async()=>{
  const row={id:'page',properties:{Manifest:rich(JSON.stringify(identity)),Observation:rich(JSON.stringify({phase:'live',verification:{kind:'google-play'}}))}};const updates=[];
  const api={gh:()=>assert.fail(),notion:async(path,method,body)=>{if(path.includes('/query'))return {results:[row]};updates.push(body);return {}}};
  await assert.rejects(()=>monitor({repo:REPOSITORY,releasesId:'db',dryRun:false},api,{snapshot:async()=>{throw Error('API unavailable')}},{recorder:()=>assert.fail(),publish:()=>assert.fail()}),/unavailable/);
  assert.equal(updates.length,1);assert.match(JSON.stringify(updates[0]),/verification\\":null/);
});
module.exports={identity,snapshot};
