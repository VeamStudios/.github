const {clients,withLock,text}=require('./record');
const {publishWebsite,DESTINATION,WEBSITE}=require('./play-website');
async function main() {
  const e=process.env;
  if(!e.VERIFY_ONLY && (!e.RELEASE_PAGE_ID||e.SOURCE_FILE!=='CHANGELOG.md'||e.DESTINATION_REPO!==WEBSITE||`${e.DESTINATION_FOLDER}/${e.DESTINATION_FILE}`!==DESTINATION))throw Error('Android sync requires its verified release_page and explicit android/changelog.md destination');
  const api=clients({githubToken:e.GITHUB_TOKEN,notionToken:e.NOTION_TOKEN});
  await withLock(api.gh,'VeamStudios/.github',async()=>{
    const row=await api.notion(`/pages/${e.RELEASE_PAGE_ID}`),m=JSON.parse(text(row.properties.Manifest));
    if(!e.VERIFY_ONLY && (m.commit!==e.SOURCE_COMMIT||m.version!==e.RELEASE_VERSION))throw Error('Requested sync identity differs from the frozen shipped release');
    const result=await publishWebsite(row.id,{dryRun:false,publishWebsite:true,verifyOnly:e.VERIFY_ONLY==='true'},api);
    console.log(JSON.stringify(result));
    if(['held','failed'].includes(result.state)||(e.VERIFY_ONLY==='true'&&result.state!=='published'))throw Error(result.reason||'Website publication is not verified');
  });
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
