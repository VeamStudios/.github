const {hash,text,rich,reviewed,clients,withLock}=require('./record');
const {validGooglePlay,REPOSITORY}=require('./google-play');
const {customerEntries,customerSection,websiteSection}=require('./customer-notes');
const WEBSITE='VeamStudios/siteauditpro.com';
const DESTINATION='src/app/content/changelogs/android/changelog.md';
const URL='https://siteauditpro.com';
const sectionMap=raw=>{const result=new Map();let version='';for(const line of raw.split(/\r?\n/)){if(/^## /.test(line)){version=line.slice(3).trim();if(result.has(version))throw Error('Duplicate website version');result.set(version,[])}if(version)result.get(version).push(line)}return new Map([...result].map(([v,lines])=>[v,lines.join('\n').trim()]))};
async function sourceNotes(row,api) {
  const frozen=JSON.parse(text(row.properties.Manifest)),observation=JSON.parse(text(row.properties.Observation)||'{}');
  if(hash(frozen)!==text(row.properties['Manifest Hash'])||!validGooglePlay(observation.verification,frozen)||observation.phase!=='live')throw Error('Website publication requires exact completed Google Play verification');
  if(Date.now()-Date.parse(observation.verification.checkedAt)>2*60*60*1000)throw Error('Refresh Play verification before website publication');
  const ledger=JSON.parse(text(row.properties.Announcements)||'{"version":1,"batches":[]}');
  const m=ledger.source?.manifest||frozen;
  if(ledger.source && (ledger.source.digest!==hash(m)||['key','repository','target','version','build','commit','baseline'].some(k=>m[k]!==frozen[k])))throw Error('Supplement differs from the frozen release identity');
  if(m.repository!==REPOSITORY||m.target!=='android-consumer')throw Error('Unsupported website release source');
  const sourceCommit=m.initialSnapshot?.sourceCommit||m.commit;
  const file=await api.gh(`/repos/${m.repository}/contents/CHANGELOG.md?ref=${sourceCommit}`);
  if(file.encoding!=='base64')throw Error('Exact source changelog unavailable');
  const raw=Buffer.from(file.content,'base64').toString('utf8'),section=websiteSection(raw,m.version),entries=customerEntries(raw,m.version);
  if(m.initialSnapshot) {
    const recovery=m.initialSnapshot;
    if(recovery.kind!=='android-4.0.0'||recovery.originalHash!==hash(frozen)||recovery.sourceHash!==hash(raw)||recovery.sectionHash!==hash(customerSection(raw,m.version)))throw Error('Initial-snapshot content evidence changed');
    const pr=await api.gh(`/repos/${m.repository}/pulls/${recovery.reviewPr}`);
    if(!pr.merged_at||pr.merge_commit_sha!==sourceCommit||!await reviewed(api.gh,m.repository,pr))throw Error('Initial-snapshot migration review is no longer valid');
  } else {
    if(!m.provenanceComplete)throw Error('Release notes require verified source provenance');
    for(const e of entries) {
      const matches=m.changes.filter(c=>c.sourceVersion===m.version.replace(/^v/,'')&&c.heading===e.heading&&c.summary===e.summary&&c.kind!=='internal');
      if(matches.length!==1||!matches[0].approved||!matches[0].reviewEvidence)throw Error('Every website bullet must have reviewed exact-source wording');
    }
  }
  return {manifest:m,originalHash:hash(frozen),observation,sourceCommit,sourceHash:hash(raw),section,sectionHash:hash(section)};
}
function mergeSection(before,section,version) {
  const sections=sectionMap(before),key=version.replace(/^v/,'');
  if(sections.has(key)) {
    if(sections.get(key)!==section.trim())throw Error('Published website version already has different notes; review a correction');
    return before;
  }
  const first=before.search(/^## /m);
  if(first<0)throw Error('Historical Android website sections are missing; preserve and review them first');
  return before.slice(0,first)+section.trim()+'\n\n'+before.slice(first);
}
async function publicationReceipt(row,api,value) {
  // Independent from Announcements: website retries never rewrite Slack receipts.
  const current=await api.notion(`/pages/${row.id}`);
  if(text(current.properties.Manifest)!==text(row.properties.Manifest)||text(current.properties['Manifest Hash'])!==text(row.properties['Manifest Hash']))throw Error('Frozen manifest changed during website publication');
  const observation=JSON.parse(text(current.properties.Observation)||'{}');
  await api.notion(`/pages/${row.id}`,'PATCH',{properties:{Observation:rich(JSON.stringify({...observation,website:value}))}});
}
async function publishWebsite(pageId,config,api,{fetcher=fetch}={}) {
  if(!config.publishWebsite)return {state:'disabled'};
  const row=await api.notion(`/pages/${pageId}`);
  const finish=async result=>{if(!config.dryRun)await publicationReceipt(row,api,result);return result};
  let source;
  try {source=await sourceNotes(row,api)}catch(e){return finish({...JSON.parse(text(row.properties.Observation)||'{}').website,state:'held',reason:e.message})}
  const m=source.manifest,previous=source.observation.website;
  if(previous?.state==='published') {
    if(previous.sectionHash!==source.sectionHash||previous.sourceCommit!==source.sourceCommit)throw Error('Website receipt belongs to different notes');
    return previous;
  }
  const file=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}?ref=main`);
  if(file.encoding!=='base64')throw Error('Website content unavailable');
  const before=Buffer.from(file.content,'base64').toString('utf8'),content=mergeSection(before,source.section,m.version);
  const receipt={...previous,state:'pending',repository:WEBSITE,path:DESTINATION,releasePage:pageId,sourceCommit:source.sourceCommit,shippedCommit:m.commit,sectionHash:source.sectionHash,sourceHash:source.sourceHash,manifestHash:source.originalHash,version:m.version};
  if(config.dryRun)return {...receipt,state:'preview',contentChanged:content!==before};
  if(content!==before) {
    const message=`Update changelog for ${m.version}\n\nRelease-Source-Repository: ${m.repository}\nRelease-Source-Commit: ${source.sourceCommit}\nRelease-Source-Path: CHANGELOG.md\nRelease-Shipped-Commit: ${m.commit}\nRelease-Version-Code: ${m.build}\nRelease-Notes-Hash: ${source.sectionHash}\nRelease-Ledger-Page: ${pageId}\nRelease-Manifest-Hash: ${source.originalHash}`;
    // GitHub content update uses the existing blob SHA as a compare-and-swap.
    const updated=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}`,'PUT',{message,content:Buffer.from(content).toString('base64'),sha:file.sha,branch:'main'});
    receipt.commit=updated.commit.sha;
    await publicationReceipt(row,api,receipt);
  } else if(!receipt.commit) {
    // Recover a committed update whose Notion receipt write was interrupted.
    const commits=await api.gh(`/repos/${WEBSITE}/commits?path=${encodeURIComponent(DESTINATION)}&per_page=1`);
    const latest=commits[0];
    if(!latest?.commit?.message?.includes(`Release-Ledger-Page: ${pageId}`)||!latest.commit.message.includes(`Release-Notes-Hash: ${source.sectionHash}`))return finish({...receipt,state:'held',reason:'Existing notes lack the expected source receipt; review their provenance'});
    receipt.commit=latest.sha;
    await publicationReceipt(row,api,receipt);
  }
  try {
    const marker=await fetcher(`${URL}/release-info.json?revision=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(marker.ok) {
      const info=await marker.json();
      let deployed=info.repository===WEBSITE&&info.commit===receipt.commit;
      if(info.repository===WEBSITE&&/^[a-f0-9]{40}$/.test(info.commit)&&info.commit!==receipt.commit) {
        // Normal release handling can deploy a descendant containing these exact notes.
        const comparison=await api.gh(`/repos/${WEBSITE}/compare/${receipt.commit}...${info.commit}`);
        const deployedFile=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}?ref=${info.commit}`);
        deployed=comparison.status==='ahead'&&deployedFile.encoding==='base64'&&sectionMap(Buffer.from(deployedFile.content,'base64').toString('utf8')).get(m.version.replace(/^v/,''))===source.section.trim();
      }
      if(deployed) {
        const page=await fetcher(`${URL}/releasenotes/android?revision=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(20000)});
        const html=await page.text();
        if(!page.ok||!renderedNotes(html,source.section,m.version))throw Error('Production marker matches but rendered Android release notes do not');
        Object.assign(receipt,{state:'published',deployedCommit:info.commit,verifiedAt:new Date().toISOString(),marker:`${URL}/release-info.json`,url:`${URL}/releasenotes/android`});
        await publicationReceipt(row,api,receipt);return receipt;
      }
    }
  }catch(e){receipt.verificationError=e.message}
  if(config.verifyOnly)throw Error(receipt.verificationError||'Website revision is not visible at the production marker yet');
  // Runs are deduplicated by the exact website revision; failed runs can be retried explicitly.
  const runs=await api.gh(`/repos/${WEBSITE}/actions/workflows/publish-release-notes.yml/runs?head_sha=${receipt.commit}&per_page=100`);
  if(runs.total_count>100)throw Error('Too many website attempts; reconcile explicitly');
  const attempted=runs.workflow_runs||[];
  const active=attempted.find(r=>r.status!=='completed');
  const succeeded=attempted.find(r=>r.conclusion==='success');
  if(active||succeeded)return finish({...receipt,state:'verifying',run:(active||succeeded).html_url});
  if(attempted.length&&!config.retryWebsite)return finish({...receipt,state:'held',reason:'Website deployment failed or was held; inspect its run and use explicit retry',run:attempted[0].html_url});
  const head=await api.gh(`/repos/${WEBSITE}/git/ref/heads/main`);
  if(head.object.sha!==receipt.commit)return finish({...receipt,state:'held',reason:'Website main contains other pending changes; use normal website release handling'});
  await api.gh(`/repos/${WEBSITE}/actions/workflows/publish-release-notes.yml/dispatches`,'POST',{ref:'main',inputs:{release_page:pageId,expected_commit:receipt.commit}});
  receipt.dispatchedAt=new Date().toISOString();
  await publicationReceipt(row,api,receipt);
  return receipt;
}
function renderedNotes(html,section,version) {
  const plain=s=>s.replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|#38);/g,'&').replace(/&(?:quot|#34);/g,'"').replace(/&(?:apos|#39);/g,"'").replace(/&(?:nbsp|#160);/g,' ').replace(/&#8212;|&mdash;/g,'—').replace(/&#8217;|&rsquo;/g,'’').replace(/\s+/g,' ').trim();
  const text=plain(html);
  return text.includes(version.replace(/^v/,''))&&customerEntries(section,version).every(e=>text.includes(plain(e.summary.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*_`]/g,''))));
}
module.exports={sourceNotes,mergeSection,publishWebsite,publicationReceipt,renderedNotes,sectionMap,WEBSITE,DESTINATION,URL};
