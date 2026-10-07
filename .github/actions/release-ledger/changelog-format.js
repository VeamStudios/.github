'use strict';

const {parseWorkItemLinks} = require('./work-item-links');

// Deterministic syntax validation only. This does not decide whether a code
// change needs a note, whether an entry covers it, or which versions shipped.
// Links are checked locally; their existence and ownership are not verified.
// No category vocabulary or source-link requirement is imposed on entries.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 50000;
const NOTION_HOST = /^(?:[a-z0-9-]+\.)?notion\.(?:so|site|com)$/i;
const PAGE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const location = (startLine, endLine = startLine) => ({path: 'CHANGELOG.md', startLine, endLine});

class ChangelogFormatError extends Error {
  constructor(message, {rule, ref = location(1)} = {}) {
    super(message);
    this.name = 'ChangelogFormatError';
    this.code = 'invalid_changelog';
    this.details = {rule, ref};
  }
}

function requireFormat(condition, rule, message, ref) {
  if (!condition) throw new ChangelogFormatError(message, {rule, ref});
}

function versionParts(value, ref) {
  requireFormat(/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/i.test(value), 'version', 'Use a two- or three-part numeric release version, or Unreleased.', ref);
  const parts = value.replace(/^v/i, '').split('.').map(Number);
  requireFormat(parts.every(Number.isSafeInteger), 'version', 'A release version contains an unsupported numeric component.', ref);
  if (parts.length === 2) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function normalUrl(raw, ref) {
  let url;
  try { url = new URL(raw); } catch {}
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
  requireFormat(url && authority && !/[\s\\<>]/.test(raw) && url.protocol === 'https:' && !url.username && !url.password && !url.port && !/[@:%]/.test(authority), 'source_url', 'Use a normal HTTPS source URL without credentials, an explicit port or an encoded hostname.', ref);
  return url;
}

function workItemUrl(raw, ref) {
  const url = normalUrl(raw, ref);
  requireFormat(NOTION_HOST.test(url.hostname), 'work_item_link', 'A Work Item link must use its normal Notion page URL.', ref);
  const segment = url.pathname.replace(/\/$/, '').split('/').at(-1);
  // The shared parser finds a trailing ID. Also check its boundary so a 33-
  // digit ID cannot be accepted as its last 32 digits. Slug-ID URLs are valid.
  const id = segment?.match(/(?:^|-)([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1];
  requireFormat(id && PAGE_ID.test(id), 'work_item_link', 'A Work Item link needs a complete 32-digit or hyphenated Notion page ID.', ref);
  const parsed = parseWorkItemLinks(`Work Items:\n- ${raw}`);
  requireFormat(parsed.invalidEntries.length === 0 && parsed.ids.length === 1, 'work_item_link', 'A Work Item link is malformed; use its normal Notion page URL.', ref);
  return parsed.ids[0];
}

function sourcePrUrl(raw, ref) {
  const url = normalUrl(raw, ref);
  const match = url.pathname.match(/^\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/i);
  requireFormat(url.hostname.toLowerCase() === 'github.com' && match && Number.isSafeInteger(Number(match[2])), 'source_pr_link', 'A source PR link must use https://github.com/owner/repository/pull/number with a positive integer PR number.', ref);
  return {repository: match[1], number: Number(match[2])};
}

function sourceLabel(label) {
  const value = label.trim().replace(/[*_`]/g, '').replace(/\s+/g, ' ').toLowerCase();
  if (/^(?:notion )?work ?items?$/.test(value)) return 'workItem';
  if (/^(?:source )?pr(?: (?:#\S*|\d+))?$/.test(value)) return 'pr';
  if (value === 'source') return 'source';
  return null;
}

function parseReferences(line, ref) {
  const workItems = new Set(), prRefs = new Map();
  const addWorkItem = id => workItems.add(id);
  const addPr = value => prRefs.set(`${value.repository}#${value.number}`, value);
  for (const match of line.matchAll(/\[([^\]\r\n]+)\]:/g)) {
    requireFormat(!sourceLabel(match[1]), 'source_link', 'Use an inline source URL instead of a source-labelled reference definition.', ref);
  }
  for (const match of line.matchAll(/\[([^\]\r\n]+)\][ \t]*\[/g)) {
    requireFormat(!sourceLabel(match[1]), 'source_link', 'Use an inline source link such as [PR](https://github.com/owner/repository/pull/number), rather than a reference-style link.', ref);
  }
  for (const match of line.matchAll(/\[([^\]\r\n]+)\][ \t]*\(/g)) {
    const kind = sourceLabel(match[1]);
    if (!kind) continue;
    requireFormat(!/\][ \t]+\($/.test(match[0]), 'source_link', 'Keep the source link label and URL adjacent, such as [PR](https://github.com/owner/repository/pull/number).', ref);
    const start = match.index + match[0].length;
    const end = line.indexOf(')', start);
    requireFormat(end !== -1, 'source_link', 'A source link has no closing parenthesis.', ref);
    const raw = line.slice(start, end);
    requireFormat(raw.length > 0 && !/\s/.test(raw), 'source_link', 'A source link needs a complete inline HTTPS URL.', ref);
    if (kind === 'workItem') addWorkItem(workItemUrl(raw, ref));
    else if (kind === 'pr') {
      const pr = sourcePrUrl(raw, ref);
      const label = match[1].trim().replace(/[*_`]/g, '').replace(/\s+/g, ' ');
      const number = label.match(/^(?:source )?pr #?(\S+)$/i)?.[1];
      requireFormat(number === undefined || (/^[1-9]\d*$/.test(number) && Number.isSafeInteger(Number(number)) && Number(number) === pr.number), 'source_pr_link', 'The number in a PR label must be a positive integer matching its source PR URL.', ref);
      addPr(pr);
    }
    else {
      const url = normalUrl(raw, ref);
      if (NOTION_HOST.test(url.hostname)) addWorkItem(workItemUrl(raw, ref));
      else addPr(sourcePrUrl(raw, ref));
    }
  }
  // Bare and differently labelled service URLs also retain their mappings.
  // Lookalike authorities are not silently dropped as unrelated prose links.
  for (const match of line.matchAll(/[a-z][a-z0-9+.-]*:[^\s<>()\[\]]+/gi)) {
    const raw = match[0].replace(/[.,;]+$/, '');
    let url;
    try { url = new URL(raw); } catch {}
    const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/*([^/?#]+)/i)?.[1] || '';
    const notion = NOTION_HOST.test(url?.hostname || '') || /notion\.(?:so|site|com)(?:[.@:/]|$)/i.test(authority);
    const githubPr = (url?.hostname.toLowerCase() === 'github.com' || /github\.com(?:[.@:/]|$)/i.test(authority)) && /\/pull(?:\/|$)/i.test(raw);
    if (notion) addWorkItem(workItemUrl(raw, ref));
    else if (githubPr) addPr(sourcePrUrl(raw, ref));
  }
  return {workItems: [...workItems], prRefs: [...prRefs.values()]};
}

/**
 * Validate complete CHANGELOG.md text and retain source line ranges.
 * Supported structure: optional title/single-line HTML comments, descending
 * unique ## versions (legacy two-part versions allowed), optional first
 * Unreleased, nonempty ### categories, and - or * bullets with indented text.
 * Existing rcValue/previewTag metadata is retained, never interpreted here.
 * Returns {sections, entries}; entries include ref, workItems and prRefs.
 */
function validateChangelog(text) {
  requireFormat(typeof text === 'string' && text.trim(), 'missing_changelog', 'CHANGELOG.md is missing or empty.');
  requireFormat(Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES && !text.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), 'input', 'CHANGELOG.md exceeds the supported size or contains invalid text.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), sections = [], entries = [], sourceLines = new Map();
  requireFormat(lines.length <= MAX_LINES, 'input', 'CHANGELOG.md exceeds the supported 50,000-line input limit.');
  const versions = new Set(), categoryNames = new Set(), populatedCategories = new Map();
  let section, heading = '', entry;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], ref = location(index + 1);
    if (!line.trim()) continue;
    const release = line.match(/^##\s+(?:\[([^\]]+)\]|([^\s]+))(?:\s+-\s+(\d{4}-\d\d-\d\d))?\s*$/);
    if (release) {
      const raw = release[1] || release[2];
      const version = /^unreleased$/i.test(raw) ? 'Unreleased' : versionParts(raw, ref).join('.');
      requireFormat(!versions.has(version), 'duplicate_version', 'CHANGELOG.md contains duplicate release versions.', ref);
      versions.add(version);
      if (release[3]) {
        const date = new Date(`${release[3]}T00:00:00Z`);
        requireFormat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === release[3], 'date', 'A changelog release date is invalid.', ref);
      }
      if (section) section.endLine = index;
      section = {version, displayedVersion: raw.replace(/^v/i, ''), startLine: index + 1, endLine: lines.length, entries: [], headings: []};
      sections.push(section); heading = ''; entry = null; categoryNames.clear();
      populatedCategories.set(section, new Set());
      continue;
    }
    requireFormat(!/^##(?:\s|$)/.test(line), 'version', 'A changelog release heading is malformed.', ref);
    if (!section) {
      requireFormat(/^#\s+\S/.test(line) || /^<!--[^\n]*-->\s*$/.test(line), 'structure', 'Unexpected text before the first changelog version.', ref);
      continue;
    }
    const category = line.match(/^###\s+(.+?)\s*$/);
    if (category) {
      heading = category[1].replace(/(?:^|\s+)#+\s*$/, '').trim();
      requireFormat(Boolean(heading), 'structure', 'A changelog category heading needs a name.', ref);
      requireFormat(!categoryNames.has(heading.toLowerCase()), 'duplicate_category', 'A release contains duplicate category headings.', ref);
      categoryNames.add(heading.toLowerCase());
      section.headings.push({name: heading, line: index + 1}); entry = null;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+?)\s*$/);
    if (bullet) {
      requireFormat(Boolean(heading), 'structure', 'A changelog bullet needs a category heading.', ref);
      entry = {id: `CHANGELOG.md:${index + 1}`, version: section.version, heading, summary: bullet[1], flagKeys: [], previewTag: '', startLine: index + 1, endLine: index + 1};
      section.entries.push(entry); entries.push(entry);
      populatedCategories.get(section).add(heading);
      sourceLines.set(entry, [{text: bullet[1], ref}]);
      continue;
    }
    if (entry && /^\s+\S/.test(line) && !/^\s*(?:```|~~~|#{1,6}\s)/.test(line)) {
      const metadata = line.match(/^\s+(rcValue|previewTag):\s*(.*?)\s*$/);
      if (metadata) {
        requireFormat(Boolean(metadata[2]), 'metadata', 'Changelog metadata is empty.', ref);
        if (metadata[1] === 'rcValue') entry.flagKeys.push(metadata[2]);
        else {
          requireFormat(!entry.previewTag, 'metadata', 'An entry contains duplicate previewTag metadata.', ref);
          entry.previewTag = metadata[2];
        }
      } else {
        entry.summary += `\n${line.trim()}`;
        sourceLines.get(entry).push({text: line.trim(), ref});
      }
      entry.endLine = index + 1;
      continue;
    }
    throw new ChangelogFormatError('Unsupported changelog text; use a version, category, bullet or indented continuation.', {rule: 'structure', ref});
  }
  requireFormat(sections.length > 0, 'structure', 'CHANGELOG.md has no supported version sections.');
  for (let index = 0; index < sections.length; index++) {
    const current = sections[index], previous = sections[index - 1];
    requireFormat(current.version !== 'Unreleased' || index === 0, 'version_order', 'Unreleased must be the first changelog section.', location(current.startLine));
    if (previous && previous.version !== 'Unreleased') requireFormat(compareVersions(previous.version, current.version) > 0, 'version_order', 'Changelog versions must be ordered newest to oldest.', location(current.startLine));
    for (const category of current.headings) requireFormat(populatedCategories.get(current).has(category.name), 'empty_category', 'A changelog category has no entries.', location(category.line));
    requireFormat(current.entries.length > 0 || current.version === 'Unreleased', 'empty_version', 'A numbered changelog version has no entries.', location(current.startLine));
    current.ref = location(current.startLine, current.endLine);
  }
  for (const item of entries) {
    item.ref = location(item.startLine, item.endLine);
    const workItems = new Set(), prRefs = new Map();
    for (const source of sourceLines.get(item)) {
      const parsed = parseReferences(source.text, source.ref);
      for (const id of parsed.workItems) workItems.add(id);
      for (const pr of parsed.prRefs) prRefs.set(`${pr.repository}#${pr.number}`, pr);
    }
    item.workItems = [...workItems].sort(); item.prRefs = [...prRefs.values()];
  }
  return {sections, entries};
}

module.exports = {ChangelogFormatError, validateChangelog};
