const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {AppStoreConnectClient,createAppStoreConnectJwt}=require('./app-store-client');
const {observeStore}=require('./monitor-store');
const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const key=privateKey.export({format:'pem',type:'pkcs8'});
test('App Store client signs valid ES256 claims after notifier removal',()=>{
 const jwt=createAppStoreConnectJwt({keyId:'key',issuerId:'issuer',privateKey:key,nowSeconds:1000}),[head,body,signature]=jwt.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{iss:'issuer',iat:1000,exp:2200,aud:'appstoreconnect-v1'});
 assert.equal(crypto.verify('sha256',Buffer.from(`${head}.${body}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
});
const app = { id:'app', attributes:{bundleId:'com.test.app'} };
const clientFor = fetchImpl => new AppStoreConnectClient({keyId:'key',issuerId:'issuer',privateKey:key,fetchImpl,retryDelayMs:0,requestTimeoutMs:10});
test('bundle lookup selects one exact identity and never caches an inconclusive or conflicting result',async()=>{
 const responses=[{data:[]},{data:[]},{data:[]},{data:[{id:'wrong',attributes:{bundleId:'other'}}]}, {data:[{id:'wrong',attributes:{bundleId:'other'}},app]}];
 const client=clientFor(async url=>{assert.equal(new URL(url).searchParams.get('filter[bundleId]'),'com.test.app');return Response.json(responses.shift())});
 await assert.rejects(client.findAppByBundleId('com.test.app'),e=>e.verificationStatus==='unavailable');
 await assert.rejects(client.findAppByBundleId('com.test.app'),e=>e.verificationStatus==='conflict');
 assert.equal((await client.findAppByBundleId('com.test.app')).id,'app');
 assert.equal((await client.findAppByBundleId('com.test.app')).id,'app');
});
test('Apple GETs recover within a bounded retry budget and keep useful failure diagnostics',async()=>{
 for(const first of [()=>{throw new TypeError('socket closed')},()=>new Response('Unavailable',{status:503}),()=>new Response('not json'),()=>Response.json({data:[]})]){
  let attempts=0;const client=clientFor(async()=>++attempts===1?first():Response.json({data:[app]}));
  assert.equal((await client.findAppByBundleId('com.test.app')).id,'app');assert.equal(attempts,2);
 }
 for(const status of [401,403,404,429,503]){
  let attempts=0;const client=clientFor(async()=>{attempts++;return new Response('Apple diagnostic',{status,headers:{'retry-after':'0'}})});
  await assert.rejects(client.get('/apps'),e=>e.statusCode===status&&e.verificationStatus==='unavailable'&&/Apple diagnostic/.test(e.message)&&/\/apps/.test(e.message));
  assert.equal(attempts,[429,503].includes(status)?3:1);
 }
});
test('incomplete successful Apple responses retry before recording a release failure',async()=>{
 const responses={
  '/apps':{data:[app]},
  '/apps/app/appStoreVersions':{data:[{id:'version',attributes:{versionString:'1.2.3',platform:'IOS',appVersionState:'READY_FOR_DISTRIBUTION',downloadable:true}}]},
  '/appStoreVersions/version/build':{data:{attributes:{version:'7'}}},
  '/appStoreVersions/version/relationships/appStoreVersionPhasedRelease':{data:{id:'phase',type:'appStoreVersionPhasedReleases'}},
  '/appStoreVersions/version/appStoreVersionPhasedRelease':{data:{id:'phase',type:'appStoreVersionPhasedReleases',attributes:{phasedReleaseState:'COMPLETE'}}},
 };
 for(const endpoint of Object.keys(responses).slice(1))for(const recover of [true,false]){
  let attempts=0;const client=clientFor(async url=>{
   const path=new URL(url).pathname.replace(/^\/v1/,'');
   return Response.json(path===endpoint&&++attempts&&(attempts===1||!recover)?{}:responses[path]);
  });
  const read=observeStore({version:'v1.2.3',build:'7',commit:'a'.repeat(40)},app.attributes.bundleId,client);
  if(recover)assert.equal((await read).phase,'live');else await assert.rejects(read,e=>e.verificationStatus==='unavailable');
  assert.equal(attempts,recover?2:3);
 }
});
test('Apple timeout covers both response headers and a stalled response body',async()=>{
 for(const body of [false,true]){
  const signals=[];const client=clientFor(async(_url,{signal})=>{signals.push(signal);const stalled=new Promise(()=>{});return body?{ok:true,text:()=>stalled}:stalled});
  await assert.rejects(client.get('/apps'),e=>e.verificationStatus==='unavailable'&&/timed out/.test(e.message));
  assert.equal(signals.length,3);assert.ok(signals.every(signal=>signal.aborted));
 }
});
