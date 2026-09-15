const crypto = require('node:crypto');

// These are public website content files, not client feature releases.
const WEBSITES = {
  'VeamStudios/siteauditpro.com': [
    { path: 'src/app/content/changelogs/web/CHANGELOG.md', label: 'Web App', repository: 'VeamStudios/SiteAuditPro-Web', sourcePath: 'CHANGELOG.md' },
    { path: 'src/app/content/changelogs/ios/CHANGELOG.md', label: 'iOS App', repository: 'VeamStudios/SiteAuditPro-iOS', sourcePath: 'CHANGELOG.md' },
    { path: 'src/app/content/changelogs/android/changelog.md', label: 'Android App' },
  ],
  'VeamStudios/checklistinspectorpro.com': [
    { path: 'src/assets/changelog-web/CHANGELOG.md', label: 'Web App', repository: 'VeamStudios/ChecklistInspectorPro-Web', sourcePath: 'CHANGELOG.md' },
    { path: 'src/assets/changelog-ios/CHANGELOG.md', label: 'iOS App', repository: 'VeamStudios/ChecklistInspectorPro-iOS', sourcePath: 'CHANGELOG.md' },
  ],
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const content = (git, ref, path) => { try { return git('show', `${ref}:${path}`); } catch { return ''; } };

function sections(raw) {
  const result = new Map();
  let version;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^##\s+(?:\[)?v?(\d+\.\d+(?:\.\d+)*)(?:\])?(?:\s.*)?$/);
    if (match) { version = match[1]; result.set(version, []); }
    else if (/^##\s/.test(line)) version = undefined;
    if (version) result.get(version).push(line.trimEnd());
  }
  return new Map([...result].map(([version, lines]) => [version, lines.join('\n').trim()]));
}

function changedVersions(before, after) {
  const old = sections(before), next = sections(after);
  return [...new Set([...next.keys(), ...old.keys()])].filter(version => old.get(version) !== next.get(version));
}

// Legacy syncs did not carry trailers. Accept only the registered bot, one
// registered destination file, and bytes matching that source's exact version.
// This does not exempt other bot commits or assert client feature availability.
async function verifiedSync(repo, commit, gh, git) {
  const paths = git('diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n').filter(Boolean);
  if (paths.length !== 1) return null;
  const file = (WEBSITES[repo] || []).find(file => file.path === paths[0] && file.repository);
  if (!file) return null;
  const metadata = await gh(`/repos/${repo}/commits/${commit}`);
  if (metadata.author?.login !== 'veamstudios-release-bot[bot]' || metadata.author?.type !== 'Bot') return null;
  const message = metadata.commit?.message || '';
  const version = message.match(/^Update changelog for (v?\d+\.\d+(?:\.\d+)*)\s*$/m)?.[1];
  if (!version) return null;
  const trailer = name => message.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];
  const sourceCommit = trailer('Release-Source-Commit');
  if (sourceCommit && (!/^[a-f0-9]{40}$/.test(sourceCommit) || trailer('Release-Source-Repository') !== file.repository || trailer('Release-Source-Path') !== file.sourcePath)) return null;
  let source;
  try { source = await gh(`/repos/${file.repository}/commits/${encodeURIComponent(sourceCommit || version)}`); }
  catch (error) { if (error.status === 404 || /HTTP 404/.test(error.message)) return null; throw error; }
  if (!/^[a-f0-9]{40}$/.test(source.sha)) return null;
  const remote = await gh(`/repos/${file.repository}/contents/${file.sourcePath}?ref=${source.sha}`);
  if (remote.encoding !== 'base64' || typeof remote.content !== 'string') return null;
  if (Buffer.from(remote.content, 'base64').toString('utf8').trim() !== content(git, commit, file.path).trim()) return null;
  return { commit, path: file.path, repository: file.repository, sourceCommit: source.sha, version, evidence: `https://github.com/${repo}/commit/${commit}` };
}

function websiteChanges(config, baseline, sha, contexts, syncs, git) {
  const changes = [];
  for (const file of WEBSITES[config.repo] || []) {
    const before = content(git, baseline, file.path), after = content(git, sha, file.path);
    if (before === after) continue;
    const versions = changedVersions(before, after);
    const commits = git('log', '--format=%H', `${baseline}..${sha}`, '--', file.path).split('\n').filter(Boolean);
    const sources = contexts.filter(context => context.files.some(changed => changed.filename === file.path));
    const approvals = sources.filter(source => source.approved);
    const evidence = commits.map(commit => syncs.find(sync => sync.commit === commit)?.evidence || approvals.find(source => source.commits.includes(commit))?.pr.html_url);
    const approved = commits.length > 0 && evidence.every(Boolean);
    for (const version of versions.length ? versions : ['']) {
      const summary = `Updated changelog for ${file.label}${version ? ` Release ${version}` : ''}`;
      const id = digest({ repository: config.repo, path: file.path, version, content: sections(after).get(version) || after });
      const sourcePrs = sources.map(source => source.pr.number).sort((a,b) => a-b);
      changes.push({ id, kind: 'fix', summary, heading: 'Updated', sourceVersion: version, audience: 'Visitors to the marketing website', limitations: '', scope: `website-changelog-${id.slice(0,24)}`, targets: ['website'], audienceGate: false, requiredReleaseKeys: [], workItems: [], pr: sourcePrs[0] || 0, noteHash: digest({summary,sourcePrs}), approved, reviewEvidence: approved ? evidence[0] : '', blocked: approved ? [] : ['Website changelog update needs reviewed source or a verified release-bot sync.'], flagKeys: [], gateKeys: [], sourcePrs });
    }
  }
  return changes;
}

module.exports = { WEBSITES, changedVersions, verifiedSync, websiteChanges };
