// Operator recovery: preview or generate an evidence-backed supplement; never replace shipped facts.
const {clients,allPages,withLock,hash,text,rich}=require('./record');
const {buildChangelogManifest}=require('./changelog');
async function amend(config,api,build=buildChangelogManifest){
  const row=await api.notion(`/pages/${config.pageId}`);
  if((row.parent?.data_source_id||'').replace(/-/g,'')!==config.releasesId.replace(/-/g,''))throw new Error('Page is outside Releases');
  const original=JSON.parse(text(row.properties.Manifest));
  if(hash(original)!==text(row.properties['Manifest Hash'])||original.repository!==config.repo||original.schemaVersion!==2)throw new Error('Select a valid changelog release in the checked-out repository');
  const ledger=JSON.parse(text(row.properties.Announcements)||'{"version":1,"batches":[]}');
  if(ledger.version!==1||!Array.isArray(ledger.batches)||ledger.batches.some(b=>b.state!=='Sent'||b.correction))throw new Error('Reconcile any outstanding Slack attempts before supplementing notes');
  const candidate=await build({...config,target:original.target,product:original.product,version:original.version,build:original.build,commit:original.commit,event:original.event,source:original.source},api.gh,original.baseline,api.notion);
  const source=ledger.source?.manifest||original;
  for(const id of new Set(ledger.batches.flatMap(b=>b.ids))) {
    const prior=source.changes.find(c=>c.id===id),next=candidate.changes.find(c=>c.id===id);
    const display=c=>c&&Object.fromEntries(['id','summary','heading','kind','workItems','flagKeys','limitations','sourcePrs'].map(k=>[k,c[k]]));
    if(!prior||!next||hash(display(prior))!==hash(display(next)))throw new Error('A supplement cannot rewrite announced entries. Queue a correction to that message instead.');
    candidate.changes[candidate.changes.indexOf(next)]=prior;
  }
  // Preserve the display of announced Work Items without freezing stale delivery contracts.
  const announcedItems=new Set(source.changes.filter(c=>ledger.batches.some(b=>b.ids.includes(c.id))).flatMap(c=>c.workItems));
  candidate.workItemSnapshots=candidate.workItemSnapshots.map(w=>{
    const old=source.workItemSnapshots.find(old=>old.id===w.id);
    return old&&announcedItems.has(w.id)?{...w,title:old.title,description:old.description,url:old.url}:w;
  });
  ledger.source={manifest:candidate,digest:hash(candidate),evidence:candidate.wordingSource?.url||`https://github.com/${original.repository}/commit/${original.commit}`};
  const preview={pageId:row.id,dryRun:config.dryRun!==false,source:ledger.source.evidence,manifestHash:ledger.source.digest,changes:candidate.changes.map(c=>({id:c.id,summary:c.summary,workItems:c.workItems,approved:c.approved,reasons:c.blocked})),issues:candidate.issues};
  if(config.dryRun!==false)return preview;
  const current=await api.notion(`/pages/${row.id}`);
  if(text(current.properties.Manifest)!==text(row.properties.Manifest)||text(current.properties.Announcements)!==text(row.properties.Announcements))throw new Error('Release changed during note preparation; inspect before retrying');
  await api.notion(`/pages/${row.id}`,'PATCH',{properties:{Announcements:rich(JSON.stringify(ledger))}});
  return preview;
}
async function main(){
  const config={repo:process.env.RELEASE_REPOSITORY,pageId:process.env.RELEASE_PAGE_ID,wordingPr:Number(process.env.RELEASE_WORDING_PR)||undefined,dryRun:process.env.RELEASE_DRY_RUN!=='false',releasesId:process.env.RELEASES_DATA_SOURCE_ID||'8beb58ea-dd4f-4777-8799-b6694ade6317',notionToken:process.env.NOTION_TOKEN,githubToken:process.env.GITHUB_TOKEN};
  if(!config.repo||!config.pageId||(config.wordingPr!==undefined&&(!Number.isSafeInteger(config.wordingPr)||config.wordingPr<1))||!config.notionToken||!config.githubToken)throw new Error('Repository, release page, optional positive wording PR and credentials are required');
  const api=clients(config),run=()=>amend(config,api);
  console.log(JSON.stringify(await (config.dryRun?run():withLock(api.gh,'VeamStudios/.github',run))));
}
module.exports={amend};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
