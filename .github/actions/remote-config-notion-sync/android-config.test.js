const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateAndroidFirebaseAccount}=require('./sync');
test('Android Firebase preflight requires correct project and separate Play identity',()=>{
  const config={product:'sap',platform:'android',firebaseProjectId:'site-audit-pro'};
  const account={type:'service_account',project_id:'site-audit-pro',client_email:'firebase@site-audit-pro.iam.gserviceaccount.com',private_key:'redacted'};
  assert.doesNotThrow(()=>validateAndroidFirebaseAccount(config,account,'play@site-audit-pro.iam.gserviceaccount.com'));
  for(const invalid of [null,{...account,project_id:'other'},{...account,type:'authorized_user'}])assert.throws(()=>validateAndroidFirebaseAccount(config,invalid,'monitor'),/SERVICE_ACCOUNT_BASE64/);
  assert.throws(()=>validateAndroidFirebaseAccount(config,account,account.client_email),/separate/);
  assert.throws(()=>validateAndroidFirebaseAccount(config,account,''),/separate/);
  assert.doesNotThrow(()=>validateAndroidFirebaseAccount({...config,platform:'ios'},null,''));
});
