const {hash,text,rich,reviewed,clients}=require('./record');
const {validGooglePlay,REPOSITORY}=require('./google-play');
const {WEBSITE_RECEIPT,previousObservation,reviewedSource}=require('./ledger-columns');
const {customerEntries,customerSection,websiteSection}=require('./customer-notes');
const WEBSITE='VeamStudios/siteauditpro.com';
const DESTINATION='src/app/content/changelogs/android/changelog.md';
const URL='https://siteauditpro.com';
const sectionMap=raw=>{const result=new Map();let version='';for(const line of raw.split(/\r?\n/)){if(/^## /.test(line)){version=line.slice(3).trim();if(result.has(version))throw Error('Duplicate website version');result.set(version,[])}if(version)result.get(version).push(line)}return new Map([...result].map(([v,lines])=>[v,lines.join('\n').trim()]))};
async function sourceNotes(row,api) {
  const frozen=JSON.parse(text(row.properties.Manifest)),observation=previousObservation(row.properties)||{};
  if(hash(frozen)!==text(row.properties['Manifest Hash'])||!validGooglePlay(observation.verification,frozen)||observation.phase!=='live')throw Error('Website publication requires exact completed Google Play verification');
  if(Date.now()-Date.parse(observation.verification.checkedAt)>2*60*60*1000)throw Error('Refresh Play verification before website publication');
  const supplement=reviewedSource(row.properties);
  const m=supplement?.manifest||frozen;
  if(supplement && (supplement.digest!==hash(m)||['key','repository','target','version','build','commit','baseline'].some(k=>m[k]!==frozen[k])))throw Error('Supplement differs from the frozen release identity');
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
  // Readers fold this owned column into the observation; the shared Observation is no longer written.
  await api.notion(`/pages/${row.id}`,'PATCH',{properties:{[WEBSITE_RECEIPT]:rich(JSON.stringify(value))}});
}
const decode=file=>Buffer.from(file.content,'base64').toString('utf8');
async function releasePr(api,branch,number) {
  if(number) {
    const pr=await api.gh(`/repos/${WEBSITE}/pulls/${number}`);
    if(pr.head?.ref!==branch||pr.base?.ref!=='main')throw Error('Website receipt references a different pull request');
    return pr;
  }
  const prs=(await api.gh(`/repos/${WEBSITE}/pulls?state=all&base=main&head=${WEBSITE.split('/')[0]}:${encodeURIComponent(branch)}&per_page=100`)).filter(p=>p.head?.ref===branch&&p.base?.ref==='main');
  if(prs.length>1)throw Error('Duplicate website notes pull requests; reconcile explicitly');
  return prs[0];
}
async function prepareBranch(api,branch,content,message) {
  // The branch is bot-owned: it always holds exactly current main plus this release's notes.
  const main=(await api.gh(`/repos/${WEBSITE}/git/ref/heads/main`)).object.sha;
  let ref;
  try {ref=await api.gh(`/repos/${WEBSITE}/git/ref/heads/${branch}`)}catch(e){if(e.status!==404)throw e}
  if(!ref)await api.gh(`/repos/${WEBSITE}/git/refs`,'POST',{ref:`refs/heads/${branch}`,sha:main});
  else if(ref.object.sha!==main) {
    const cmp=await api.gh(`/repos/${WEBSITE}/compare/${main}...${ref.object.sha}`);
    if(cmp.behind_by||cmp.ahead_by!==1||cmp.files?.length!==1||cmp.files[0].filename!==DESTINATION)await api.gh(`/repos/${WEBSITE}/git/refs/heads/${branch}`,'PATCH',{sha:main,force:true});
  }
  const file=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}?ref=${encodeURIComponent(branch)}`);
  if(file.encoding!=='base64')throw Error('Website content unavailable');
  if(decode(file)===content)return (await api.gh(`/repos/${WEBSITE}/git/ref/heads/${branch}`)).object.sha;
  // The blob SHA is a compare-and-swap against concurrent branch updates.
  const updated=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}`,'PUT',{message,content:Buffer.from(content).toString('base64'),sha:file.sha,branch});
  return updated.commit.sha;
}
async function openPr(api,branch,title,m,source) {
  const body=`Automated Android release notes for ${m.version} (versionCode ${m.build}), verified live on Google Play.\n\n- Source: https://github.com/${m.repository}/blob/${source.sourceCommit}/CHANGELOG.md\n- Shipped commit: ${m.commit}\n- Notes hash: \`${source.sectionHash}\`\n\nThe release bot squash-merges this PR with the exact title and source trailers, then deploys through \`publish-release-notes.yml\`.`;
  try {return await api.gh(`/repos/${WEBSITE}/pulls`,'POST',{title,head:branch,base:'main',body})}
  catch(e) {
    // A lost create response leaves the PR in place; reuse it rather than opening a second one.
    if(e.status!==422)throw e;
    const pr=await releasePr(api,branch);
    if(!pr||pr.state!=='open')throw e;
    return pr;
  }
}
async function mergedNotes(api,commit,pageId,source,version) {
  if(!/^[a-f0-9]{40}$/.test(commit||''))return false;
  const metadata=await api.gh(`/repos/${WEBSITE}/commits/${commit}`),message=metadata.commit?.message||'';
  if(!message.includes(`Release-Ledger-Page: ${pageId}`)||!message.includes(`Release-Notes-Hash: ${source.sectionHash}`))return false;
  const file=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}?ref=${commit}`);
  return file.encoding==='base64'&&sectionMap(decode(file)).get(version.replace(/^v/,''))===source.section.trim();
}
async function publishWebsite(pageId,config,api,{fetcher=fetch}={}) {
  if(!config.publishWebsite)return {state:'disabled'};
  const row=await api.notion(`/pages/${pageId}`);
  const finish=async result=>{if(!config.dryRun)await publicationReceipt(row,api,result);return result};
  let source;
  try {source=await sourceNotes(row,api)}catch(e){return finish({...previousObservation(row.properties)?.website,state:'held',reason:e.message})}
  const m=source.manifest,previous=source.observation.website;
  if(previous?.state==='published') {
    if(previous.sectionHash!==source.sectionHash||previous.sourceCommit!==source.sourceCommit)throw Error('Website receipt belongs to different notes');
    return previous;
  }
  const file=await api.gh(`/repos/${WEBSITE}/contents/${DESTINATION}?ref=main`);
  if(file.encoding!=='base64')throw Error('Website content unavailable');
  const before=decode(file),content=mergeSection(before,source.section,m.version);
  const receipt={...previous,state:'pending',repository:WEBSITE,path:DESTINATION,releasePage:pageId,sourceCommit:source.sourceCommit,shippedCommit:m.commit,sectionHash:source.sectionHash,sourceHash:source.sourceHash,manifestHash:source.originalHash,version:m.version};
  if(config.dryRun)return {...receipt,state:'preview',contentChanged:content!==before};
  if(content!==before||!receipt.commit) {
    // Website main requires squash-merged pull requests: one bot-owned branch and PR per exact release identity.
    const branch=`release-notes/android/${m.version}-${m.build}`,trailers=`Release-Source-Repository: ${m.repository}\nRelease-Source-Commit: ${source.sourceCommit}\nRelease-Source-Path: CHANGELOG.md\nRelease-Shipped-Commit: ${m.commit}\nRelease-Version-Code: ${m.build}\nRelease-Notes-Hash: ${source.sectionHash}\nRelease-Ledger-Page: ${pageId}\nRelease-Manifest-Hash: ${source.originalHash}`;
    const title=`Update changelog for ${m.version}`,pr=await releasePr(api,branch,receipt.pullRequest);
    if(pr?.merged_at) {
      // Recover a merge whose response or Notion receipt was lost; validate what actually landed.
      if(content!==before)return finish({...receipt,pullRequest:pr.number,state:'held',reason:'Merged website notes are no longer on main; review a correction'});
      if(!await mergedNotes(api,pr.merge_commit_sha,pageId,source,m.version))return finish({...receipt,pullRequest:pr.number,state:'held',reason:'Merged website notes lack the expected source receipt; review their provenance'});
      Object.assign(receipt,{pullRequest:pr.number,commit:pr.merge_commit_sha});
    } else if(pr?.state==='closed') {
      return finish({...receipt,pullRequest:pr.number,state:'held',reason:'Website notes pull request was closed without merging; review before republishing'});
    } else if(content!==before) {
      const head=await prepareBranch(api,branch,content,`${title}\n\n${trailers}`);
      const opened=pr||await openPr(api,branch,title,m,source);
      receipt.pullRequest=opened.number;
      await publicationReceipt(row,api,receipt);
      // The exact title and trailers keep the squash commit recognisable as a verified release sync.
      const merged=await api.gh(`/repos/${WEBSITE}/pulls/${opened.number}/merge`,'PUT',{merge_method:'squash',commit_title:title,commit_message:trailers,sha:head});
      if(!merged.merged||!/^[a-f0-9]{40}$/.test(merged.sha))throw Error('Website notes pull request did not merge');
      receipt.commit=merged.sha;
    } else {
      if(pr)return finish({...receipt,pullRequest:pr.number,state:'held',reason:'Website main already contains these notes outside their pull request; review their provenance'});
      // Recover notes committed before PR publication, or merged by normal review with the source trailers.
      const commits=await api.gh(`/repos/${WEBSITE}/commits?path=${encodeURIComponent(DESTINATION)}&per_page=100`);
      const match=commits.find(c=>c.commit?.message?.includes(`Release-Ledger-Page: ${pageId}`)&&c.commit.message.includes(`Release-Notes-Hash: ${source.sectionHash}`));
      if(!match)return finish({...receipt,state:'held',reason:'Existing notes lack the expected source receipt; review their provenance'});
      receipt.commit=match.sha;
    }
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
        deployed=comparison.status==='ahead'&&deployedFile.encoding==='base64'&&sectionMap(decode(deployedFile)).get(m.version.replace(/^v/,''))===source.section.trim();
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
