const { releaseSchema, targetFilter, presentation } = require('./presentation');
const fs = require('node:fs');
const { parseWorkItemLinks } = require('./work-item-links');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { withLock } = require('./lock');

const SHA = /^[a-f0-9]{40}$/;
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const rich = value => {
  const s = String(value ?? '');
  if (s.length > 180000) throw new Error('Release record exceeds supported size; split the release explicitly (nothing was truncated).');
  return { rich_text: (s.match(/[\s\S]{1,1800}/g) || []).map(content => ({ type: 'text', text: { content } })) };
};
const text = prop => (prop?.rich_text || prop?.title || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
const select = name => ({ select: { name } });
function workItems(body) {
  const { ids, invalidEntries } = parseWorkItemLinks(body);
  if (invalidEntries.length) throw new Error('Invalid Work Items links: use one Notion page URL per entry.');
  return ids;
}

function validateNote(note, ids) {
  if (!note || !['feature', 'fix', 'internal'].includes(note.kind)) throw new Error('Release note kind must be feature, fix or internal.');
  for (const key of ['summary', 'audience', 'limitations', 'scope']) {
    if (typeof note[key] !== 'string' || (key !== 'limitations' && !note[key].trim())) throw new Error(`Release note requires ${key}.`);
  }
  if (note.summary.length > 400 || /[\r\n]/.test(note.summary)) throw new Error('Release summary must be one line, at most 400 characters.');
  if (!Array.isArray(note.workItems) || hash([...new Set(note.workItems)].sort()) !== hash(ids)) throw new Error('Committed workItems must match the PR Work Items: links.');
  if (note.kind === 'feature' && ids.length === 0) throw new Error('Feature release note requires explicit Work Items: links.');
  if (!Array.isArray(note.requiredReleaseKeys) || note.requiredReleaseKeys.some(x => typeof x !== 'string' || !x)) throw new Error('requiredReleaseKeys must be an explicit array (empty is allowed).');
  if (!Array.isArray(note.targets) || note.targets.length === 0 || note.targets.some(x => typeof x !== 'string' || !/^[a-z0-9][a-z0-9.-]+$/.test(x))) throw new Error('Release note requires explicit targets.');
  if (typeof note.audienceGate !== 'boolean') throw new Error('Release note must explicitly set audienceGate.');
  if (note.developmentComplete !== undefined && typeof note.developmentComplete !== 'boolean') throw new Error('developmentComplete must be a boolean when supplied.');
  return { kind: note.kind, summary: note.summary.trim(), audience: note.audience, limitations: note.limitations, scope: note.scope, targets: [...new Set(note.targets)].sort(), audienceGate: note.audienceGate, requiredReleaseKeys: [...new Set(note.requiredReleaseKeys)].sort(), workItems: ids, ...(note.developmentComplete === undefined ? {} : { developmentComplete: note.developmentComplete }) };
}
function releaseKey(repo, target, version, event = 'release') {
  return `${repo}/${target}/${event}/${version}`;
}
function git(...args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim(); }
function ancestor(base, head) { try { git('merge-base', '--is-ancestor', base, head); return true; } catch { return false; } }
async function request(url, token, method = 'GET', body, notion = false) {
  const safe=method==='GET' || notion && (url.endsWith('/query') || (method==='PATCH'&&!url.endsWith('/children')));
  for(let attempt=0;;attempt++) {
    let r;
    try {r=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json',...(notion?{'Notion-Version':'2026-03-11'}:{'X-GitHub-Api-Version':'2022-11-28'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)})}
    catch(error){if(!safe||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,500*2**attempt));continue}
    if(r.ok)return r.status===204?{}:r.json();
    const delay=Number(r.headers.get('retry-after')||0)*1000;
    if(safe&&attempt<3&&[429,500,502,503,504,529].includes(r.status)&&delay<=20000){await new Promise(resolve=>setTimeout(resolve,Math.max(delay,500*2**attempt)));continue}
    const e=new Error(`${notion?'Notion':'GitHub'} ${method} failed (${r.status})`);e.status=r.status;throw e;
  }
}
function propertyValue(p) {
  if(!p)return null;
  if(p.rich_text||p.title)return text(p);
  if(p.relation)return p.relation.map(x=>x.id.replace(/-/g,'')).sort();
  if('date' in p)return p.date?{start:p.date.start.includes('T')?Date.parse(p.date.start):p.date.start,end:p.date.end||null}:null;
  if('select' in p)return p.select?.name||null;
  if('url' in p)return p.url;
  if('checkbox' in p)return p.checkbox;
  return p;
}
function clients(config) {
  return {
    gh: (path, method, body) => request(`https://api.github.com${path}`, config.githubToken, method, body),
    notion: (path, method, body) => request(`https://api.notion.com/v1${path}`, config.notionToken, method, body, true),
  };
}
async function allPages(call, path, body) {
  const result = []; let cursor;
  do { const r = await call(path, 'POST', { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }); result.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined; } while (cursor);
  return result;
}
async function reviewed(gh, repo, pr) {
  const reviews = [];
  for (let page = 1;; page++) { const rows = await gh(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100&page=${page}`); reviews.push(...rows); if (rows.length < 100) break; }
  const latest = new Map();
  for (const review of reviews) if (review.user?.type === 'User' && review.user.login !== pr.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review);
  return [...latest.values()].some(r => r.state === 'APPROVED' && r.commit_id === pr.head.sha) && ![...latest.values()].some(r => r.state === 'CHANGES_REQUESTED');
}
async function provenanceMapping(config, gh, sha, baseline) {
  if (!config.mappingPath) return null;
  if (!/^\.release-provenance\/[A-Za-z0-9_-]+\.json$/.test(config.mappingPath)) throw new Error('Invalid provenance mapping path');
  const mapping = JSON.parse(git('show', `${sha}:${config.mappingPath}`));
  const pr = await gh(`/repos/${config.repo}/pulls/${mapping.reviewPr}`);
  if (!pr.merged_at || pr.base?.repo?.full_name !== config.repo || !ancestor(pr.merge_commit_sha, sha) || !await reviewed(gh, config.repo, pr)) throw new Error('Provenance map needs a merged current-head human-reviewed PR');
  if (hash(mapping) !== hash(JSON.parse(git('show', `${pr.merge_commit_sha}:${config.mappingPath}`)))) throw new Error('Provenance map changed since review');
  if (mapping.baseline !== baseline || !mapping.commits || Object.entries(mapping.commits).some(([commit, number]) => !SHA.test(commit) || !Number.isSafeInteger(number) || number <= 0)) throw new Error('Invalid provenance map or baseline');
  return { ...mapping, evidence: pr.html_url };
}
async function buildLegacyManifest(config, gh, baseline) {
  const sha = git('rev-parse', `${config.commit}^{commit}`);
  if (!SHA.test(sha)) throw new Error('Cannot resolve exact deployed commit.');
  const issues = [];
  const mappingEvidence = await provenanceMapping(config, gh, sha, baseline);
  const validBaseline = Boolean(baseline && SHA.test(baseline) && (ancestor(baseline, sha) || mappingEvidence));
  if (!baseline || !SHA.test(baseline) || !validBaseline) issues.push('Missing or non-ancestor successful production baseline; prepare an explicitly reviewed mapping.');
  const commits = issues.length ? [] : git('rev-list', '--reverse', `${baseline}..${sha}`).split('\n').filter(Boolean);
  const numbers = new Set(); const unmapped = [];
  const mapping = mappingEvidence?.commits || {};
  for (const commit of commits) {
    const associated = [];
    for (let page = 1;; page++) { const rows = await gh(`/repos/${config.repo}/commits/${commit}/pulls?per_page=100&page=${page}`); associated.push(...rows); if (rows.length < 100) break; }
    const prs = associated.filter(pr => pr.base?.repo?.full_name === config.repo && (pr.merged_at ? pr.merge_commit_sha && ancestor(pr.merge_commit_sha, sha) : pr.head?.sha && ancestor(pr.head.sha, sha)));
    if (mapping[commit]) numbers.add(Number(mapping[commit]));
    else if (prs.length === 1) numbers.add(prs[0].number);
    else unmapped.push(commit);
  }
  if (unmapped.length) issues.push(`Unmapped or ambiguous commits: ${unmapped.join(', ')}. Supply a reviewed provenance map; no title guessing is used.`);
  const prs = []; const changes = [];
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const pr = await gh(`/repos/${config.repo}/pulls/${number}`);
    if (pr.base?.repo?.full_name !== config.repo || (!pr.merged_at && (!pr.head?.sha || !ancestor(pr.head.sha, sha)))) throw new Error(`PR #${number} is not proven in the shipped repository commit.`);
    // Preserve discovered links and the PR in the manifest even when validation
    // fails. Its error must block approval without aborting sibling PR scans.
    const { ids } = parseWorkItemLinks(pr.body);
    const path = String(pr.body).match(/^Release note:\s*(\.release-notes\/[A-Za-z0-9_-]+\.json)\s*$/m)?.[1];
    let approved = false; let noteHash = ''; let note;
    try {
      workItems(pr.body);
      if (!path) throw new Error('Add Release note: .release-notes/<change>.json to the PR body.');
      const files = [];
      for (let page = 1;; page++) { const rows = await gh(`/repos/${config.repo}/pulls/${number}/files?per_page=100&page=${page}`); files.push(...rows); if (rows.length < 100) break; }
      if (!files.some(file => file.filename === path && file.status === 'added')) throw new Error('Each PR must add its own unique release note file; existing notes cannot be relabelled.');
      const frozen = git('show', `${sha}:${path}`);
      const merged = git('show', `${pr.merged_at ? pr.merge_commit_sha : pr.head.sha}:${path}`);
      if (hash(JSON.parse(frozen)) !== hash(JSON.parse(merged))) throw new Error('Release note changed after its originating PR merged.');
      note = validateNote(JSON.parse(frozen), ids); noteHash = hash(note);
      approved = await reviewed(gh, config.repo, pr);
      if (!approved) issues.push(`PR #${number}: release wording has no current-head human review; approve the frozen manifest before publication.`);
      if (note.targets.includes(config.target)) changes.push({ ...note, pr: number, noteHash });
    } catch (error) { issues.push(`PR #${number}: ${error.message}`); }
    prs.push({ number, url: pr.html_url, mergeCommit: pr.merged_at ? pr.merge_commit_sha : null, headCommit: pr.head.sha, workItems: ids, noteHash, approved });
  }
  return { schemaVersion: 1, key: releaseKey(config.repo, config.target, config.version, config.event), repository: config.repo, product: config.product, target: config.target, version: config.version, build: config.build || '', commit: sha, baseline: baseline || '', event: config.event || 'release', prs, changes, issues, provenanceComplete: unmapped.length === 0 && validBaseline, provenanceMapping: mappingEvidence, source: config.source };
}
async function buildManifest(config, gh, baseline, notion) {
  return config.legacy ? buildLegacyManifest(config,gh,baseline) : require('./changelog').buildChangelogManifest(config,gh,baseline,notion);
}
function validCloudRun(v,commit,repository){try{return Boolean(require('./cloud-run').validateCloudRun(v,commit,repository))}catch{return false}}
function deployedBaseline(row) {
  try {
    const m=JSON.parse(text(row.properties.Manifest)),o=JSON.parse(text(row.properties.Observation)||'null');
    if(hash(m)!==text(row.properties['Manifest Hash'])||!o)return false;
    const b=o.baseline;
    if(b?.kind==='audited-production-baseline'&&b.manifestHash===hash(m)&&b.commit===m.commit&&b.repository===m.repository&&b.target===m.target&&Number.isFinite(Date.parse(b.checkedAt))&&Array.isArray(b.evidence)&&b.evidence.length>=2&&b.evidence.every(url=>typeof url==='string'&&url.startsWith('https://'))&&(!m.target.match(/^(ios|android)-/)||Boolean(b.build&&b.build===(m.build||text(row.properties.Build)))))return true;
    if(m.target.includes('ios')||m.target.includes('android'))return Boolean(o.phase==='live'&&m.build&&((o.verification?.kind==='app-store'&&o.verification.build===m.build)||(o.verification?.kind==='manual'&&o.verification.build===m.build&&row.properties['Audience Verified']?.checkbox&&row.properties['Availability Evidence']?.url)));
    return Boolean(o.phase==='deployed'&&((o.verification?.kind==='http'&&o.verification.commit===m.commit&&o.verification.reportedCommit===m.commit&&o.verification.repository===m.repository&&o.verification.evidence)||(o.verification?.kind==='cloud-run'&&validCloudRun(o.verification,m.commit,m.repository))||(o.verification?.kind==='manual'&&o.verification.commit===m.commit&&o.verification.evidence&&row.properties['Audience Verified']?.checkbox&&row.properties['Availability Evidence']?.url)));
  }catch{return false}
}
async function record(config, api) {
  const schema = await releaseSchema(api.notion, config.releasesId);
  const filter = { property: 'Release Key', rich_text: { equals: releaseKey(config.repo, config.target, config.version, config.event) } };
  const existing = await allPages(api.notion, `/data_sources/${config.releasesId}/query`, { filter });
  if (existing.length > 1) throw new Error('Duplicate release identity found; reconcile before continuing.');
  let manifest;
  if (existing[0] && text(existing[0].properties.Manifest)) {
    manifest = JSON.parse(text(existing[0].properties.Manifest));
    if (manifest.commit !== git('rev-parse', `${config.commit}^{commit}`) || manifest.build !== (config.build || '')) throw new Error('Release identity already belongs to a different commit/build.');
  } else {
    let baseline = config.baseline;
    if (!baseline) {
      const previous = await allPages(api.notion, `/data_sources/${config.releasesId}/query`, { filter: { and: [{ property: 'Repository', rich_text: { equals: config.repo } }, targetFilter(schema, config.target)] }, sorts: [{ property: 'Released At', direction: 'descending' }] });
      const prior=previous.find(row => text(row.properties['Release Key']) !== filter.rich_text.equals && deployedBaseline(row));
      baseline=prior?JSON.parse(text(prior.properties.Manifest)).commit:undefined;
    }
    manifest = await buildManifest(config, api.gh, baseline, api.notion);
  }
  const digest = hash(manifest);
  fs.writeFileSync('release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  const readyNotes = manifest.schemaVersion===1 && manifest.provenanceComplete && manifest.prs.length > 0 && manifest.prs.every(pr => pr.approved && pr.noteHash);
  const ids = [...new Set(manifest.prs.flatMap(pr => pr.workItems))];
  if (ids.length > 100) console.warn('Work Item relation exceeds Notion API capacity; complete contents remain in Manifest.');
  const states = { prepare: 'Waiting', deployed: 'Waiting', uploaded: 'Waiting', live: 'Waiting', rollout: 'Limited rollout', withdrawn: 'Withdrawn' };
  if (!states[config.phase]) throw new Error('Unknown release phase.');
  const observedAt = new Date().toISOString();
  const previousObservation = text(existing[0]?.properties.Observation) ? JSON.parse(text(existing[0].properties.Observation)) : null;
  const rank = { prepare: 0, uploaded: 1, deployed: 2, rollout: 3, live: 4, withdrawn: 5 };
  const acceptObservation = !previousObservation || rank[config.phase] >= rank[previousObservation.phase];
  const oldState = existing[0]?.properties.State?.select?.name;
  const properties = { ...presentation(manifest, schema, existing[0]), 'Release Key': rich(manifest.key), Repository: rich(config.repo), Version: rich(config.version), Commit: rich(manifest.commit), Build: rich(manifest.build), Event: select(manifest.event), Manifest: rich(JSON.stringify(manifest)), 'Manifest Hash': rich(digest), Changelog: rich(manifest.schemaVersion===2?manifest.completeChangelog:manifest.changes.filter(c => c.kind !== 'internal').map(c => `- ${c.summary}`).join('\n')), 'Work Items': { relation: ids.map(id => ({ id })) }, Source: { url: config.source }, 'Observed At': { date: { start: observedAt } } };
  if (ids.length > 100) delete properties['Work Items'];
  if (!existing[0]) Object.assign(properties, { State: select(states[config.phase]), 'Historical': { checkbox: config.historical === true }, 'Notification State': select(config.historical ? 'Suppressed' : 'Pending'), Error: rich(manifest.schemaVersion===2?'':manifest.issues.join('\n')) });
  if (readyNotes && !existing[0]) Object.assign(properties, { 'Approved Hash': rich(digest), 'Approval Evidence': { url: manifest.prs[0].url } });
  // Transport evidence does not imply audience availability. The processor verifies this observation.
  if (config.phase !== 'prepare' && acceptObservation) {
    properties['Availability Evidence'] = { url: config.source };
    if (['deployed', 'live', 'rollout', 'withdrawn'].includes(config.phase)) properties['Released At'] = { date: { start: config.releasedAt || existing[0]?.properties['Released At']?.date?.start || observedAt } };
    properties.Observation = rich(JSON.stringify({ ...(previousObservation?.baseline?{baseline:previousObservation.baseline}:{}), phase: config.phase, source: config.source, releasedAt: config.releasedAt || previousObservation?.releasedAt || observedAt, verification: config.verification || null, ...(config.verificationError?{verificationError:config.verificationError}:{}) }));
    if (oldState !== 'Available' && oldState !== 'Withdrawn') properties.State = select(states[config.phase]);
  }
  if(config.verification?.kind==='manual')properties['Audience Verified']={checkbox:true};
  if(config.verificationError)properties.Error=rich(config.verificationError);
  if (config.phase === 'withdrawn') properties.State = select('Withdrawn');
  if (existing[0]) {
    // Human edits must invalidate readiness, never be silently overwritten by a retry.
    for (const name of ['Manifest', 'Manifest Hash', 'Changelog', 'Work Items', 'Product', 'Repository', 'Target', 'Version', 'Commit', 'Build', 'Event']) delete properties[name];
  }
  if(existing[0]) {
    const sameObservation=properties.Observation && text(properties.Observation)===text(existing[0].properties.Observation);
    if(!properties.Observation || sameObservation)delete properties['Observed At'];
    for(const [name,value] of Object.entries(properties))if(hash(propertyValue(value))===hash(propertyValue(existing[0].properties[name])))delete properties[name];
    if(!Object.keys(properties).length)return {key:manifest.key,pageId:existing[0].id,url:existing[0].url,hash:digest,issues:manifest.issues};
  }
  if (config.dryRun) return { manifest, properties, dryRun: true };
  let row;
  try { row = existing[0] ? await api.notion(`/pages/${existing[0].id}`, 'PATCH', { properties }) : await api.notion('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: config.releasesId }, properties }); }
  catch(error) {
    if(existing[0])throw error;
    const found=await allPages(api.notion,`/data_sources/${config.releasesId}/query`,{filter});
    if(found.length!==1||text(found[0].properties['Manifest Hash'])!==digest)throw error;
    row=found[0];
  }
  return { key: manifest.key, pageId: row.id, url: row.url, hash: digest, issues: manifest.issues };
}
async function main() {
  const input = name => process.env[`INPUT_${name}`]?.trim() || '';
  const config = { repo: process.env.GITHUB_REPOSITORY, target: input('TARGET'), product: input('PRODUCT'), version: input('VERSION'), commit: input('COMMIT'), build: input('BUILD'), baseline: input('BASELINE'), phase: input('PHASE') || 'deployed', event: input('EVENT') || 'release', source: input('SOURCE') || `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, githubToken: input('GITHUB_TOKEN'), notionToken: input('NOTION_TOKEN'), releasesId: input('RELEASES_ID'), dryRun: input('DRY_RUN') !== 'false', historical: input('HISTORICAL') === 'true', releasedAt: input('RELEASED_AT'), mappingPath: input('MAPPING_PATH') };
  for (const name of ['repo', 'target', 'product', 'version', 'commit', 'githubToken']) if (!config[name]) throw new Error(`Missing ${name}.`);
  if (!config.notionToken || !config.releasesId) {
    if (!config.dryRun) throw new Error('Notion recording requires NOTION_TOKEN and RELEASES_ID.');
    const manifest = await buildManifest(config, clients(config).gh, config.baseline);
    fs.writeFileSync('release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ dryRun: true, key: manifest.key, issues: manifest.issues })); return;
  }
  if(config.phase==='deployed') {
    try {
      if(input('PROVIDER_VERIFICATION'))config.verification=require('./cloud-run').validateCloudRun(JSON.parse(input('PROVIDER_VERIFICATION')),git('rev-parse',`${config.commit}^{commit}`),config.repo);
      else {
      if(!input('VERIFICATION_URL'))throw new Error('Configure RELEASE_VERIFICATION_URL for the deployed commit endpoint');
      config.verification=await require('./verify-deployment').verifyDeployment(input('VERIFICATION_URL'),git('rev-parse',`${config.commit}^{commit}`),config.repo);
      }
    }catch(error){config.verificationError=error.message;console.warn(`::warning::${error.message}. Deployment is recorded; retry evidence recording without redeploying.`)}
  }
  if(input('DISTRIBUTION_CONFIRMED')==='true') {
    if(!['live','rollout'].includes(config.phase)||!config.target.startsWith('android-')||!config.build||!input('DISTRIBUTION_EVIDENCE'))throw new Error('Manual distribution confirmation requires Android target, exact build, live/rollout phase and evidence');
    const evidence=new URL(input('DISTRIBUTION_EVIDENCE'));if(evidence.protocol!=='https:')throw new Error('Distribution evidence must use HTTPS');
    config.verification={kind:'manual',build:config.build,commit:git('rev-parse',`${config.commit}^{commit}`),evidence:evidence.href,checkedAt:new Date().toISOString(),actor:process.env.GITHUB_ACTOR};
  }
  const api = clients(config);
  const result = config.dryRun ? await record(config, api) : await withLock(api.gh, 'VeamStudios/.github', () => record(config, api));
  console.log(JSON.stringify({ key: result.key || result.manifest.key, url: result.url, hash: result.hash, dryRun: config.dryRun }));
  if(config.verificationError)throw new Error(config.verificationError);
}
module.exports = { canonical, hash, rich, text, select, workItems, validateNote, releaseKey, request, clients, allPages, withLock, buildManifest, buildLegacyManifest, record, git, ancestor, reviewed, provenanceMapping, deployedBaseline };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
