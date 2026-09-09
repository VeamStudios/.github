// Operator recovery: generate a reviewed supplement; never replace shipped facts.
const {clients,allPages,withLock,hash,text,rich}=require('./record');
const {buildChangelogManifest}=require('./changelog');
async function amend(config,api){
  const row=await api.notion(`/pages/${config.pageId}`);
  if((row.parent?.data_source_id||'').replace(/-/g,'')!==config.releasesId.replace(/-/g,''))throw new Error('Page is outside Releases');
  const original=JSON.parse(text(row.properties.Manifest));
  if(hash(original)!==text(row.properties['Manifest Hash'])||original.repository!==config.repo||original.schemaVersion!==2)throw new Error('Select a valid changelog release in the checked-out repository');
  const ledger=JSON.parse(text(row.properties.Announcements)||'{"version":1,"batches":[]}');
  if(ledger.version!==1||!Array.isArray(ledger.batches)||ledger.batches.some(b=>b.state!=='Sent'||b.correction))throw new Error('Reconcile any outstanding Slack attempts before supplementing notes');
  const candidate=await buildChangelogManifest({...config,target:original.target,product:original.product,version:original.version,build:original.build,commit:original.commit,event:original.event,source:original.source},api.gh,original.baseline,api.notion);
  const source=ledger.source?.manifest||original;
  for(const id of new Set(ledger.batches.flatMap(b=>b.ids))) {
    const prior=source.changes.find(c=>c.id===id),next=candidate.changes.find(c=>c.id===id);
    const display=c=>c&&Object.fromEntries(['id','summary','heading','kind','workItems','flagKeys','limitations','sourcePrs'].map(k=>[k,c[k]]));
    if(!prior||!next||hash(display(prior))!==hash(display(next)))throw new Error('A supplement cannot rewrite announced entries. Queue a correction to that message instead.');
    candidate.changes[candidate.changes.indexOf(next)]=prior;
  }
  // Descriptions already captured remain stable even if a Work Item was edited.
  candidate.workItemSnapshots=candidate.workItemSnapshots.map(w=>source.workItemSnapshots.find(old=>old.id===w.id)||w);
  ledger.source={manifest:candidate,digest:hash(candidate),evidence:candidate.wordingSource.url};
  const current=await api.notion(`/pages/${row.id}`);
  if(text(current.properties.Manifest)!==text(row.properties.Manifest)||text(current.properties.Announcements)!==text(row.properties.Announcements))throw new Error('Release changed during note preparation; inspect before retrying');
  await api.notion(`/pages/${row.id}`,'PATCH',{properties:{Announcements:rich(JSON.stringify(ledger))}});
  return {pageId:row.id,source:ledger.source.evidence,changes:candidate.changes.length,waiting:candidate.changes.filter(c=>c.blocked.length).map(c=>({summary:c.summary,reasons:c.blocked}))};
}
async function main(){const config={repo:process.env.RELEASE_REPOSITORY,pageId:process.env.RELEASE_PAGE_ID,wordingPr:Number(process.env.RELEASE_WORDING_PR),releasesId:process.env.RELEASES_DATA_SOURCE_ID||'8beb58ea-dd4f-4777-8799-b6694ade6317',notionToken:process.env.NOTION_TOKEN,githubToken:process.env.GITHUB_TOKEN};if(!config.repo||!config.pageId||!Number.isSafeInteger(config.wordingPr)||config.wordingPr<1||!config.notionToken||!config.githubToken)throw new Error('Repository, release page, reviewed wording PR and credentials are required');const api=clients(config);console.log(JSON.stringify(await withLock(api.gh,'VeamStudios/.github',()=>amend(config,api))))}
module.exports={amend};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
