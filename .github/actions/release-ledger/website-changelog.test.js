const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WEBSITES,changedVersions,verifiedSync,websiteChanges}=require('./website-changelog');
const sha='a'.repeat(40),base='b'.repeat(40),source='c'.repeat(40),repo='VeamStudios/siteauditpro.com';
const before='## 5.10.0\n### Fixed\n- Old fix.\n',after='## 5.11.0\n### New\n- App feature, never copy this into website release notes.\n\n'+before;
const file=WEBSITES[repo][0];
function git(command,...args){if(command==='show')return args[0].startsWith(base)?before:after;if(command==='log'||command==='diff-tree')return command==='log'?sha:file.path;throw new Error(command)}
function github(overrides={}){return async url=>url.includes('/contents/')?{encoding:'base64',content:Buffer.from(after).toString('base64'),...overrides.content}:url.includes('/SiteAuditPro-Web/')?{sha:source}:{author:{login:'veamstudios-release-bot[bot]',type:'Bot'},commit:{message:'Update changelog for v5.11.0'},...overrides.metadata}}
test('detects new, corrected and removed sections, ignoring empty-line changes',()=>{
 assert.deepEqual(changedVersions(before,after),['5.11.0']);
 assert.deepEqual(changedVersions(after,after.replace('App feature','Corrected feature')),['5.11.0']);
 assert.deepEqual(changedVersions(after,before),['5.11.0']);
 assert.deepEqual(changedVersions(before,before+'\n'),[]);
});
test('registered release bot sync requires exact source bytes and identity',async()=>{
 const sync=await verifiedSync(repo,sha,github(),git);assert.equal(sync.sourceCommit,source);
 assert.equal(await verifiedSync(repo,sha,github({content:{content:Buffer.from('different').toString('base64')}}),git),null);
 assert.equal(await verifiedSync(repo,sha,github({metadata:{author:{login:'other[bot]',type:'Bot'}}}),git),null);
 assert.equal(await verifiedSync(repo,sha,github(),(cmd,...args)=>cmd==='diff-tree'?file.path+'\napp.js':git(cmd,...args)),null);
 assert.equal(await verifiedSync(repo,sha,github({metadata:{commit:{message:'Update changelog for v5.11.0\n\nRelease-Source-Commit: '+source+'\nRelease-Source-Repository: VeamStudios/Wrong\nRelease-Source-Path: CHANGELOG.md'}}}),git),null);
});
test('source trailers pin the exact commit, including opaque four-component versions',async()=>{
 const calls=[];const gh=github({metadata:{commit:{message:`Update changelog for v5.11.0.1\n\nRelease-Source-Repository: ${file.repository}\nRelease-Source-Commit: ${source}\nRelease-Source-Path: CHANGELOG.md`}}});
 assert.ok(await verifiedSync(repo,sha,async url=>{calls.push(url);return gh(url)},git));
 assert.ok(calls.some(url=>url.endsWith('/commits/'+source)));
});
test('all supported website paths produce website wording and no app lifecycle association',()=>{
 for(const [repository,files] of Object.entries(WEBSITES))for(const destination of files){
  const local=(cmd,...args)=>cmd==='show'?(args[0].endsWith(':'+destination.path)?(args[0].startsWith(base)?before:after):''):sha;
  const context={files:[{filename:destination.path}],commits:[sha],approved:true,pr:{number:2,html_url:'https://github.com/'+repository+'/pull/2'}};
  const changes=websiteChanges({repo:repository},base,sha,[context],[],local);
  assert.equal(changes.length,1);assert.equal(changes[0].summary,`Updated changelog for ${destination.label} Release 5.11.0`);
  assert.deepEqual(changes[0].workItems,[]);assert.equal(changes[0].availabilityMode,undefined);assert.equal(changes[0].approved,true);
  assert.doesNotMatch(JSON.stringify(changes),/App feature/);
  assert.equal(websiteChanges({repo:repository},base,sha,[{...context,approved:false}],[],local)[0].approved,false);
 }
});
test('one verified sync cannot approve another unreviewed change to that file',()=>{
 const local=(cmd,...args)=>cmd==='show'?(args[0].endsWith(':'+file.path)?(args[0].startsWith(base)?before:after):''):sha+'\n'+source;
 const changes=websiteChanges({repo},base,sha,[],[{commit:sha,evidence:'https://github.com/proof'}],local);
 assert.equal(changes[0].approved,false);
});
