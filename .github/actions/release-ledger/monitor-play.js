const fs=require('node:fs');
const {clients,allPages,withLock,record,git,text,rich,hash}=require('./record');
const {GooglePlayMonitor,snapshotBuilds,observePlay,resolveBuild,REPOSITORY}=require('./google-play');

async function optional(gh,path) {try{return await gh(path)}catch(e){if(e.status===404)return null;throw e}}
async function tagCommit(gh,repo,tag) {
  const ref=await optional(gh,`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if(!ref)return null;
  let object=ref.object;
  for(let n=0;object?.type==='tag'&&n<5;n++)object=(await gh(`/repos/${repo}/git/tags/${object.sha}`)).object;
  if(object?.type!=='commit'||!/^[a-f0-9]{40}$/.test(object.sha))throw Error('Production tag is not an unambiguous commit');
  return object.sha;
}
async function ensureRelease(identity,gh,dryRun) {
  const sha=await tagCommit(gh,identity.repository,identity.version);
  if(sha && sha!==identity.commit)throw Error('Marketing version already belongs to a different commit; use a new version');
  const path=`/repos/${identity.repository}/releases/tags/${encodeURIComponent(identity.version)}`;
  const release=await optional(gh,path);
  if(release) {
    if(!sha || release.draft || release.prerelease || release.tag_name!==identity.version || !new RegExp(`\\*\\*versionCode:\\*\\*\\s*${identity.build}(?:\\s|$)`).test(release.body||''))throw Error('Existing GitHub release conflicts with this exact production build');
    return {state:'complete',url:release.html_url};
  }
  if(dryRun)return {state:'planned',tag:identity.version,commit:identity.commit};
  if(!sha) {
    try {await gh(`/repos/${identity.repository}/git/refs`,'POST',{ref:`refs/tags/${identity.version}`,sha:identity.commit})}
    catch(e){if(await tagCommit(gh,identity.repository,identity.version)!==identity.commit)throw e}
  }
  const body=`**Shipped from:** \`${identity.internalTag}\`\n**versionCode:** ${identity.build}\n\nVerified published and completed on Google Play production. Customer release notes are maintained in the release ledger.`;
  try {
    const created=await gh(`/repos/${identity.repository}/releases`,'POST',{tag_name:identity.version,target_commitish:identity.commit,name:identity.version,body,draft:false,prerelease:false});
    return {state:'complete',url:created.html_url};
  }catch(e){const found=await optional(gh,path);if(!found)throw e;return ensureRelease(identity,gh,true)}
}

async function monitor(config,api,play,{resolve=(build)=>resolveBuild(build,git('tag','-l','internal/*').split('\n'),tag=>git('rev-parse',`refs/tags/${tag}^{commit}`)),recorder=record,publish=async()=>({state:'disabled'})}={}) {
  if(config.repo!==REPOSITORY)throw Error('Consumer Site Audit Pro Android is the only enabled Play monitor');
  const rows=await allPages(api.notion,`/data_sources/${config.releasesId}/query`,{filter:{property:'Repository',rich_text:{equals:config.repo}}});
  const result={dryRun:config.dryRun,observations:[],errors:[]};
  let snapshot;
  const invalidate=async(row,message)=>{
    if(config.dryRun)return;
    const previous=JSON.parse(text(row.properties.Observation)||'{}');
    await api.notion(`/pages/${row.id}`,'PATCH',{properties:{Observation:rich(JSON.stringify({...previous,verification:null,verificationError:message,verificationAttempt:{at:new Date().toISOString(),source:config.source}})),Error:rich(message)}});
  };
  try {snapshot=await play.snapshot();snapshotBuilds(snapshot)}
  catch(e){for(const row of rows) {const m=JSON.parse(text(row.properties.Manifest)||'{}');if(m.target==='android-consumer'&&m.build)await invalidate(row,e.message)}throw e}
  let builds=snapshotBuilds(snapshot);
  if(config.build){if(!builds.includes(config.build)){for(const row of rows){const m=JSON.parse(text(row.properties.Manifest)||'{}');if(m.build===config.build&&m.target==='android-consumer')await invalidate(row,'Requested build is absent from production lifecycle evidence')}throw Error('Requested build is absent from production lifecycle evidence')};builds=[config.build]}
  // Every returned active build is considered; never choose a maximum versionCode.
  for(const build of builds) {
    const matching=rows.filter(row=>{const m=JSON.parse(text(row.properties.Manifest)||'{}');return m.target==='android-consumer'&&m.build===build});
    try {
      const identity=resolve(build),observation=observePlay(identity,snapshot);
      const sameVersion=rows.filter(row=>{const m=JSON.parse(text(row.properties.Manifest)||'{}');return m.target===identity.target&&m.version===identity.version});
      if(sameVersion.length>1||matching.length>1)throw Error('Duplicate release identities require reconciliation');
      for(const row of sameVersion) {const m=JSON.parse(text(row.properties.Manifest));if(hash(m)!==text(row.properties['Manifest Hash'])||m.commit!==identity.commit||m.build!==identity.build)throw Error('Version already bound to another commit/build or frozen manifest changed')}
      // Validate existing GitHub identities before any recording or publication.
      const sha=await tagCommit(api.gh,identity.repository,identity.version);
      if(sha&&sha!==identity.commit)throw Error('Production tag conflicts with the exact internal build');
      await ensureRelease(identity,api.gh,true);
      const prior=sameVersion[0]&&JSON.parse(text(sameVersion[0].properties.Observation)||'{}');
      // Preserve first-observed release time; hourly checks are not new releases.
      if(prior?.phase===observation.phase&&prior.releasedAt)observation.releasedAt=prior.releasedAt;
      const recorded=await recorder({...config,...identity,repo:identity.repository,product:'Site Audit Pro',event:'release',...observation},api);
      const entry={...identity,phase:observation.phase,recording:config.dryRun?'preview':'complete',pageId:recorded.pageId||sameVersion[0]?.id};
      if(observation.phase==='live') {
        entry.github=await ensureRelease(identity,api.gh,config.dryRun);
        if(entry.pageId) {
          try {entry.website=await publish(entry.pageId,config,api)}
          catch(e) {
            entry.website={state:'failed',reason:e.message};
            result.errors.push({build,stage:'website',error:e.message});
            // A website outage does not invalidate verified Play availability or Slack receipts.
            if(!config.dryRun){const row=await api.notion(`/pages/${entry.pageId}`);const previous=JSON.parse(text(row.properties.Observation)||'{}');await require('./play-website').publicationReceipt(row,api,{...previous.website,...entry.website})}
          }
        }
        else entry.website={state:'waiting',reason:'Record the verified release before publishing notes'};
      }
      result.observations.push(entry);
    } catch(e) {for(const row of matching)await invalidate(row,e.message);result.errors.push({build,error:e.message})}
  }
  return result;
}
async function main() {
  const config={repo:process.env.GITHUB_REPOSITORY,releasesId:process.env.INPUT_RELEASES_ID||'8beb58ea-dd4f-4777-8799-b6694ade6317',githubToken:process.env.INPUT_GITHUB_TOKEN,notionToken:process.env.INPUT_NOTION_TOKEN,dryRun:process.env.INPUT_DRY_RUN!=='false',publishWebsite:process.env.INPUT_PUBLISH_WEBSITE==='true',retryWebsite:process.env.INPUT_RETRY_WEBSITE==='true',build:process.env.INPUT_VERSION_CODE||'',source:`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`};
  if(!config.githubToken||!config.notionToken)throw Error('Configure release-bot and Notion credentials before monitoring');
  let credentials;try{credentials=JSON.parse(process.env.PLAY_MONITOR_SERVICE_ACCOUNT_JSON||'')}catch{throw Error('Configure PLAY_MONITOR_SERVICE_ACCOUNT_JSON with the dedicated Play monitor account')}
  const play=new GooglePlayMonitor(credentials,{expectedEmail:process.env.PLAY_MONITOR_SERVICE_ACCOUNT_EMAIL,uploaderEmail:process.env.PLAY_UPLOADER_SERVICE_ACCOUNT_EMAIL});
  const api=clients(config),run=()=>monitor(config,api,play,{publish:require('./play-website').publishWebsite});
  const result=await (config.dryRun?run():withLock(api.gh,'VeamStudios/.github',run));
  fs.writeFileSync('play-observation.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  if(result.errors.length)throw Error('One or more Android releases require attention; failed identities were not published');
}
module.exports={monitor,tagCommit,ensureRelease};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
