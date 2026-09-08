const fs = require('node:fs');
const { clients, withLock, workItems, validateNote, rich, text, select } = require('./record');
const { parseWorkItemLinks } = require('./work-item-links');

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
const TARGETS = { Web: ['web'], iOS: ['ios-consumer', 'ios-enterprise'], Android: ['android-consumer', 'android-enterprise'] };

async function completionNote(pr, repo, gh, ids) {
  const path = String(pr.body).match(/^Release note:\s*(\.release-notes\/[A-Za-z0-9_-]+\.json)\s*$/m)?.[1];
  if (!path) return null; // Existing feature PRs only need their explicit Work Items links.
  const file = await gh(`/repos/${repo}/contents/${path}?ref=${pr.merge_commit_sha}`);
  if (file.encoding !== 'base64' || !file.content) throw new Error('Cannot read committed development completion contract');
  return validateNote(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), ids);
}

async function completeDevelopment(config, api) {
  if (config.mode === 'off') return { skipped: 'off', changes: [] };
  if (!['shadow', 'live'].includes(config.mode)) throw new Error('Invalid release ledger mode');
  const mapping = REPOSITORIES[config.repo];
  if (!mapping) throw new Error('Repository has no client platform mapping');
  if (!Number.isSafeInteger(config.number) || config.number < 1) throw new Error('Invalid PR number');
  const pr = await api.gh(`/repos/${config.repo}/pulls/${config.number}`);
  if (!pr.merged || !pr.merged_at || pr.base?.ref !== 'main' || pr.base?.repo?.full_name !== config.repo) return { skipped: 'PR is not merged into main', changes: [] };
  if (!/^[a-f0-9]{40}$/.test(pr.merge_commit_sha) || !/^[a-f0-9]{40}$/.test(pr.head?.sha) || !Number.isFinite(Date.parse(pr.merged_at))) throw new Error('Merged PR lacks exact commit evidence');
  const ids = workItems(pr.body);
  if (!ids.length) return { skipped: 'No Work Items links', changes: [] };
  const note = await completionNote(pr, config.repo, api.gh, ids);
  if (note?.developmentComplete === false) return { skipped: 'PR explicitly leaves development incomplete', changes: [] };
  const targets = note ? note.targets.filter(target => TARGETS[mapping.platform].includes(target)) : [];
  if (note && !targets.length) return { skipped: 'Release note does not affect this client platform', changes: [] };
  const open = [];
  // Read GitHub directly, including drafts and intermediate base branches, without mirror caps.
  for (let page = 1;; page++) {
    const rows = await api.gh(`/repos/${config.repo}/pulls?state=open&per_page=100&page=${page}`);
    open.push(...rows);
    if (rows.length < 100) break;
  }
  // Sibling PRs are discovery, not the subject of this completion check. Keep
  // valid links even when an unrelated entry is still a template placeholder.
  const openWorkItems = new Set(open.flatMap(other => parseWorkItemLinks(other.body).ids));
  const changes = [], skipped = [];
  for (const id of ids) {
    if (openWorkItems.has(id)) { skipped.push({ id, reason: 'Another linked platform PR is open' }); continue; }
    const row = await api.notion(`/pages/${id}`);
    if (normalize(row.parent?.data_source_id) !== normalize(config.workItemsId)) throw new Error('Linked page is outside Work Items');
    if (row.archived || row.in_trash) { skipped.push({ id, reason: 'Work Item is archived' }); continue; }
    const props = row.properties;
    const products = props.Product?.relation || [];
    if (props.Product?.has_more || products.length !== 1 || normalize(products[0].id) !== mapping.product) throw new Error('Work Item product does not match repository');
    if (['Rejected', 'Deferred', 'Duplicate'].includes(props['Work Item Status']?.status?.name)) { skipped.push({ id, reason: 'Work Item is inactive' }); continue; }
    const property = `${mapping.platform} Dev Status`;
    const current = props[property]?.select?.name;
    if (!['Not Started', 'In Development', 'Done', 'Released'].includes(current)) throw new Error(`Work Item requires an existing ${property} value`);
    if (!props['Platform Development'] || !Array.isArray(props['Platform Development'].rich_text)) throw new Error('Add the Platform Development rich-text property before enabling this workflow');
    const evidence = JSON.parse(text(props['Platform Development']) || '{}');
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('Invalid Platform Development evidence');
    const previous = evidence[mapping.platform];
    if (previous && (!Number.isFinite(Date.parse(previous.mergedAt)) || previous.repository !== config.repo)) throw new Error('Invalid existing platform completion evidence');
    if (previous && (previous.pr === pr.number || Date.parse(previous.mergedAt) >= Date.parse(pr.merged_at))) { skipped.push({ id, reason: 'Completion already recorded or superseded' }); continue; }
    if (current === 'Released') { skipped.push({ id, reason: 'Preserve Released; start enhancement development explicitly' }); continue; }
    evidence[mapping.platform] = { repository: config.repo, pr: pr.number, head: pr.head.sha, mergeCommit: pr.merge_commit_sha, mergedAt: pr.merged_at, source: pr.html_url, scope: note?.scope || '', targets };
    const properties = { [property]: select('Done'), 'Platform Development': rich(JSON.stringify(evidence)) };
    const written = config.mode === 'live' && config.lifecycleWrites === true;
    if (written) await api.notion(`/pages/${id}`, 'PATCH', { properties });
    changes.push({ id, property, from: current, to: 'Done', source: pr.html_url, written });
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
