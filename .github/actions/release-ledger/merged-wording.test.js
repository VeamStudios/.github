const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {mergedWording}=require('./changelog');
const {buildManifest,hash,rich}=require('./record');
const {amend}=require('./amend');
const repo='VeamStudios/Test';
function fixture(overrides={}) {
  const pr={number:44,state:'closed',merged_at:'2026-10-05T16:45:31Z',head:{sha:'a'.repeat(40)},merge_commit_sha:'b'.repeat(40),base:{repo:{full_name:repo}},user:{login:'author'},html_url:`https://github.com/${repo}/pull/44`,...overrides};
  const file={encoding:'base64',sha:'c'.repeat(40),content:Buffer.from('## 1.1.0\n### Changed\n- Shipped notice.\n').toString('base64')},calls=[];
  const gh=async url=>{calls.push(url);if(url.endsWith('/pulls/44'))return pr;if(url.includes('/contents/'))return file;throw Error(`Unexpected request: ${url}`)};
  return {pr,file,calls,gh,config:{repo,wordingPr:44}};
}
test('a merged wording PR needs no additional review and records actual merge acceptance',async()=>{
  const f=fixture(),result=await mergedWording(f.config,f.gh);
  assert.equal(result.pr.head.sha,f.pr.head.sha);
  assert.deepEqual(result.acceptance,{kind:'merged-pr',mergeCommit:f.pr.merge_commit_sha,mergedAt:f.pr.merged_at});
  assert.ok(f.calls.some(url=>url.endsWith(`ref=${f.pr.head.sha}`)));
  assert.ok(f.calls.some(url=>url.endsWith(`ref=${f.pr.merge_commit_sha}`)));
  assert.ok(!f.calls.some(url=>url.includes('/reviews')));
});
test('open and closed-unmerged wording cannot be accepted',async()=>{
  for(const change of [{state:'open',merged_at:null},{state:'closed',merged_at:null}]){const f=fixture(change);await assert.rejects(mergedWording(f.config,f.gh),/needs a merged PR/);assert.equal(f.calls.length,1)}
});
test('wrong repository, wrong PR number and invalid source identities fail closed',async()=>{
  for(const change of [{base:{repo:{full_name:'VeamStudios/Other'}}},{number:45},{head:{sha:'main'}},{merge_commit_sha:null}]){const f=fixture(change);await assert.rejects(mergedWording(f.config,f.gh),/needs a merged PR/)}
});
test('head content changed after merge is rejected even with a valid merged PR',async()=>{
  const f=fixture();
  await assert.rejects(mergedWording(f.config,async url=>url.endsWith(`ref=${f.pr.head.sha}`)?{...f.file,sha:'d'.repeat(40),content:Buffer.from('Later wording').toString('base64')}:f.gh(url)),/differs from the content accepted/);
});
test('mismatched merged bytes and unavailable merged content are rejected',async()=>{
  for(const change of [{content:Buffer.from('Different bytes').toString('base64')},{encoding:'none'},{sha:null},{content:null}]){
    const f=fixture();await assert.rejects(mergedWording(f.config,async url=>url.endsWith(`ref=${f.pr.merge_commit_sha}`)?{...f.file,...change}:f.gh(url)),/differs from the content accepted|content is unavailable/);
  }
});
test('merged supplement preview retains shipped identity, source mapping, original hash and announcement protections',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'merged-wording-'));
  try {
    process.chdir(dir);const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init');git('config','user.name','Test');git('config','user.email','test@example.com');
    const commit=message=>{git('add','.');git('commit','-m',message);return git('rev-parse','HEAD')};
    fs.writeFileSync('CHANGELOG.md','## 1.0.0\n### Fixed\n- Old fix.\n');const baseline=commit('base');
    fs.writeFileSync('notice.js','already shipped');const shipped=commit('notice');
    const wi='a'.repeat(32),version='deploy-123',note='Included-seat end dates and purchase billing timing are now shown.';
    const raw=`## ${version}\n### Changed\n- ${note} [PR](https://github.com/${repo}/pull/37) [Work Item](https://www.notion.so/${wi})\n\n## Unreleased\n### New\n- Future migration feature.\n`;
    fs.writeFileSync('CHANGELOG.md',raw);const wordingHead=commit('notes');const f=fixture({head:{sha:wordingHead},merge_commit_sha:wordingHead});
    f.file={encoding:'base64',sha:git('rev-parse',`${wordingHead}:CHANGELOG.md`),content:Buffer.from(raw).toString('base64')};
    const source={number:37,title:'feat: billing notice',state:'closed',merged_at:'2026-10-05T12:37:00Z',merge_commit_sha:shipped,head:{sha:shipped},base:{repo:{full_name:repo}},user:{login:'author'},body:`Work Items:\n- https://www.notion.so/${wi}`,html_url:`https://github.com/${repo}/pull/37`};
    const calls=[],gh=async url=>{calls.push(url);if(url.endsWith('/pulls/44'))return f.pr;if(url.includes('/contents/'))return f.file;if(url.includes('/commits/'))return [source];if(url.includes('/reviews'))return [];if(url.includes('/files'))return [{filename:'notice.js'}];if(url.endsWith('/pulls/37'))return source;throw Error(url)};
    const notion=async url=>url.startsWith('/pages/')?{parent:{data_source_id:'20aeddfe-a3f7-41e9-b440-c9eb6b26887f'},properties:{Name:rich('Migration')}}:{results:[],has_more:false};
    const config={repo,target:'console',product:'Site Audit Pro',version,commit:shipped,event:'release',source:'https://github.com/run',wordingPr:44};
    const candidate=await buildManifest(config,gh,baseline,notion);
    assert.equal(candidate.commit,shipped);assert.equal(candidate.baseline,baseline);assert.equal(candidate.changes.length,1);
    const change=candidate.changes[0];assert.equal(change.summary,note);assert.deepEqual(change.sourcePrs,[37]);assert.deepEqual(change.workItems,[wi]);assert.equal(change.kind,'feature');assert.equal(change.audienceGate,true);assert.equal(change.approved,true);assert.deepEqual(change.blocked,[]);
    assert.equal(candidate.prs[0].approved,false);assert.equal(candidate.wordingSource.commit,wordingHead);assert.equal(candidate.wordingSource.acceptance.kind,'merged-pr');assert.doesNotMatch(candidate.completeChangelog,/Future|Old fix/);
    assert.ok(!calls.some(url=>url.includes('/pulls/44/reviews')));
    const original={...candidate,changes:[],completeChangelog:'',wordingSource:null};const row={id:'page',parent:{data_source_id:'releases'},properties:{Manifest:rich(JSON.stringify(original)),'Manifest Hash':rich(hash(original)),Announcements:rich('')}};
    const writes=[],api={notion:async(url,method,body)=>{if(method)writes.push({method,body});return structuredClone(row)}};
    const preview=await amend({...config,pageId:'page',releasesId:'releases',dryRun:true},api,async()=>candidate);
    assert.equal(preview.originalManifestHash,hash(original));assert.deepEqual(preview.wordingSource,candidate.wordingSource);assert.equal(writes.length,0);
    await amend({...config,pageId:'page',releasesId:'releases',dryRun:false},api,async()=>candidate);
    assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].body.properties),['Announcements']);
    row.properties.Announcements=rich(JSON.stringify({version:1,batches:[{state:'Sent',ids:[change.id]}],source:{manifest:candidate,digest:hash(candidate)}}));
    await assert.rejects(amend({...config,pageId:'page',releasesId:'releases'},api,async()=>({...candidate,changes:[{...change,summary:'Rewritten notice'}]})),/cannot rewrite announced entries/);
  } finally {process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true})}
});
