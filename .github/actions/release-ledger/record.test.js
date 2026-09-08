const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { workItems, validateNote, buildManifest, withLock, record, hash, rich } = require('./record');
const { observeStore } = require('./monitor-store');
const id = 'a'.repeat(32);
const note = {kind:'feature',summary:'Export reports',audience:'Enterprise',limitations:'Cloud only',scope:'report-export-v1',targets:['web'],audienceGate:true,requiredReleaseKeys:[],workItems:[id]};
test('explicit Work Items section only; all links preserved beyond mirror caps',()=>{const ids=Array.from({length:35},(_,i)=>i.toString(16).padStart(32,'0'));assert.deepEqual(workItems('Work Items:\n'+ids.map(x=>'- https://www.notion.so/'+x).join('\n')),ids);assert.deepEqual(workItems('Mention https://www.notion.so/'+id),[])});
test('committed Work Items cannot change through mutable PR metadata',()=>{assert.throws(()=>validateNote(note,[]),/match/);assert.deepEqual(validateNote(note,[id]).workItems,[id]);assert.doesNotThrow(()=>validateNote({...note,kind:'fix',workItems:[]},[]))});
test('atomic shared ref excludes concurrent publishers and releases owner lock',async()=>{let locked=false,active=0,max=0;const gh=async(p,m,b)=>{if(p.endsWith('/heads/main'))return {object:{sha:'a'.repeat(40)}};if(p.endsWith('/git/tags'))return {sha:b.message};if(p.endsWith('/git/refs')&&m==='POST'){if(locked)throw new Error('exists');locked=b.sha;return {}};if(m==='DELETE'){locked=false;return{}};return {object:{sha:locked}}};const fn=()=>withLock(gh,'repo',async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));active--});const results=await Promise.allSettled([fn(),fn()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(max,1);assert.equal(locked,false)});
test('exact shipped range excludes later PR; missing review prevents automatic approval',async()=>{const cwd=process.cwd();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-ledger-'));try{process.chdir(dir);const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init');git('config','user.name','Test');git('config','user.email','test@example.com');fs.writeFileSync('base','base');git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');fs.mkdirSync('.release-notes');fs.writeFileSync('.release-notes/export.json',JSON.stringify(note));git('add','.');git('commit','-m','feature');const shipped=git('rev-parse','HEAD');fs.writeFileSync('later','later');git('add','.');git('commit','-m','later');const later=git('rev-parse','HEAD');const pr={number:7,merged_at:'2026-09-07',base:{repo:{full_name:'VeamStudios/Test'}},merge_commit_sha:shipped,head:{sha:shipped},user:{login:'author'},html_url:'https://github.com/VeamStudios/Test/pull/7',body:`Work Items:\n- https://www.notion.so/${id}\n\nRelease note: .release-notes/export.json`};let queried=[];const gh=async url=>{queried.push(url);if(url.includes('/commits/'))return [pr];if(url.includes('/reviews'))return [];if(url.includes('/files'))return [{filename:'.release-notes/export.json',status:'added'}];return pr};const config={repo:'VeamStudios/Test',target:'web',product:'Site Audit Pro',version:'v1',commit:shipped,event:'release',source:pr.html_url};const m=await buildManifest(config,gh,base);assert.equal(m.commit,shipped);assert.equal(m.changes.length,1);assert.equal(m.prs[0].approved,false);assert.ok(m.issues.some(x=>x.includes('human review')));assert.ok(!queried.some(x=>x.includes(later)));const gap=await buildManifest(config,gh,'');assert.equal(gap.provenanceComplete,false);assert.equal(gap.changes.length,0);
// A retry cannot regress a live observation or overwrite edited wording.
const row={id:'row',properties:{Manifest:rich(JSON.stringify(m)),Observation:rich(JSON.stringify({phase:'live',releasedAt:'2026-09-07'})),State:{select:{name:'Available'}},Changelog:rich('Edited after approval')}};const result=await record({...config,build:'',phase:'uploaded',releasesId:'releases',dryRun:true},{gh,notion:async(path)=>path === '/data_sources/releases' ? { properties: { Target: { type: 'rich_text' }, Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } } } } : ({results:[row],has_more:false})});assert.equal(result.properties.Observation,undefined);assert.equal(result.properties.Changelog,undefined);
}finally{process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true})}});
function apple(build='123',phased=null){return {findAppByBundleId:async()=>({id:'app',attributes:{bundleId:'com.test.app'}}),get:async p=>p.endsWith('/build')?{data:{attributes:{version:build}}}:p.includes('/relationships/')?{data:phased?{id:'phase',type:'appStoreVersionPhasedReleases'}:null}:p.endsWith('/appStoreVersionPhasedRelease')?{data:phased?{id:'phase',type:'appStoreVersionPhasedReleases',...phased}:null}:{data:[{id:'version',attributes:{versionString:'1.2.3',platform:'IOS',appStoreState:'READY_FOR_DISTRIBUTION'}}]}}}
test('malformed shipped PR links are recorded as errors while valid siblings remain in the manifest', async () => {
  const cwd = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ledger-siblings-'));
  try {
    process.chdir(dir);
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    fs.writeFileSync('base', 'base'); git('add', '.'); git('commit', '-m', 'base');
    const baseline = git('rev-parse', 'HEAD');
    fs.mkdirSync('.release-notes');
    fs.writeFileSync('.release-notes/fix.json', JSON.stringify({ ...note, kind: 'fix', workItems: [] }));
    git('add', '.'); git('commit', '-m', 'fix');
    const first = git('rev-parse', 'HEAD');
    fs.writeFileSync('.release-notes/export.json', JSON.stringify(note));
    git('add', '.'); git('commit', '-m', 'feature');
    const shipped = git('rev-parse', 'HEAD');
    const repo = 'VeamStudios/Test';
    const pr = (number, commit, body) => ({ number, merged_at: '2026-09-08', base: { repo: { full_name: repo } }, merge_commit_sha: commit, head: { sha: commit }, user: { login: 'author' }, html_url: `https://github.com/${repo}/pull/${number}`, body });
    const bad = pr(7, first, 'Work Items:\n- <url>\n\nRelease note: .release-notes/fix.json');
    const good = pr(8, shipped, `Work Items:\n- https://www.notion.so/${id}\n\nRelease note: .release-notes/export.json`);
    const gh = async url => {
      if (url.includes('/commits/')) return [url.includes(first) ? bad : good];
      if (url.includes('/reviews')) return [{ user: { type: 'User', login: 'reviewer' }, state: 'APPROVED', commit_id: shipped }];
      if (url.includes('/files')) return [{ filename: '.release-notes/export.json', status: 'added' }];
      return url.endsWith('/7') ? bad : good;
    };
    const config = { repo, target: 'web', product: 'Site Audit Pro', version: 'v1', commit: shipped, baseline, event: 'release', source: good.html_url, phase: 'prepare', releasesId: 'releases', dryRun: true };
    const api = { gh, notion: async path => path === '/data_sources/releases' ? { properties: { Target: { type: 'rich_text' }, Products: { type: 'relation', relation: { data_source_id: '30c06908-3a03-80ca-bd1b-000b2bbce6d8' } } } } : ({ results: [], has_more: false }) };
    const result = await record(config, api);
    const manifest = result.manifest;
    assert.deepEqual(manifest.prs.map(p => p.number), [7, 8]);
    assert.equal(manifest.prs[0].approved, false);
    assert.equal(manifest.prs[0].noteHash, '');
    assert.equal(manifest.prs[1].approved, true);
    assert.deepEqual(manifest.changes.map(c => c.pr), [8]);
    assert.match(manifest.issues.join('\n'), /PR #7: Invalid Work Items/);
    assert.equal(result.properties['Approved Hash'], undefined);
    // Retain valid explicit links even if another entry on that PR is invalid.
    bad.body = `Work Items:\n- <url>\n- https://www.notion.so/${id}\n\nRelease note: .release-notes/fix.json`;
    const mixed = await buildManifest(config, gh, baseline);
    assert.deepEqual(mixed.prs[0].workItems, [id]);
    assert.equal(mixed.prs[0].approved, false);
    assert.deepEqual(mixed.changes.map(c => c.pr), [8]);
  } finally {
    process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('App Store exact build mismatch fails; staged rollout remains limited',async()=>{const m={version:'v1.2.3',build:'123',commit:'a'.repeat(40)};await assert.rejects(observeStore(m,'com.test.app',apple('124')),/differs/);const full=await observeStore(m,'com.test.app',apple());assert.equal(full.phase,'live');assert.equal(full.timeBasis,'first-observed');const limited=await observeStore(m,'com.test.app',apple('123',{attributes:{phasedReleaseState:'ACTIVE'}}));assert.equal(limited.phase,'rollout')});
