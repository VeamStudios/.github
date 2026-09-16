const {clients,git,text,hash,allPages,deployedBaseline}=require('./record');
const {verifiedSync}=require('./website-changelog');
const {sourceNotes,WEBSITE,URL}=require('./play-website');
async function guard(config,api,{read=git,fetcher=fetch,verify=verifiedSync}={}) {
  const head=read('rev-parse','HEAD');
  if(config.repository!==WEBSITE||head!==config.expectedCommit||!/^[a-f0-9]{40}$/.test(head))throw Error('Website checkout differs from the requested exact revision');
  const response=await fetcher(`${URL}/release-info.json?revision=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Cannot verify the previous production website marker');
  const marker=await response.json();
  if(marker.repository!==WEBSITE||!/^[a-f0-9]{40}$/.test(marker.commit))throw Error('Invalid production website baseline');
  try{read('merge-base','--is-ancestor',marker.commit,head)}catch{throw Error('Production marker is not an ancestor; normal website release handling is required')}
  const commits=read('rev-list','--reverse',`${marker.commit}..${head}`).split('\n').filter(Boolean);
  if(!commits.length)return {alreadyDeployed:true,commit:head};
  for(const commit of commits) {
    const source=await verify(WEBSITE,commit,api.gh,read);
    if(!source)throw Error(`Website has unrelated or unapproved pending changes at ${commit}; use normal release handling`);
    if(source.repository!=='VeamStudios/SiteAuditPro-AndroidNew') {
      const rows=await allPages(api.notion,'/data_sources/8beb58ea-dd4f-4777-8799-b6694ade6317/query',{filter:{and:[{property:'Repository',rich_text:{equals:source.repository}},{property:'Commit',rich_text:{equals:source.sourceCommit}}]}});
      const verified=rows.filter(row=>{
        if(!deployedBaseline(row))return false;
        const m=JSON.parse(text(row.properties.Manifest));
        return m.version.replace(/^v/,'')===source.version.replace(/^v/,'')&&m.provenanceComplete&&m.changes.length&&m.changes.filter(c=>c.kind!=='internal').every(c=>c.approved&&c.reviewEvidence);
      });
      if(verified.length!==1)throw Error('Pending website notes lack unambiguous reviewed production release evidence');
    }
    // Android evidence must still be fully live and the generated content reviewed.
    if(source.repository==='VeamStudios/SiteAuditPro-AndroidNew') {
      const message=read('show','-s','--format=%B',commit),page=message.match(/^Release-Ledger-Page: ([a-f0-9-]+)$/m)?.[1];
      if(!page)throw Error('Android sync lacks an exact ledger reference');
      const row=await api.notion(`/pages/${page}`),notes=await sourceNotes(row,api);
      if(!message.includes(`Release-Manifest-Hash: ${notes.originalHash}`)||!message.includes(`Release-Notes-Hash: ${notes.sectionHash}`)||source.sourceCommit!==notes.sourceCommit)throw Error('Website provenance differs from its verified release record');
    }
  }
  const row=await api.notion(`/pages/${config.releasePage}`),notes=await sourceNotes(row,api);
  if(notes.observation.website?.commit!==head)throw Error('Website revision is not the recorded publication attempt');
  return {alreadyDeployed:false,commit:head,baseline:marker.commit,releasePage:row.id,sectionHash:notes.sectionHash};
}
async function main() {
  const config={repository:process.env.GITHUB_REPOSITORY,expectedCommit:process.env.EXPECTED_COMMIT,releasePage:process.env.RELEASE_PAGE_ID};
  const api=clients({githubToken:process.env.GITHUB_TOKEN,notionToken:process.env.NOTION_TOKEN});
  console.log(JSON.stringify(await guard(config,api)));
}
module.exports={guard};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
