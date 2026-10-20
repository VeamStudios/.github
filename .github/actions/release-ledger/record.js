const { releaseSchema, targetFilter, presentation } = require('./presentation');
const fs = require('node:fs');
const { parseWorkItemLinks } = require('./work-item-links');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ownColumns, OWNERS, WORKER_FIELDS, effectiveObservation, previousObservation: priorObservation } = require('./ledger-columns');

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
    // Keep the service's reason (e.g. a ruleset rejection), bounded and without credentials; the per-call request ID stays
    // off the message so hourly Notion errors stay stable.
    let reason='';try{const body=await r.json();reason=String(body?.message||body?.code||'')}catch{}
    reason=reason.replace(/\b(?:gh[pousr]_|github_pat_|ntn_|secret_)[A-Za-z0-9_]+/g,'[redacted]').replace(/\s+/g,' ').trim().slice(0,200);
    const id=String(r.headers?.get?.(notion?'x-request-id':'x-github-request-id')||'').replace(/[^A-Za-z0-9:._-]/g,'').slice(0,64);
    const e=new Error(`${notion?'Notion':'GitHub'} ${method} failed (${r.status})${reason?`: ${reason}`:''}`);e.status=r.status;e.requestId=id||undefined;throw e;
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
async function buildManifest(config, gh, baseline, notion) {
  return require('./changelog').buildChangelogManifest(config,gh,baseline,notion);
}
function validCloudRun(v,commit,repository){try{return Boolean(require('./cloud-run').validateCloudRun(v,commit,repository))}catch{return false}}
function workItemRelation(ids, previous) {
  // An old frozen manifest can lack links recovered later from its exact source range.
  if (ids.length > 100 || (!ids.length && (previous?.relation?.length || previous?.has_more))) return undefined;
  return { relation: ids.map(id => ({ id })) };
}
function deployedBaseline(row) {
  try {
    const m=JSON.parse(text(row.properties.Manifest)),o=priorObservation(row.properties);
    const evidence=effectiveObservation(row.properties)?.availabilityEvidence||row.properties['Availability Evidence']?.url;
    if(hash(m)!==text(row.properties['Manifest Hash'])||!o)return false;
    const b=o.baseline;
    // An audited baseline only chooses the comparison commit; it never establishes Play availability.
    if(b?.kind==='audited-production-baseline'&&b.manifestHash===hash(m)&&b.commit===m.commit&&b.repository===m.repository&&b.target===m.target&&Number.isFinite(Date.parse(b.checkedAt))&&Array.isArray(b.evidence)&&b.evidence.length>=2&&b.evidence.every(url=>typeof url==='string'&&url.startsWith('https://'))&&(!m.target.match(/^(ios|android)-/)||Boolean(b.build&&b.build===(m.build||text(row.properties.Build)))))return true;
    if(m.repository==='VeamStudios/SiteAuditPro-AndroidNew'&&m.target==='android-consumer')return o.phase==='live'&&require('./google-play').validGooglePlay(o.verification,m);
    if(m.target.includes('ios')||m.target.includes('android'))return Boolean(o.phase==='live'&&m.build&&((o.verification?.kind==='app-store'&&o.verification.build===m.build)||(o.verification?.kind==='manual'&&o.verification.build===m.build&&row.properties['Audience Verified']?.checkbox&&evidence)));
    return Boolean(o.phase==='deployed'&&((o.verification?.kind==='http'&&o.verification.commit===m.commit&&o.verification.reportedCommit===m.commit&&o.verification.repository===m.repository&&o.verification.evidence)||(o.verification?.kind==='cloud-run'&&validCloudRun(o.verification,m.commit,m.repository))||(o.verification?.kind==='manual'&&o.verification.commit===m.commit&&o.verification.evidence&&row.properties['Audience Verified']?.checkbox&&evidence)));
  }catch{return false}
}
function verificationProperties(config, previous, oldProperties, observedAt) {
  // A failed recheck is a new diagnostic, not evidence that the original deployment never happened.
  const retain = Boolean(config.verificationError && previous?.phase === config.phase && previous.verification);
  const observation = { ...(previous?.website ? {website:previous.website} : {}), ...(previous?.baseline ? {baseline:previous.baseline} : {}), phase:config.phase, source:retain ? previous.source : config.source, releasedAt:config.releasedAt || previous?.releasedAt || observedAt, verification:config.verification || (retain ? previous.verification : null), ...(config.verificationError ? {verificationError:config.verificationError,verificationAttempt:{source:config.source,at:observedAt}} : {}) };
  const properties = {Observation:rich(JSON.stringify(observation))};
  if (config.verification && !config.verificationError && previous?.verificationError && text(oldProperties?.Error) === previous.verificationError) {
    const receipt = JSON.parse(text(oldProperties?.['Operations Receipt']) || '{}');
    receipt.resolutions = [...(receipt.resolutions || []), {at:observedAt,error:previous.verificationError,recovery:config.source}];
    properties['Operations Receipt'] = rich(JSON.stringify(receipt));
    properties.Error = rich('');
  }
  return properties;
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
  const states = { prepare: 'Waiting', deployed: 'Waiting', uploaded: 'Waiting', live: 'Waiting', rollout: 'Limited rollout', withdrawn: 'Withdrawn', halted: 'Waiting' };
  if (!states[config.phase]) throw new Error('Unknown release phase.');
  const observedAt = new Date().toISOString();
  const previousObservation = priorObservation(existing[0]?.properties);
  const rank = { prepare: 0, uploaded: 1, deployed: 2, rollout: 3, live: 4, withdrawn: 5 };
  const acceptObservation = config.verification?.kind==='google-play' || !previousObservation || rank[config.phase] >= (rank[previousObservation.phase] ?? -1);
  const oldState = existing[0]?.properties.State?.select?.name;
  const properties = { ...presentation(manifest, schema, existing[0]), 'Release Key': rich(manifest.key), Repository: rich(config.repo), Version: rich(config.version), Commit: rich(manifest.commit), Build: rich(manifest.build), Event: select(manifest.event), Manifest: rich(JSON.stringify(manifest)), 'Manifest Hash': rich(digest), Changelog: rich(manifest.schemaVersion===2?manifest.completeChangelog:manifest.changes.filter(c => c.kind !== 'internal').map(c => `- ${c.summary}`).join('\n')), 'Work Items': { relation: ids.map(id => ({ id })) }, Source: { url: config.source }, 'Observed At': { date: { start: observedAt } } };
  const relation = workItemRelation(ids, existing[0]?.properties['Work Items']);
  if (relation) properties['Work Items'] = relation; else delete properties['Work Items'];
  if (!existing[0]) Object.assign(properties, { State: select(states[config.phase]), 'Historical': { checkbox: config.historical === true }, 'Notification State': select(config.historical ? 'Suppressed' : 'Pending'), Error: rich(manifest.schemaVersion===2?'':manifest.issues.join('\n')) });
  if (readyNotes && !existing[0]) Object.assign(properties, { 'Approved Hash': rich(digest), 'Approval Evidence': { url: manifest.prs[0].url } });
  // Transport evidence does not imply audience availability. The processor verifies this observation.
  if (config.phase !== 'prepare' && acceptObservation) {
    properties['Availability Evidence'] = { url: config.source };
    if (['deployed', 'live', 'rollout', 'withdrawn'].includes(config.phase)) properties['Released At'] = { date: { start: config.releasedAt || (existing[0] && effectiveObservation(existing[0].properties)?.releasedAt) || existing[0]?.properties['Released At']?.date?.start || observedAt } };
    Object.assign(properties,verificationProperties(config,previousObservation,existing[0]?.properties,observedAt));
    // Preserve processor-owned display labels on source replay. They never
    // establish transport or publication authority; the processor re-evaluates
    // the raw observation, and explicit withdrawal still overrides below.
    if (!['Available', 'Released', 'Superseded', 'Withdrawn'].includes(oldState)) properties.State = select(states[config.phase]);
  }
  if(config.verification?.kind==='manual' && !(config.repo==='VeamStudios/SiteAuditPro-AndroidNew'&&config.target==='android-consumer'))properties['Audience Verified']={checkbox:true};
  if(config.verificationError)properties.Error=rich(config.verificationError);
  if (config.phase === 'withdrawn') properties.State = select('Withdrawn');
  if (existing[0]) {
    // Human edits must invalidate readiness, never be silently overwritten by a retry.
    for (const name of ['Manifest', 'Manifest Hash', 'Changelog', 'Work Items', 'Product', 'Repository', 'Target', 'Version', 'Commit', 'Build', 'Event']) delete properties[name];
  }
  if(existing[0]) {
    const sameObservation=properties.Observation && text(properties.Observation)===text(existing[0].properties.Observation);
    if(!properties.Observation || sameObservation)delete properties['Observed At'];
    // A row recorded before owned columns still needs this writer's column on an unchanged replay.
    const ownedMissing=!text(existing[0].properties[OWNERS[config.verification?.kind === 'google-play' ? 'play' : 'deploy'].observation]);
    for(const [name,value] of Object.entries(properties))if(!(name==='Observation'&&ownedMissing)&&hash(propertyValue(value))===hash(propertyValue(existing[0].properties[name])))delete properties[name];
    if(!Object.keys(properties).length)return {key:manifest.key,pageId:existing[0].id,url:existing[0].url,hash:digest,issues:manifest.issues};
  }
  // Play monitor recordings own the Play columns; every other recording is a deploy.
  const owner = config.verification?.kind === 'google-play' ? 'play' : 'deploy';
  Object.assign(properties, ownColumns(owner, properties, observedAt, existing[0]?.properties));
  if (properties.Observation && !config.verificationError) properties[OWNERS[owner].error] = rich('');
  // The Notion worker owns these; a new row still starts with its initial State.
  for (const name of WORKER_FIELDS) if (existing[0] || name !== 'State') delete properties[name];
  if (existing[0] && !Object.keys(properties).length) return { key: manifest.key, pageId: existing[0].id, url: existing[0].url, hash: digest, issues: manifest.issues };
  if (config.dryRun) return { manifest, properties, dryRun: true };
  let row;
  try { row = existing[0] ? await api.notion(`/pages/${existing[0].id}`, 'PATCH', { properties }) : await api.notion('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: config.releasesId }, properties }); }
  catch(error) {
    if(existing[0])throw error;
    const found=await allPages(api.notion,`/data_sources/${config.releasesId}/query`,{filter});
    if(found.length!==1||text(found[0].properties['Manifest Hash'])!==digest)throw error;
    row=found[0];
  }
  if (!existing[0]) {
    // Without the shared lock, overlapping creators can each create this release.
    // Every creator keeps the earliest row and removes only its own duplicate.
    const rows = await allPages(api.notion, `/data_sources/${config.releasesId}/query`, { filter });
    const keep = rows.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time) || a.id.localeCompare(b.id))[0];
    if (keep && keep.id !== row.id) {
      await api.notion(`/pages/${row.id}`, 'PATCH', { in_trash: true });
      const kept = JSON.parse(text(keep.properties.Manifest) || 'null');
      if (kept?.commit !== manifest.commit || kept?.build !== manifest.build) throw new Error('Release identity already belongs to a different commit/build.');
      // Carry this writer's own evidence onto the kept row; it owns no other field there.
      const own = Object.fromEntries(Object.entries(properties).filter(([name]) => Object.values(OWNERS[owner]).includes(name)));
      if (Object.keys(own).length) await api.notion(`/pages/${keep.id}`, 'PATCH', { properties: own });
      row = keep;
    }
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
  // Owned columns replace the shared lock: no other writer sends these properties.
  const result = await record(config, api);
  console.log(JSON.stringify({ key: result.key || result.manifest.key, url: result.url, hash: result.hash, dryRun: config.dryRun }));
  if(config.verificationError)throw new Error(config.verificationError);
}
module.exports = { workItemRelation, verificationProperties, canonical, hash, rich, text, select, workItems, releaseKey, request, clients, allPages, buildManifest, record, git, ancestor, reviewed, provenanceMapping, deployedBaseline };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
