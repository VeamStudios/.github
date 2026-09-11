const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {parseChangelog,newEntries,renderChangelog}=require('./changelog');
const {buildManifest,deployedBaseline,rich,hash}=require('./record');
const {check}=require('./check-note');
test('metadata and multiline entries survive without leaking raw flags into wording',()=>{const entries=parseChangelog('# Product\n## [Unreleased]\n### New\n- Export reports.\n  Include all photos.\n  rcValue: export_enabled\n  previewTag: Research Preview\n');assert.equal(entries[0].summary,'Export reports.\nInclude all photos.');assert.deepEqual(entries[0].flagKeys,['export_enabled']);assert.equal(entries[0].previewTag,'Research Preview');assert.doesNotMatch(renderChangelog(entries),/rcValue|export_enabled/)});
test('section moves and formatting alone are not new release notes',()=>{const before='## Unreleased\n### Fixed\n- Fix   exports.\n';const after='## 1.2.0\n### Fixed\n- Fix exports.\n';assert.deepEqual(newEntries(before,after),[])});
test('missing notes produce an advisory preview without requiring JSON',()=>{const result=check('','a'.repeat(40),()=>{throw new Error('missing')});assert.match(result.warnings.join('\n'),/CHANGELOG/);assert.doesNotMatch(result.warnings.join('\n'),/\.json/)});
test('verified deployment can be a baseline while feature wording is pending',()=>{const m={target:'web',commit:'a'.repeat(40)},row={properties:{Manifest:rich(JSON.stringify(m)),'Manifest Hash':rich(hash(m)),State:{select:{name:'Waiting'}},Observation:rich(JSON.stringify({phase:'deployed',verification:{kind:'http',reportedCommit:m.commit,commit:m.commit,evidence:'https://production.test'}}))}};assert.equal(deployedBaseline(row),true);row.properties.Observation=rich(JSON.stringify({phase:'uploaded'}));assert.equal(deployedBaseline(row),false)});
test('exact shipped changelog includes skipped versions and frozen Work Items without JSON',async()=>{
  const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'changelog-manifest-'));
  try {
    process.chdir(dir);const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init');git('config','user.name','Test');git('config','user.email','test@example.com');
    const commit=message=>{git('add','.');git('commit','-m',message);return git('rev-parse','HEAD')};
    fs.writeFileSync('CHANGELOG.md','## 1.0.0\n### Fixed\n- Old fix.\n');const baseline=commit('base');
    fs.writeFileSync('CHANGELOG.md','## 1.1.0\n### Fixed\n- Fix exports.\n\n'+fs.readFileSync('CHANGELOG.md','utf8'));const first=commit('fix');
    fs.writeFileSync('CHANGELOG.md','## 1.2.0\n### New\n- Export spreadsheets.\n  rcValue: export_enabled\n\n'+fs.readFileSync('CHANGELOG.md','utf8'));const shipped=commit('feature');
    fs.writeFileSync('later','not shipped');const later=commit('later');const repo='VeamStudios/Test',wi='a'.repeat(32);
    const pr=(number,sha,body)=>({number,merged_at:'2026-09-09',merge_commit_sha:sha,head:{sha},base:{repo:{full_name:repo}},user:{login:'author'},body,html_url:`https://github.com/${repo}/pull/${number}`});
    const prs=[pr(1,first,''),pr(2,shipped,`Work Items:\n- https://www.notion.so/${wi}`)];const queried=[];
    const gh=async url=>{queried.push(url);if(url.includes('/commits/'))return [url.includes(first)?prs[0]:prs[1]];const p=url.includes('/pulls/1')?prs[0]:prs[1];if(url.includes('/reviews'))return [{user:{type:'User',login:'reviewer'},state:'APPROVED',commit_id:p.head.sha}];if(url.includes('/files'))return [{filename:'CHANGELOG.md',status:'modified'}];return p};
    const notion=async url=>url.startsWith('/pages/')?{parent:{data_source_id:'20aeddfe-a3f7-41e9-b440-c9eb6b26887f'},properties:{Name:{title:[{text:{content:'Spreadsheet exports'}}]},'Feature Changelog Text':rich('Export your reports as spreadsheets.')}}:{results:[],has_more:false};
    const m=await buildManifest({repo,product:'Site Audit Pro',target:'web',version:'v1.2.0',commit:shipped,event:'release',source:'https://github.com/run'},gh,baseline,notion);
    assert.equal(m.schemaVersion,2);assert.equal(m.commit,shipped);assert.equal(m.changes.length,2);assert.deepEqual(m.changes.map(c=>c.kind),['feature','fix']);assert.ok(m.changes.every(c=>c.approved));assert.equal(m.workItemSnapshots[0].description,'Export your reports as spreadsheets.');assert.doesNotMatch(m.completeChangelog,/Old fix|rcValue/);assert.match(m.completeChangelog,/1\.1\.0/);assert.ok(!queried.some(url=>url.includes(later)));assert.deepEqual(m.changes[1].workItems,[]);
  }finally{process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true})}
});

test('a repeated fix is new only when an additional version occurrence was added',()=>{const before='## 1.0.0\n### Fixed\n- Performance improvements.\n';const after='## 1.1.0\n### Fixed\n- Performance improvements.\n'+before;const added=newEntries(before,after);assert.equal(added.length,1);assert.equal(added[0].version,'1.1.0')});
test('adding a source link while moving a section does not duplicate the entry',()=>{assert.deepEqual(newEntries('## Unreleased\n### Fixed\n- Fix exports.\n','## 1.1.0\n### Fixed\n- Fix exports. [PR](https://github.com/VeamStudios/Test/pull/2)\n'),[])});

test('audited historical baseline remains usable without changing its frozen manifest or availability',()=>{const m={repository:'VeamStudios/App',target:'ios-consumer',commit:'a'.repeat(40),build:''},digest=hash(m),baseline={kind:'audited-production-baseline',repository:m.repository,target:m.target,commit:m.commit,build:'5',manifestHash:digest,checkedAt:new Date().toISOString(),evidence:['https://appstoreconnect.apple.com/apps/1','https://github.com/VeamStudios/App/releases/tag/v1']};const row={properties:{Manifest:rich(JSON.stringify(m)),'Manifest Hash':rich(digest),Build:rich('5'),Historical:{checkbox:true},Observation:rich(JSON.stringify({baseline}))}};assert.equal(deployedBaseline(row),true);for(const change of [{commit:'b'.repeat(40)},{build:'6'},{manifestHash:'changed'},{evidence:[]}]){row.properties.Observation=rich(JSON.stringify({baseline:{...baseline,...change}}));assert.equal(deployedBaseline(row),false)}});
