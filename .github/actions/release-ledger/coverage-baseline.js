'use strict';

// Pure SAP consumer pilot. The caller must collect this envelope in trusted
// base/shared automation. Hashes detect inconsistency; they do not authenticate
// an envelope supplied by PR code. Nothing in this module reads files, runs PR
// code, fetches services, or uses credentials.
//
// Normalized snapshot (native Notion properties are kept to avoid lossy folds):
// {
//   schemaVersion: 1, repository, target: 'ios-consumer', inspectedAt: ISODate,
//   transport: {
//     kind: 'notion-release-ledger', dataSourceId: UUID, repository, target,
//     complete: true, truncated: false, selectedReleaseId: UUID,
//     pages: [{cursor: null, nextCursor: null, hasMore: false,
//              rows: [{id: UUID, properties: {...}}]}]
//   },
//   frozenManifest: {...}, manifestHash: SHA256,
//   source: {repository, path: 'CHANGELOG.md', commit: SHA1,
//            blob: GitBlobSHA1, text: exactDecodedUTF8}
// }
// Pages must contain the complete query, including ineligible release rows.
// Cursor chains, row identity, all frozen hashes, the selected public build and
// the exact Git blob are validated. The source commit need not be an ancestor
// of main: verified iOS releases can contain cherry-picks.

const crypto = require('node:crypto');
const {hash, text} = require('./record');
const {effectiveObservation} = require('./ledger-columns');
const {publicObservation} = require('./ios-website-source');
const {identity} = require('./changelog');
const {parseWorkItemLinks} = require('./work-item-links');

const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const TARGET = 'ios-consumer';
const BUNDLE = 'com.veamstudios.iaudit';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const validated = new WeakSet();

class CoverageBaselineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoverageBaselineError';
    this.code = code;
    this.details = details;
  }
}
function requireInput(condition, code, message, details) {
  if (!condition) throw new CoverageBaselineError(code, message, details);
}
const normalized = value => value.replace(/\s+/g, ' ').trim();
const ref = (startLine, endLine = startLine) => ({path: 'CHANGELOG.md', startLine, endLine});
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function versionParts(version, legacy = false) {
  const pattern = legacy ? /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/i : /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/i;
  requireInput(typeof version === 'string' && pattern.test(version), 'invalid_version', 'An exact supported changelog/release version is required.');
  const parts = version.replace(/^v/i, '').split('.').map(Number);
  requireInput(parts.every(Number.isSafeInteger), 'invalid_version', 'Release version contains an unsupported numeric component.');
  if (parts.length === 2) parts.push(0);
  return parts;
}
function compareVersions(a, b) {
  const left = versionParts(a, true), right = versionParts(b, true);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function timestamp(value, label) {
  const at = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  requireInput(Number.isFinite(at), 'invalid_timestamp', `${label} timestamp is missing or invalid.`);
  return at;
}
function fresh(value, now, maxAgeMs, label) {
  const at = timestamp(value, label);
  requireInput(at <= now + CLOCK_SKEW_MS && now - at <= maxAgeMs, 'stale_baseline', `${label} is stale or in the future; collect a fresh release baseline.`);
  return at;
}
function gitBlobHash(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function parseReferences(summary, location) {
  const workItems = [], prRefs = [];
  const urls = [...summary.matchAll(/https:\/\/[^\s)<>]+/g)].map(match => match[0].replace(/[.,;]+$/, ''));
  for (const raw of urls) {
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (/^(?:[a-z0-9-]+\.)?notion\.(?:so|site|com)$/i.test(url.hostname)) {
      const parsed = parseWorkItemLinks(`Work Items:\n- ${raw}`);
      requireInput(!parsed.invalidEntries.length, 'invalid_source_mapping', 'A changelog Work Item link is malformed; use its normal Notion page URL.', {ref: location});
      for (const id of parsed.ids) if (!workItems.includes(id)) workItems.push(id);
    }
    if (url.hostname.toLowerCase() === 'github.com' && url.pathname.includes('/pull/')) {
      const match = url.pathname.match(/^\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/i);
      requireInput(match && !url.username && !url.password && !url.port && Number.isSafeInteger(Number(match[2])), 'invalid_source_mapping', 'A changelog source PR link is malformed; use the normal GitHub pull request URL.', {ref: location});
      const value = {repository: match[1], number: Number(match[2])};
      if (!prRefs.some(existing => existing.repository === value.repository && existing.number === value.number)) prRefs.push(value);
    }
  }
  return {workItems: workItems.sort(), prRefs};
}

// The legacy rendering parser intentionally tolerates ignored text. Assessment
// must instead account for every nonblank source line and retain real ranges.
function parseChangelog(content) {
  requireInput(typeof content === 'string' && content.trim(), 'missing_changelog', 'CHANGELOG.md is missing or empty; changelog coverage could not be assessed.');
  requireInput(Buffer.byteLength(content, 'utf8') <= MAX_TEXT_BYTES && !content.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content), 'invalid_changelog', 'CHANGELOG.md exceeds the supported input size or is not complete UTF-8 text.');
  const lines = content.split(/\r?\n/), sections = [], entries = [];
  let section, heading = '', entry;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], location = ref(i + 1);
    if (!line.trim()) continue;
    const versionHeading = line.match(/^##\s+(?:\[([^\]]+)\]|([^\s]+))(?:\s+-\s+(\d{4}-\d\d-\d\d))?\s*$/);
    if (versionHeading) {
      const raw = versionHeading[1] || versionHeading[2];
      let version;
      try { version = /^unreleased$/i.test(raw) ? 'Unreleased' : versionParts(raw, true).join('.'); }
      catch (error) { if (error instanceof CoverageBaselineError) error.details.ref = location; throw error; }
      requireInput(!sections.some(prior => prior.version === version), 'duplicate_version', 'CHANGELOG.md contains duplicate release sections.', {ref: location, version});
      if (versionHeading[3]) {
        const date = new Date(`${versionHeading[3]}T00:00:00Z`);
        requireInput(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === versionHeading[3], 'invalid_changelog', 'Changelog release date is invalid.', {ref: location});
      }
      if (section) section.endLine = i;
      section = {version, displayedVersion: raw.replace(/^v/i, ''), startLine: i + 1, endLine: lines.length, entries: [], headings: []};
      sections.push(section); heading = ''; entry = null;
      continue;
    }
    requireInput(!/^##(?:\s|$)/.test(line), 'invalid_changelog', 'Changelog release heading is unsupported or malformed.', {ref: location});
    if (!section) {
      requireInput(/^#\s+\S/.test(line) || /^<!--[^\n]*-->\s*$/.test(line), 'invalid_changelog', 'Unexpected changelog text before the first release section.', {ref: location});
      continue;
    }
    const category = line.match(/^###\s+(.+?)\s*$/);
    if (category) {
      heading = category[1];
      requireInput(!section.headings.some(prior => prior.name.toLowerCase() === heading.toLowerCase()), 'duplicate_heading', 'A release section contains duplicate changelog headings.', {ref: location});
      section.headings.push({name: heading, line: i + 1}); entry = null;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+?)\s*$/);
    if (bullet) {
      requireInput(Boolean(heading), 'invalid_changelog', 'A changelog bullet needs a category heading such as New, Fixed or Internal.', {ref: location});
      entry = {id: `CHANGELOG.md:${i + 1}`, version: section.version, heading, summary: bullet[1], flagKeys: [], previewTag: '', startLine: i + 1, endLine: i + 1};
      section.entries.push(entry); entries.push(entry);
      continue;
    }
    if (entry && /^\s+\S/.test(line) && !/^\s*(?:```|~~~|#{1,6}\s)/.test(line)) {
      const metadata = line.match(/^\s+(rcValue|previewTag):\s*(.*?)\s*$/);
      if (metadata) {
        requireInput(Boolean(metadata[2]), 'invalid_changelog', 'Changelog release metadata is empty.', {ref: location});
        if (metadata[1] === 'rcValue') entry.flagKeys.push(metadata[2]);
        else {
          requireInput(!entry.previewTag, 'invalid_changelog', 'A changelog entry contains duplicate previewTag metadata.', {ref: location});
          entry.previewTag = metadata[2];
        }
      } else entry.summary += `\n${line.trim()}`;
      entry.endLine = i + 1;
      continue;
    }
    throw new CoverageBaselineError('invalid_changelog', 'Unsupported changelog content would be omitted from assessment; use a heading, bullet or indented continuation.', {ref: location});
  }
  requireInput(sections.length > 0, 'invalid_changelog', 'CHANGELOG.md has no supported release sections.');
  for (let i = 0; i < sections.length; i++) {
    const current = sections[i], previous = sections[i - 1];
    requireInput(current.version !== 'Unreleased' || i === 0, 'invalid_changelog', 'Unreleased must be the first changelog section.', {ref: ref(current.startLine)});
    if (previous && previous.version !== 'Unreleased') requireInput(compareVersions(previous.version, current.version) > 0, 'invalid_changelog', 'Changelog releases must be ordered newest to oldest.', {ref: ref(current.startLine)});
    for (const category of current.headings) requireInput(current.entries.some(item => item.heading === category.name), 'invalid_changelog', 'A changelog category has no entries.', {ref: ref(category.line)});
    requireInput(current.entries.length > 0 || current.version === 'Unreleased', 'invalid_changelog', 'A numbered changelog release has no entries.', {ref: ref(current.startLine)});
    current.ref = ref(current.startLine, current.endLine);
  }
  for (const item of entries) {
    item.ref = ref(item.startLine, item.endLine);
    Object.assign(item, parseReferences(item.summary, item.ref));
  }
  return {sections, entries};
}

function readFrozenRow(row, repository, target) {
  requireInput(row && UUID.test(row.id || '') && row.properties && typeof row.properties === 'object', 'incomplete_baseline', 'A release query row is missing its identity/properties.');
  const properties = row.properties;
  let manifest;
  try { manifest = JSON.parse(text(properties.Manifest)); } catch { throw new CoverageBaselineError('invalid_manifest', 'A queried release has an unreadable frozen Manifest.', {releaseId: row.id}); }
  requireInput(manifest && [1, 2].includes(manifest.schemaVersion) && manifest.repository === repository && manifest.target === target && SHA.test(manifest.commit || '') && typeof manifest.version === 'string' && ['release', 'baseline', 'activation', 'withdrawal'].includes(manifest.event) && manifest.key === `${repository}/${target}/${manifest.event}/${manifest.version}`, 'invalid_manifest', 'Frozen release identity/source does not match the supported queried repository and target.', {releaseId: row.id});
  const manifestHash = text(properties['Manifest Hash']);
  requireInput(HASH.test(manifestHash) && hash(manifest) === manifestHash, 'invalid_manifest_hash', 'Frozen release Manifest hash does not match; collect intact source evidence.', {releaseId: row.id});
  let folded;
  try {
    for (const [name, owner] of [['Deploy Observation', 'deploy'], ['App Store Observation', 'store'], ['Play Observation', 'play']]) {
      const raw = text(properties[name]);
      if (!raw) continue;
      const record = JSON.parse(raw);
      requireInput(record.owner === owner && record.observation && typeof record.observation === 'object' && Number.isFinite(Date.parse(record.recordedAt)), 'invalid_observation', 'An owned release observation has invalid ownership, content or time.', {releaseId: row.id});
    }
    folded = effectiveObservation(properties);
  } catch (error) {
    if (error instanceof CoverageBaselineError) throw error;
    throw new CoverageBaselineError('invalid_observation', 'An owned release observation is unreadable; no cached display value is substituted.', {releaseId: row.id});
  }
  return {id: row.id, manifest, manifestHash, properties, folded};
}

function validateBaseline(snapshot, {repository = REPOSITORY, target = TARGET, now = Date.now(), maxAgeMs = MAX_AGE_MS} = {}) {
  requireInput(repository === REPOSITORY && target === TARGET, 'unsupported_scope', 'This baseline pilot supports SAP iOS consumer only. Consumer evidence cannot establish Enterprise distribution.');
  requireInput(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= MAX_AGE_MS, 'invalid_freshness', 'Baseline freshness must be positive and no longer than the existing two-hour App Store evidence window.');
  const time = timestamp(now, 'Assessment');
  requireInput(snapshot && snapshot.schemaVersion === 1 && snapshot.repository === repository && snapshot.target === target, 'incomplete_baseline', 'A trusted complete SAP consumer baseline snapshot is required.');
  const inspected = fresh(snapshot.inspectedAt, time, maxAgeMs, 'Release baseline inspection');
  const transport = snapshot.transport;
  requireInput(transport && transport.kind === 'notion-release-ledger' && UUID.test(transport.dataSourceId || '') && transport.repository === repository && transport.target === target && transport.complete === true && transport.truncated === false, 'incomplete_baseline', 'Release baseline transport is missing complete, untruncated repository/target evidence.');
  requireInput(Array.isArray(transport.pages) && transport.pages.length > 0 && transport.pages.length <= 10000, 'incomplete_baseline', 'Complete release-query pagination evidence is required.');
  const rows = [], seenRows = new Set(), seenCursors = new Set();
  let expectedCursor = null;
  for (let index = 0; index < transport.pages.length; index++) {
    const page = transport.pages[index], last = index === transport.pages.length - 1;
    requireInput(page && page.cursor === expectedCursor && typeof page.hasMore === 'boolean' && Array.isArray(page.rows) && page.rows.length <= 100, 'incomplete_baseline', 'Release-query pages have missing, repeated or inconsistent cursor evidence.');
    requireInput(page.hasMore === !last && (last ? page.nextCursor === null : typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && !seenCursors.has(page.nextCursor)), 'incomplete_baseline', 'Release-query pagination did not reach an unambiguous final page.');
    if (page.nextCursor) seenCursors.add(page.nextCursor);
    expectedCursor = page.nextCursor;
    for (const row of page.rows) {
      requireInput(!seenRows.has(row?.id?.toLowerCase()), 'incomplete_baseline', 'Release-query pagination contains a duplicate row.');
      const parsed = readFrozenRow(row, repository, target);
      seenRows.add(parsed.id.toLowerCase()); rows.push(parsed);
    }
  }
  requireInput(rows.length > 0 && UUID.test(transport.selectedReleaseId || ''), 'incomplete_baseline', 'No selected release was supplied in the complete release query.');
  const selected = rows.find(row => row.id.toLowerCase() === transport.selectedReleaseId.toLowerCase());
  requireInput(Boolean(selected), 'incomplete_baseline', 'The selected release is absent from the complete release query.');
  const manifest = selected.manifest;
  requireInput(manifest.schemaVersion === 2 && manifest.event === 'release' && typeof manifest.build === 'string' && manifest.build.trim() && manifest.key === `${repository}/${target}/release/${manifest.version}`, 'unverified_baseline', 'The selected source is not an exact frozen production release; tags, uploads and internal checkpoint notes cannot supply it.');
  const version = versionParts(manifest.version).join('.');
  requireInput(snapshot.frozenManifest && hash(snapshot.frozenManifest) === selected.manifestHash && snapshot.manifestHash === selected.manifestHash, 'invalid_manifest_hash', 'Selected snapshot Manifest/hash differs from the queried frozen release.');
  const folded = selected.folded, observation = folded?.observation;
  requireInput(folded?.owner === 'store' && publicObservation(observation, manifest, BUNDLE, time), 'unverified_baseline', 'No fresh exact publicly downloadable App Store build/source was verified for the selected release.');
  const verification = observation.verification;
  const checked = fresh(verification.checkedAt, time, maxAgeMs, 'App Store build verification');
  const recorded = fresh(folded.observedAt, time, maxAgeMs, 'Store-owned observation');
  requireInput(checked <= inspected + CLOCK_SKEW_MS && recorded <= inspected + CLOCK_SKEW_MS, 'invalid_observation', 'Store evidence is newer than the baseline inspection envelope.');
  requireInput(observation.verificationStatus === undefined, 'unverified_baseline', 'Selected release has unresolved or terminal verification status; it is not current public source evidence.');
  // Validate the whole query rather than silently selecting an older release
  // when a newer public/withdrawn source is stale, held or unreadable. Uploads
  // and prepare-only releases remain future; ordinary older rows are history.
  for (const row of rows) {
    if (row.manifest.event !== 'release') continue;
    const otherVersion = versionParts(row.manifest.version).join('.');
    if (row.id === selected.id) continue;
    const phase = row.folded?.observation?.phase;
    const relation = compareVersions(otherVersion, version);
    const otherPublic = row.manifest.schemaVersion === 2 && row.folded?.owner === 'store' && publicObservation(row.folded.observation, row.manifest, BUNDLE, time);
    requireInput(!(relation === 0 && otherPublic), 'ambiguous_baseline', 'Several exact public release records share the selected version.');
    requireInput(!(relation > 0 && !['prepare', 'uploaded'].includes(phase)), 'ambiguous_baseline', 'A newer recorded release lacks reconciled public/shipped history; do not fall back to an older baseline.', {releaseId: row.id});
  }
  const source = snapshot.source;
  requireInput(source && source.repository === repository && source.path === 'CHANGELOG.md' && source.commit === manifest.commit && SHA.test(source.blob || '') && typeof source.text === 'string', 'missing_source', 'Exact frozen-source CHANGELOG.md content and Git blob identity are required.');
  requireInput(gitBlobHash(source.text) === source.blob, 'invalid_blob_hash', 'Source changelog text differs from its exact Git blob; no shortened or normalized content can supply the baseline.');
  const parsed = parseChangelog(source.text);
  requireInput(parsed.sections.some(section => section.version === version), 'missing_source_version', 'Verified shipped version is absent from its frozen-source CHANGELOG.md.');
  const shippedSections = parsed.sections.filter(section => section.version !== 'Unreleased' && compareVersions(section.version, version) <= 0);
  const shippedEntries = shippedSections.flatMap(section => section.entries);
  const futureEntries = parsed.sections.filter(section => !shippedSections.includes(section)).flatMap(section => section.entries);
  const baseline = deepFreeze({repository, target, version, build: manifest.build, commit: manifest.commit, blob: source.blob, manifestHash: selected.manifestHash, releaseId: selected.id, inspectedAt: snapshot.inspectedAt, verification: structuredClone(verification), sourceText: source.text, sections: parsed.sections, shippedSections, shippedEntries, futureEntries, scopeLimitations: ['Consumer baseline only; Enterprise release history is not established.']});
  validated.add(baseline);
  return baseline;
}

function sectionSignature(section) {
  return hash({headings: section.headings.map(item => item.name), entries: section.entries.map(item => ({heading: item.heading, summary: normalized(item.summary), flagKeys: item.flagKeys, previewTag: item.previewTag, workItems: item.workItems, prRefs: item.prRefs}))});
}
function eligibleEntries(headChangelog, baseline) {
  requireInput(baseline && validated.has(baseline), 'unvalidated_baseline', 'Validate the complete release baseline before selecting eligible entries.');
  const head = parseChangelog(headChangelog), publishedHistoryChanges = [];
  for (const prior of baseline.shippedSections) {
    const present = head.sections.find(section => section.version === prior.version);
    if (!present || sectionSignature(prior) !== sectionSignature(present)) publishedHistoryChanges.push({version: prior.version, reason: present ? 'Published changelog section was edited.' : 'Published changelog section was removed or moved.', ref: present?.ref || prior.ref});
  }
  requireInput(publishedHistoryChanges.length === 0, 'published_history_changed', 'Published changelog history changed. Refresh a stale branch first; preserve shipped notes and use the separately reviewed process for an intentional correction.', {publishedHistoryChanges});
  const old = baseline.shippedEntries.slice(), matched = new Set();
  // Preserve duplicate occurrence counts and match exact versions first. A
  // section move/link-only edit must never turn a shipped note into new coverage.
  for (const exactVersion of [true, false]) for (let index = 0; index < head.entries.length; index++) {
    if (matched.has(index)) continue;
    const item = head.entries[index];
    const oldIndex = old.findIndex(prior => prior && identity(prior) === identity(item) && (!exactVersion || prior.version === item.version));
    if (oldIndex !== -1) { old[oldIndex] = null; matched.add(index); }
  }
  const entries = [], excludedEntries = [];
  for (let index = 0; index < head.entries.length; index++) {
    const item = head.entries[index];
    const upcoming = item.version === 'Unreleased' || compareVersions(item.version, baseline.version) > 0;
    if (upcoming && !matched.has(index)) entries.push(item);
    else excludedEntries.push({...item, reason: matched.has(index) ? 'Already shipped note occurrence.' : 'Entry is in a published release section.'});
  }
  return {entries, excludedEntries, publishedHistoryChanges, reviewNotes: baseline.scopeLimitations.slice()};
}

module.exports = {validateBaseline, eligibleEntries, CoverageBaselineError};
