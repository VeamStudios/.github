const fs = require('node:fs');
const { clients, withLock, workItems, rich, text, select } = require('./record');

const normalize = id => String(id || '').replace(/-/g, '').toLowerCase();
const SAP = '30c069083a0380d09845fe97daa54c31';
const CIP = '30c069083a038088bfc4f9a47469e4a6';
// Backend, Console, websites and packages cannot complete a client platform.
const REPOSITORIES = {
  'VeamStudios/SiteAuditPro-Web': { platform: 'Web', product: SAP },
  'VeamStudios/ChecklistInspectorPro-Web': { platform: 'Web', product: CIP },
  'VeamStudios/SiteAuditPro-iOS': { platform: 'iOS', product: SAP },
  'VeamStudios/ChecklistInspectorPro-iOS': { platform: 'iOS', product: CIP },
  'VeamStudios/SiteAuditPro-AndroidNew': { platform: 'Android', product: SAP },
};
async function completeDevelopment(config, api) {
  if (config.mode === 'off') return { skipped: 'off', changes: [] };
  if (!['shadow', 'live'].includes(config.mode)) throw new Error('Invalid release ledger mode');
  if (config.mode === 'live' && config.lifecycleWrites !== true) throw new Error('Live Work Item evidence recording requires lifecycle writes; use shadow explicitly for a read-only preview.');
  const mapping = REPOSITORIES[config.repo];
  if (!mapping) throw new Error('Repository has no client platform mapping');
  if (!Number.isSafeInteger(config.number) || config.number < 1) throw new Error('Invalid PR number');
  const pr = await api.gh(`/repos/${config.repo}/pulls/${config.number}`);
  if (!pr.merged || !pr.merged_at || pr.base?.ref !== 'main' || pr.base?.repo?.full_name !== config.repo) return { skipped: 'PR is not merged into main', changes: [] };
  if (!/^[a-f0-9]{40}$/.test(pr.merge_commit_sha) || !/^[a-f0-9]{40}$/.test(pr.head?.sha) || !Number.isFinite(Date.parse(pr.merged_at))) throw new Error('Merged PR lacks exact commit evidence');
  const ids = workItems(pr.body);
  if (!ids.length) return { skipped: 'No Work Items links', changes: [] };
  const changes = [], skipped = [];
  for (const id of ids) {
    const row = await api.notion(`/pages/${id}`);
    if (normalize(row.parent?.data_source_id) !== normalize(config.workItemsId)) throw new Error('Linked page is outside Work Items');
    if (row.archived || row.in_trash) { skipped.push({ id, reason: 'Work Item is archived' }); continue; }
    const props = row.properties;
    // Operational projects span products and do not complete a client platform.
    if (props.Type?.select?.name === 'Product Ops') { skipped.push({ id, reason: 'Product Ops has no customer platform completion' }); continue; }
    const products = props.Product?.relation || [];
    if (props.Product?.has_more || products.length !== 1 || normalize(products[0].id) !== mapping.product) throw new Error('Work Item product does not match repository');
    if (['Rejected', 'Deferred', 'Duplicate'].includes(props['Work Item Status']?.status?.name)) { skipped.push({ id, reason: 'Work Item is inactive' }); continue; }
    const property = `${mapping.platform} Dev Status`;
    const current = props[property]?.select?.name;
    if (!['Not Started', 'Prototyping', 'In Development', 'Done', 'Released'].includes(current)) { skipped.push({id,reason:`Set the applicable ${property} on the Work Item`});continue; }
    if (!props['Platform Development'] || !Array.isArray(props['Platform Development'].rich_text)) throw new Error('Add the Platform Development rich-text property before enabling this workflow');
    const evidence = JSON.parse(text(props['Platform Development']) || '{}');
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('Invalid Platform Development evidence');
    const previous = evidence[mapping.platform];
    if (previous && (!Number.isFinite(Date.parse(previous.mergedAt)) || previous.repository !== config.repo)) throw new Error('Invalid existing platform completion evidence');
    const same = previous?.pr === pr.number;
    if (previous && (!same && Date.parse(previous.mergedAt) >= Date.parse(pr.merged_at) || same && previous.doneOnMerge === true)) { skipped.push({ id, reason: 'Completion already recorded or superseded' }); continue; }
    if (same && (previous.head !== pr.head.sha || previous.mergeCommit !== pr.merge_commit_sha)) throw new Error('Existing completion does not match the merged PR');
    // Migrate evidence-only records once. Subsequent retries cannot finish a new development cycle.
    const to = same && current === 'Released' ? 'Released' : 'Done';
    evidence[mapping.platform] = { repository: config.repo, pr: pr.number, head: pr.head.sha, mergeCommit: pr.merge_commit_sha, mergedAt: pr.merged_at, source: pr.html_url, scope: same ? previous.scope || '' : '', targets: same ? previous.targets || [] : [], doneOnMerge: true };
    const properties = { 'Platform Development': rich(JSON.stringify(evidence)), [property]: select(to) };
    const written = config.mode === 'live' && config.lifecycleWrites === true;
    if (written) await api.notion(`/pages/${id}`, 'PATCH', { properties });
    changes.push({ id, property, from: current, to, source: pr.html_url, written });
  }
  return { changes, skipped };
}

async function main() {
  const config = { repo: process.env.GITHUB_REPOSITORY, number: Number(process.env.PR_NUMBER), mode: process.env.RELEASE_LEDGER_MODE || 'off', lifecycleWrites: process.env.RELEASE_LIFECYCLE_WRITES === 'true', workItemsId: process.env.WORK_ITEMS_ID || '20aeddfe-a3f7-41e9-b440-c9eb6b26887f', githubToken: process.env.GH_TOKEN, notionToken: process.env.NOTION_TOKEN };
  if (config.mode !== 'off' && (!config.githubToken || !config.notionToken)) throw new Error('GitHub and Notion tokens are required');
  const api = clients(config);
  const result = config.mode === 'live' && config.lifecycleWrites ? await withLock(api.gh, 'VeamStudios/.github', () => completeDevelopment(config, api)) : await completeDevelopment(config, api);
  fs.writeFileSync('development-completion.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
module.exports = { completeDevelopment, REPOSITORIES };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
