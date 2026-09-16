const {git,hash,reviewed}=require('./record');
const {customerEntries,customerSection}=require('./customer-notes');
const {renderChangelog}=require('./changelog');
const IDENTITY={repository:'VeamStudios/SiteAuditPro-AndroidNew',target:'android-consumer',version:'v4.0.0',build:'211481388',commit:'da63fae9f5f9978bb3f4eadba3e39ed8cb593f06',baseline:''};
const ASSET='app/src/main/assets/RELEASE_NOTES.md';
async function initialSnapshot(config,original,gh,read=git) {
  if(Object.entries(IDENTITY).some(([k,v])=>original[k]!==v)||original.provenanceComplete||original.changes.length||original.prs.length)throw Error('Initial snapshot only supplements the frozen Android 4.0.0 record; no historical baseline is inferred');
  if(!config.expectedHash||config.expectedHash!==hash(original))throw Error('Preview the exact frozen manifest hash before initial-snapshot recovery');
  if(!Number.isSafeInteger(config.wordingPr)||config.wordingPr<1)throw Error('Initial snapshot requires the reviewed migration PR');
  const pr=await gh(`/repos/${original.repository}/pulls/${config.wordingPr}`);
  if(!pr.merged_at||pr.base?.repo?.full_name!==original.repository||!await reviewed(gh,original.repository,pr))throw Error('Migration PR needs merged current-head human review');
  const file=await gh(`/repos/${original.repository}/contents/CHANGELOG.md?ref=${pr.merge_commit_sha}`);
  if(file.encoding!=='base64')throw Error('Reviewed migration changelog is unavailable');
  const raw=Buffer.from(file.content,'base64').toString('utf8');
  const shipped=read('show',`${original.commit}:${ASSET}`).replace("# What's New in 4.0.0",'## 4.0.0').replace(/^#### /gm,'### ');
  const section=customerSection(raw,original.version);
  if(section!==customerSection(shipped,original.version))throw Error('Migration notes differ from the exact shipped 4.0.0 asset');
  const entries=customerEntries(raw,original.version);
  const changes=entries.map(e=>{
    const id=hash({repository:original.repository,commit:original.commit,heading:e.heading,summary:e.summary});
    return {id,kind:e.heading==='Fixed'?'fix':'feature',summary:e.summary,heading:e.heading,sourceVersion:'4.0.0',audience:'Site Audit Pro consumer Android users',limitations:'',scope:`initial-snapshot-${id.slice(0,24)}`,targets:[original.target],audienceGate:true,requiredReleaseKeys:[],workItems:[],pr:0,noteHash:hash(e.summary),approved:true,reviewEvidence:pr.html_url,blocked:['Initial shipped snapshot: historical feature and PR provenance is unverified.'],flagKeys:[],gateKeys:[],sourcePrs:[]};
  });
  return {...original,changes,workItemSnapshots:[],completeChangelog:renderChangelog(changes),issues:['Reviewed initial shipped snapshot; previous baseline and historical feature delivery remain unverified.'],provenanceComplete:false,initialSnapshot:{kind:'android-4.0.0',originalHash:hash(original),asset:ASSET,assetHash:hash(shipped),sourceCommit:pr.merge_commit_sha,sourcePath:'CHANGELOG.md',sourceHash:hash(raw),sectionHash:hash(section),reviewPr:pr.number,evidence:pr.html_url},wordingSource:{pr:pr.number,commit:pr.merge_commit_sha,url:pr.html_url}};
}
module.exports={initialSnapshot,IDENTITY};
