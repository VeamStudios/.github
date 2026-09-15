const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {AppStoreConnectClient,createAppStoreConnectJwt}=require('./app-store-client');
const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const key=privateKey.export({format:'pem',type:'pkcs8'});
test('App Store client signs valid ES256 claims after notifier removal',()=>{
 const jwt=createAppStoreConnectJwt({keyId:'key',issuerId:'issuer',privateKey:key,nowSeconds:1000}),[head,body,signature]=jwt.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{iss:'issuer',iat:1000,exp:2200,aud:'appstoreconnect-v1'});
 assert.equal(crypto.verify('sha256',Buffer.from(`${head}.${body}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
});
test('App Store requests retain bundle filtering and surface failed verification reads',async()=>{
 const calls=[],client=new AppStoreConnectClient({keyId:'key',issuerId:'issuer',privateKey:key,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>JSON.stringify({data:[{id:'app'}]})}}});
 assert.equal((await client.findAppByBundleId('com.test.app')).id,'app');await client.findAppByBundleId('com.test.app');assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).searchParams.get('filter[bundleId]'),'com.test.app');
 client.fetchImpl=async()=>({ok:false,status:503,text:async()=> 'Unavailable'});await assert.rejects(client.get('/apps'),/HTTP 503/);
});
