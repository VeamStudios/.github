// Operator recovery: preview or generate an evidence-backed supplement; never replace shipped facts.
const {clients,allPages,hash,text,rich}=require('./record');
const {buildChangelogManifest}=require('./changelog');
const {ANNOUNCEMENT_SOURCE,reviewedSource}=require('./ledger-columns');
async function amend(config,api,build=buildChangelogManifest){
  const row=await api.notion(`/pages/${config.pageId}`);
  if((row.parent?.data_source_id||'').replace(/-/g,'')!==config.releasesId.replace(/-/g,''))throw new Error('Page is outside Releases');
  const original=JSON.parse(text(row.properties.Manifest));
  if(hash(original)!==text(row.properties['Manifest Hash'])||original.repository!==config.repo||original.schemaVersion!==2)throw new Error('Select a valid changelog release in the checked-out repository');
  const ledger=JSON.parse(text(row.properties.Announcements)||'{"version":1,"batches":[]}');
  if(ledger.version!==1||!Array.isArray(ledger.batches)||ledger.batches.some(b=>b.state!=='Sent'||b.correction))throw new Error('Reconcile any outstanding Slack attempts before supplementing notes');
  const candidate=config.initialSnapshot?await require('./initial-snapshot').initialSnapshot(config,original,api.gh):await build({...config,target:original.target,product:original.product,version:original.version,build:original.build,commit:original.commit,event:original.event,source:original.source},api.gh,original.baseline,api.notion);
  ledger.source=reviewedSource(row.properties);
  const source=ledger.source?.manifest||original;
  // Announced entries keep their wording. Their provenance may only gain information, for example
  // when a later recheck resolves PRs; a rebuild that lost it (GitHub outage, unconfirmed PR) keeps what was posted.
  const announced=new Set(ledger.batches.flatMap(b=>b.ids));
  for(const id of announced) {
    const prior=source.changes.find(c=>c.id===id),next=candidate.changes.find(c=>c.id===id);
    const wording=c=>c&&Object.fromEntries(['id','summary','heading','kind','limitations'].map(k=>[k,c[k]]));
    if(!prior||!next||hash(wording(prior))!==hash(wording(next)))throw new Error('A supplement cannot rewrite announced entries. Queue a correction to that message instead.');
    const gains=(prior.sourcePrs||[]).every(n=>(next.sourcePrs||[]).includes(n))&&(next.approved||!prior.approved);
    if(!gains)for(const k of ['pr','noteHash','approved','reviewEvidence','sourcePrs'])next[k]=prior[k];
  }
  // Announced Work Items keep their displayed snapshot, even when the rebuild could not fetch it.
  const announcedItems=new Set(source.changes.filter(c=>announced.has(c.id)).flatMap(c=>c.workItems));
  const kept=source.workItemSnapshots.filter(w=>announcedItems.has(w.id));
  candidate.workItemSnapshots=[
    ...candidate.workItemSnapshots.map(w=>{const old=kept.find(old=>old.id===w.id);return old?{...w,title:old.title,description:old.description,url:old.url}:w}),
    ...kept.filter(old=>!candidate.workItemSnapshots.some(w=>w.id===old.id))
  ];
  ledger.source={manifest:candidate,digest:hash(candidate),evidence:candidate.wordingSource?.url||`https://github.com/${original.repository}/commit/${original.commit}`};
  const preview={pageId:row.id,dryRun:config.dryRun!==false,source:ledger.source.evidence,wordingSource:candidate.wordingSource||null,originalManifestHash:hash(original),manifestHash:ledger.source.digest,changes:candidate.changes.map(c=>({id:c.id,summary:c.summary,workItems:c.workItems,approved:c.approved})),issues:candidate.issues};
  if(config.dryRun!==false)return preview;
  const current=await api.notion(`/pages/${row.id}`);
  if(text(current.properties['Manifest Hash'])!==text(row.properties['Manifest Hash'])||text(current.properties.Manifest)!==text(row.properties.Manifest)||text(current.properties.Announcements)!==text(row.properties.Announcements))throw new Error('Release changed during note preparation; inspect before retrying');
  // Announcements is the Notion worker's receipt ledger; the supplement has its own column.
  await api.notion(`/pages/${row.id}`,'PATCH',{properties:{[ANNOUNCEMENT_SOURCE]:rich(JSON.stringify(ledger.source))}});
  return preview;
}
async function main(){
  const config={repo:process.env.RELEASE_REPOSITORY,pageId:process.env.RELEASE_PAGE_ID,wordingPr:Number(process.env.RELEASE_WORDING_PR)||undefined,initialSnapshot:process.env.RELEASE_INITIAL_SNAPSHOT==='true',expectedHash:process.env.RELEASE_EXPECTED_HASH||'',dryRun:process.env.RELEASE_DRY_RUN!=='false',releasesId:process.env.RELEASES_DATA_SOURCE_ID||'8beb58ea-dd4f-4777-8799-b6694ade6317',notionToken:process.env.NOTION_TOKEN,githubToken:process.env.GITHUB_TOKEN};
  if(!config.repo||!config.pageId||(config.wordingPr!==undefined&&(!Number.isSafeInteger(config.wordingPr)||config.wordingPr<1))||!config.notionToken||!config.githubToken)throw new Error('Repository, release page, optional positive wording PR and credentials are required');
  const api=clients(config),run=()=>amend(config,api);
  console.log(JSON.stringify(await run()));
}
module.exports={amend};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
