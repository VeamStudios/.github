'use strict';

const BOT = 'veamstudios-release-bot[bot]';
const START = '<!-- MODELS-UPGRADE-ASSESSMENT:start -->';
const END = '<!-- MODELS-UPGRADE-ASSESSMENT:end -->';
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== null).map(k => [k, sort(value[k])]));
  return value;
}
function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value || '');
  if (!match || match.slice(1).some(n => !Number.isSafeInteger(Number(n)))) throw new Error(`Not an exact stable Models version: ${value}`);
  return match.slice(1).map(Number);
}
function compare(a, b) {
  const av = version(a), bv = version(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  return 0;
}
function packageRepo(url) {
  const match = /^https:\/\/github\.com\/VeamStudios\/(SiteAuditPro-Models|ChecklistInspectorPro-Models)(?:\.git)?\/?$/i.exec(url);
  if (!match) throw new Error('Only the SAP and CIP Models repositories are supported');
  return `VeamStudios/${match[1]}`;
}
const normalizeUrl = url => String(url || '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();
function withoutDependency(manifest, name) {
  const result = structuredClone(manifest);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (result[section]) delete result[section][name];
  return result;
}
function yarnBlocks(text) {
  const blocks = [...text.matchAll(/^([^\s#][^\n]*):\r?\n((?:(?:[ \t][^\n]*)?\r?\n)*)/gm)].map(m => [m[1], m[2].trim()]);
  if (!blocks.length) throw new Error('Unsupported or empty Yarn lockfile');
  return blocks;
}
function npmSnapshot(manifestText, lockText, lockPath, name) {
  const manifest = JSON.parse(manifestText);
  let pinned, other;
  if (lockPath === 'package-lock.json') {
    const lock = JSON.parse(lockText);
    pinned = lock.packages?.[`node_modules/${name}`]?.version || lock.dependencies?.[name]?.version;
    const copy = structuredClone(lock);
    if (copy.packages) {
      delete copy.packages[`node_modules/${name}`];
      if (copy.packages['']) copy.packages[''] = withoutDependency(copy.packages[''], name);
    }
    if (copy.dependencies) delete copy.dependencies[name];
    other = copy;
  } else {
    const blocks = yarnBlocks(lockText), target = blocks.filter(([key]) => key.includes(`${name}@`));
    const pins = [...new Set(target.map(([, body]) => /^\s*version "([^"]+)"/m.exec(body)?.[1]))];
    if (pins.length !== 1 || !pins[0]) throw new Error('Ambiguous Models version in Yarn lockfile');
    pinned = pins[0];
    other = blocks.filter(([key]) => !key.includes(`${name}@`)).sort((a, b) => a[0].localeCompare(b[0]));
  }
  version(pinned);
  return {version: pinned, other, manifest: withoutDependency(manifest, name)};
}
function spmSnapshot(text, url) {
  const data = JSON.parse(text), pins = data.pins || data.object?.pins;
  if (!Array.isArray(pins)) throw new Error('Unsupported SPM lockfile');
  const matches = pins.filter(pin => normalizeUrl(pin.location || pin.repositoryURL) === normalizeUrl(url));
  if (matches.length !== 1) throw new Error('Missing or ambiguous Models SPM pin');
  version(matches[0].state?.version);
  return {version: matches[0].state.version, other: pins.filter(pin => !matches.includes(pin)).sort((a, b) => canonical(a).localeCompare(canonical(b)))};
}
function projectWithoutModelsVersion(text, url) {
  let found = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('XCRemoteSwiftPackageReference') || !lines[i].includes(' = {')) continue;
    const start = i;
    let depth = 0;
    do { depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length; i++; } while (i < lines.length && depth > 0);
    const block = lines.slice(start, i).join('\n');
    const remote = /repositoryURL = "([^"]+)";/.exec(block)?.[1];
    if (normalizeUrl(remote) !== normalizeUrl(url)) { i--; continue; }
    for (let j = start; j < i; j++) if (/^\s*version = [^;]+;\s*$/.test(lines[j])) {
      lines[j] = lines[j].replace(/version = [^;]+;/, 'version = MODELS_VERSION;'); found++;
    }
    i--;
  }
  if (found !== 1) throw new Error('Missing or ambiguous exact Models project requirement');
  return lines.join('\n');
}
async function content(api, repo, path, ref, optional = false) {
  try {
    const data = await api('GET', `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    if (data.type !== 'file' || data.encoding !== 'base64') throw new Error(`Cannot read ${path}`);
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) { if (optional && error.status === 404) return null; throw error; }
}
async function consumerEvidence(api, repo, base, head, files, options) {
  const reasons = [];
  let old, proposed;
  if (options.kind === 'npm') {
    const lockPath = (await content(api, repo, 'package-lock.json', base, true)) !== null ? 'package-lock.json' : 'yarn.lock';
    const [bm, hm, bl, hl] = await Promise.all(['package.json', 'package.json', lockPath, lockPath].map((path, i) => content(api, repo, path, i % 2 === 0 ? base : head)));
    old = npmSnapshot(bm, bl, lockPath, options.name); proposed = npmSnapshot(hm, hl, lockPath, options.name);
    if (canonical(old.manifest) !== canonical(proposed.manifest)) reasons.push('Other package manifest changes accompany the Models upgrade.');
    if (canonical(old.other) !== canonical(proposed.other)) reasons.push('Other dependency or lockfile metadata changes accompany the Models upgrade.');
    if (files.some(path => !['package.json', lockPath].includes(path))) reasons.push('The consumer PR also changes files outside its dependency manifest and lockfile.');
  } else {
    const resolved = files.filter(path => path.endsWith('/Package.resolved'));
    if (resolved.length !== 1) throw new Error('Cannot identify one changed SPM lockfile');
    old = spmSnapshot(await content(api, repo, resolved[0], base), options.url);
    proposed = spmSnapshot(await content(api, repo, resolved[0], head), options.url);
    if (canonical(old.other) !== canonical(proposed.other)) reasons.push('Other SPM package pins changed; review those upgrades too.');
    const projects = files.filter(path => path.endsWith('/project.pbxproj'));
    if (projects.length !== 1) throw new Error('Cannot identify one changed Xcode project');
    const before = projectWithoutModelsVersion(await content(api, repo, projects[0], base), options.url);
    const after = projectWithoutModelsVersion(await content(api, repo, projects[0], head), options.url);
    if (before !== after) reasons.push('Other Xcode project changes accompany the Models version change.');
    if (files.some(path => ![resolved[0], projects[0]].includes(path))) reasons.push('The consumer PR also changes files outside its Models dependency pins.');
  }
  if (proposed.version !== options.target) throw new Error('Proposed dependency does not resolve to the requested Models version');
  if (compare(old.version, proposed.version) >= 0) reasons.push('The proposal is not a forward upgrade from the version currently resolved on main.');
  return {from: old.version, to: proposed.version, reasons};
}
async function sourceEvidence(api, repo, from, to) {
  const delta = await api('GET', `/repos/${repo}/compare/v${from}...v${to}`);
  const files = delta.files || [], commits = delta.commits || [];
  const reasons = [];
  const complete = ['ahead', 'identical'].includes(delta.status) && files.length < 300 && commits.length === delta.total_commits;
  if (!complete) reasons.push('Source history is divergent or incomplete; inspect the full Models comparison.');
  const messages = commits.map(c => c.commit.message);
  const breaking = messages.some(message => /^[\w-]+(?:\([^)]*\))?!:/m.test(message) || /BREAKING[ -]CHANGE:/i.test(message));
  const feature = messages.some(message => /^feat(?:\([^)]*\))?!?:/m.test(message));
  const internal = files.every(file => /^(?:\.github\/|\.agents\/|tests\/|scripts\/test[_-])/.test(file.filename) || /^(README\.md|CHANGELOG\.md|AGENTS\.md|CODEOWNERS|package\.json)$/.test(file.filename));
  if (breaking) reasons.push('Models commits explicitly declare a breaking change.');
  if (feature) reasons.push('Models commits include feature changes.');
  if (!internal) reasons.push('Models schema, generated types, rules, generator code or other non-internal files changed.');
  if (files.some(file => file.filename === 'package.json')) {
    const old = JSON.parse(await content(api, repo, 'package.json', `v${from}`)), next = JSON.parse(await content(api, repo, 'package.json', `v${to}`));
    delete old.version; delete next.version;
    if (canonical(old) !== canonical(next)) reasons.push('Models package metadata or dependencies changed beyond the version.');
  }
  return {complete, breaking, feature, internal, reasons, files: files.map(f => f.filename), commits: messages.map(m => m.split('\n')[0]), url: `https://github.com/${repo}/compare/v${from}...v${to}`};
}
async function assess(api, repo, base, head, files, options) {
  const result = {base, head, files, reasons: [], source: null, from: null, to: options.target, coverage: false};
  try {
    const consumer = await consumerEvidence(api, repo, base, head, files, options);
    Object.assign(result, {from: consumer.from, to: consumer.to}); result.reasons.push(...consumer.reasons);
    result.source = await sourceEvidence(api, packageRepo(options.url), result.from, result.to);
    result.reasons.push(...result.source.reasons);
    result.coverage = result.source.complete && compare(result.from, result.to) < 0;
  } catch (error) { result.reasons.push(`Assessment incomplete: ${error.message}.`); }
  result.safe = result.coverage && result.reasons.length === 0;
  return result;
}
function assessmentBody(result) {
  const label = result.safe ? '**Internal-only — safe for routine merge once required CI passes.**' : result.source?.breaking ? '**Breaking upgrade — review required.**' : result.source?.feature || result.source?.internal === false ? '**Model/API or feature upgrade — review required.**' : '**Uncertain or additional dependency changes — review required.**';
  return `${START}\n### Models upgrade assessment\n${label}\n\nCompared the Models version resolved on consumer \`main\` (${result.from || 'unknown'}) with the proposed version (${result.to}). This assesses cumulative package changes, not only the latest release or the consumer's version-number diff.\n\n${result.source ? `[Models source comparison](${result.source.url})\n\nModels files changed:\n${result.source.files.slice(0, 40).map(path => `- \`${path}\``).join('\n') || '- None.'}\n\nModels commit subjects:\n${result.source.commits.slice(0, 40).map(message => `- ${message.replace(/[<>]/g, '')}`).join('\n') || '- None.'}\n` : 'Models source comparison unavailable.\n'}\n${result.reasons.length ? result.reasons.map(reason => `- ${reason}`).join('\n') : 'No model schema, generated API, runtime/rules or unrelated dependency changes were found in the inspected comparisons.'}\n\nSnapshot: main \`${result.base}\`; PR head \`${result.head}\`. Required CI and ordinary review/merge rules still apply. Reassess if either ref changes. No automatic merge.\n${END}`;
}
function withAssessment(body, result) {
  const block = assessmentBody(result);
  const start = body.indexOf(START), end = body.indexOf(END);
  if (start >= 0 && end > start) return body.slice(0, start) + block + body.slice(end + END.length);
  return `${block}\n\n${body}`;
}
function managed(pr, options, consumerRepo) {
  const prefix = options.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${prefix}(\\d+\\.\\d+\\.\\d+)(?:-\\d+){0,2}$`).exec(pr.head?.ref || '');
  return Boolean(match && pr.user?.login === BOT && pr.base?.ref === options.base && pr.head?.repo?.full_name?.toLowerCase() === consumerRepo.toLowerCase() && /^Auto-generated by (?:SAP|CIP)[ -]?[Mm]odels? CI\./m.test(pr.body || ''));
}
function prVersion(pr, options) { return pr.head.ref.slice(options.prefix.length).match(/^\d+\.\d+\.\d+/)[0]; }
async function all(api, path) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    rows.push(...data); if (data.length < 100) return rows;
  }
}
async function assessPR(api, repo, pr, options) {
  const files = await all(api, `/repos/${repo}/pulls/${pr.number}/files`);
  return assess(api, repo, pr.base.sha, pr.head.sha, files.map(f => f.filename), options);
}
async function supersede(api, repo, replacement, assessment, candidates, options) {
  const closed = [], kept = [];
  if (!assessment.coverage) return {closed, kept: ['Source coverage is unverified; older PRs were preserved.']};
  for (const candidate of candidates) {
    if (candidate.number === replacement.number || !managed(candidate, options, repo) || compare(prVersion(candidate, options), options.target) > 0) continue;
    // Re-fetch before every destructive action; preserve human source edits AND discussion.
    const old = await api('GET', `/repos/${repo}/pulls/${candidate.number}`);
    if (old.state !== 'open' || !managed(old, options, repo)) continue;
    const commits = await all(api, `/repos/${repo}/pulls/${old.number}/commits`);
    const comments = await all(api, `/repos/${repo}/issues/${old.number}/comments`);
    const reviews = await all(api, `/repos/${repo}/pulls/${old.number}/reviews`);
    const inline = await all(api, `/repos/${repo}/pulls/${old.number}/comments`);
    const human = [...comments, ...reviews, ...inline].some(item => item.user?.type !== 'Bot');
    const edited = commits.some(commit => commit.author?.login !== BOT || commit.committer?.login !== BOT);
    if (human || edited) { kept.push(`#${old.number}: human edits or discussion require manual reconciliation.`); continue; }
    const oldAssessment = await assessPR(api, repo, old, {...options, target: prVersion(old, options)});
    if (oldAssessment.from !== assessment.from || oldAssessment.reasons.some(reason => /consumer|Other |Assessment incomplete/.test(reason))) { kept.push(`#${old.number}: consumer changes or baseline could not be safely superseded.`); continue; }
    const coverage = await api('GET', `/repos/${packageRepo(options.url)}/compare/v${prVersion(old, options)}...v${options.target}`);
    if (!['ahead', 'identical'].includes(coverage.status)) { kept.push(`#${old.number}: replacement does not contain the older Models release.`); continue; }
    // A failed/stale replacement must never cause the older PR to be closed.
    const current = await api('GET', `/repos/${repo}/pulls/${replacement.number}`);
    if (current.state !== 'open' || current.head.sha !== assessment.head || current.base.sha !== assessment.base) throw new Error('Replacement changed; older PRs preserved');
    const unchanged = await api('GET', `/repos/${repo}/pulls/${old.number}`);
    if (unchanged.state !== 'open' || unchanged.head.sha !== old.head.sha || unchanged.base.sha !== old.base.sha || unchanged.body !== old.body || unchanged.updated_at !== old.updated_at) {
      kept.push(`#${old.number}: changed during assessment; preserved for reconciliation.`); continue;
    }
    await api('PATCH', `/repos/${repo}/pulls/${old.number}`, {state: 'closed', body: `${old.body || ''}\n\nSuperseded by ${replacement.html_url}; the replacement covers the upgrade from the same current main baseline. This PR and its discussion are retained for reference.`});
    closed.push(old);
  }
  return {closed, kept};
}
async function finish(api, repo, pr, candidates, options) {
  const assessment = await assessPR(api, repo, pr, options);
  await api('PATCH', `/repos/${repo}/pulls/${pr.number}`, {body: withAssessment(pr.body || '', assessment)});
  const outcome = await supersede(api, repo, pr, assessment, candidates, options);
  if (outcome.closed.length || outcome.kept.length) {
    const fresh = await api('GET', `/repos/${repo}/pulls/${pr.number}`);
    const context = `\n\n### Supersession\n${outcome.closed.map(old => `- Supersedes [#${old.number}](${old.html_url}); its complete discussion remains available there.`).join('\n')}\n${outcome.kept.map(reason => `- Preserved ${reason}`).join('\n')}`;
    await api('PATCH', `/repos/${repo}/pulls/${pr.number}`, {body: fresh.body + context});
  }
  return {assessment, outcome};
}

module.exports = {BOT, version, compare, packageRepo, npmSnapshot, spmSnapshot, projectWithoutModelsVersion, consumerEvidence, sourceEvidence, assess, assessmentBody, withAssessment, managed, prVersion, all, assessPR, supersede, finish};
