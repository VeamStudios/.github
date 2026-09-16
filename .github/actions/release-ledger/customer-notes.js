const {parseChangelog,renderChangelog}=require('./changelog');
const clean = summary => summary.replace(/<!--[^]*?-->/g,'').replace(/\s*\[[^\]]*\]\(https:\/\/(?:www\.)?(?:notion\.so|app\.notion\.com|github\.com)\/[^)]*\)/g,'').replace(/https:\/\/(?:www\.)?(?:notion\.so|app\.notion\.com|github\.com)\/\S+/g,'').replace(/\n(?:Work Items?|PR|source|internal):[^\n]*/gi,'').trim();
function customerEntries(raw,version) {
  const normalized=version.replace(/^v/,'');
  if(!/^\d+\.\d+\.\d+$/.test(normalized))throw Error('An exact marketing version is required');
  const headings=String(raw).match(new RegExp(`^## v?${normalized.replaceAll('.','\\.')}\\s*$`,'gm'))||[];
  if(headings.length!==1)throw Error(`Expected one CHANGELOG.md section for ${normalized}`);
  const entries=parseChangelog(raw.replace(/<!--[^]*?-->/g,'')).filter(e=>e.version===normalized&&['New','Changed','Fixed'].includes(e.heading)).map(e=>({...e,summary:clean(e.summary)})).filter(e=>e.summary);
  if(!entries.length)throw Error(`No customer notes for ${normalized}`);
  return entries;
}
function customerSection(raw,version) {return `## ${version.replace(/^v/,'')}\n\n${renderChangelog(customerEntries(raw,version))}\n`;}
function websiteSection(raw,version) {
  const entries=customerEntries(raw,version).map(e=>({...e,summary:e.summary.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*_`~]/g,'').replace(/<[^>]+>/g,'')}));
  return `## ${version.replace(/^v/,'')}\n\n${renderChangelog(entries)}\n`;
}
module.exports={customerEntries,customerSection,websiteSection,clean};
