const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateAndroidFirebaseAccount}=require('./sync');
test('Android Firebase preflight requires correct project and separate Play identity',()=>{
  const config={product:'sap',platform:'android',firebaseProjectId:'site-audit-pro'};
  const account={type:'service_account',project_id:'site-audit-pro',client_email:'firebase@site-audit-pro.iam.gserviceaccount.com',private_key:'redacted'};
  assert.doesNotThrow(()=>validateAndroidFirebaseAccount(config,account,'play@site-audit-pro.iam.gserviceaccount.com',true));
  for(const invalid of [null,{...account,project_id:'other'},{...account,type:'authorized_user'}])assert.throws(()=>validateAndroidFirebaseAccount(config,invalid,'monitor',true),/SERVICE_ACCOUNT_BASE64/);
  assert.throws(()=>validateAndroidFirebaseAccount(config,account,account.client_email,true),/separate/);
  assert.throws(()=>validateAndroidFirebaseAccount(config,account,'',true),/separate/);
  for(const product of ['sap','cip'])for(const platform of ['ios','web','backend','all'])assert.doesNotThrow(()=>validateAndroidFirebaseAccount({product,platform},null,'',true));
});
test('existing Android callers do not require new Play configuration until they opt in',()=>{
  const legacy={product:'sap',platform:'android',firebaseProjectId:'site-audit-pro'};
  assert.doesNotThrow(()=>validateAndroidFirebaseAccount(legacy,null,''));
  assert.doesNotThrow(()=>validateAndroidFirebaseAccount(legacy,null,'',false));
  assert.throws(()=>validateAndroidFirebaseAccount(legacy,null,'',true),/SERVICE_ACCOUNT_BASE64/);
});
