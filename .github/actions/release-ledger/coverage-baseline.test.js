'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {rich, hash} = require('./record');
const {validateBaseline, eligibleEntries, CoverageBaselineError} = require('./coverage-baseline');
const {makeSnapshot, makeReleaseRow, DEFAULT_SOURCE} = require('./fixtures/coverage-baseline/snapshot');

// All source, release, observation and Work Item data below is synthetic.
const REPO = 'VeamStudios/SiteAuditPro-iOS';
const NOW = '2026-10-07T12:00:00.000Z';
const CHECKED = '2026-10-07T11:59:00.000Z';
const RELEASE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE = DEFAULT_SOURCE;
const HISTORY = SOURCE.replace('# Synthetic app\n\n', '');
const options = {repository: REPO, target: 'ios-consumer', now: NOW};
const copy = value => structuredClone(value);
const row = args => makeReleaseRow({checkedAt: CHECKED, ...args});
const snapshot = (sourceText = SOURCE) => makeSnapshot({now: NOW, sourceText});
function editObservation(input, edit, index = 0) {
  const selected = input.transport.pages[0].rows[index];
  const record = JSON.parse(selected.properties['App Store Observation'].rich_text[0].text.content);
  edit(record);
  selected.properties['App Store Observation'] = rich(JSON.stringify(record));
}
function fails(input, code, opts = options) {
  assert.throws(() => validateBaseline(input, opts), error => error instanceof CoverageBaselineError && (!code || error.code === code));
}

test('validates frozen consumer source without ancestry inference or mutating supplied evidence', () => {
  const input = snapshot(), before = JSON.stringify(input);
  const result = validateBaseline(input, options);
  assert.equal(result.version, '1.0.0');
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(result.shippedEntries[0].summary, 'Retain saved drafts.');
  assert.equal(result.futureEntries.length, 0);
  assert.match(result.scopeLimitations[0], /Enterprise/);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(result.shippedEntries[0]));
});
test('checks the actual Git blob for Unicode, CRLF and final newline bytes', () => {
  const text = '# Synthetic app\r\n## 1.0.0\r\n### Fixed\r\n- Save café drafts 😀.\r\n';
  assert.equal(validateBaseline(snapshot(text), options).shippedEntries[0].summary, 'Save café drafts 😀.');
  for (const mutate of [s => s.source.text = s.source.text.replace(/\r\n/g, '\n'), s => s.source.text = s.source.text.trimEnd(), s => s.source.blob = 'b'.repeat(40)]) {
    const input = snapshot(text); mutate(input); fails(input, 'invalid_blob_hash');
  }
});
test('rejects a wrong source repository, path, commit, missing object or omitted text', () => {
  for (const mutate of [s => s.source.repository = 'VeamStudios/Other', s => s.source.path = 'notes.md', s => s.source.commit = 'b'.repeat(40), s => delete s.source.blob, s => delete s.source.text]) {
    const input = snapshot(); mutate(input); fails(input, 'missing_source');
  }
});
test('rejects tampered frozen hashes and a selected snapshot differing from native queried properties', () => {
  const invalidRow = snapshot(); invalidRow.transport.pages[0].rows[0].properties['Manifest Hash'] = rich('b'.repeat(64)); fails(invalidRow, 'invalid_manifest_hash');
  const invalidSelected = snapshot(); invalidSelected.frozenManifest.commit = 'b'.repeat(40); fails(invalidSelected, 'invalid_manifest_hash');
  const invalidEnvelope = snapshot(); invalidEnvelope.manifestHash = 'b'.repeat(64); fails(invalidEnvelope, 'invalid_manifest_hash');
});
test('canonical key reordering is accepted without weakening manifest identity', () => {
  const input = snapshot(); input.frozenManifest = Object.fromEntries(Object.entries(input.frozenManifest).reverse());
  assert.equal(validateBaseline(input, options).manifestHash, input.manifestHash);
});
test('checks every queried frozen row, including ineligible older releases', () => {
  const input = snapshot(), older = row({id: OTHER_ID, version: 'v0.9.0', commit: 'b'.repeat(40)});
  older.properties['Manifest Hash'] = rich('bad'); input.transport.pages[0].rows.push(older);
  fails(input, 'invalid_manifest_hash');
});
test('requires the correct SAP consumer scope and does not claim Enterprise history', () => {
  fails(snapshot(), 'unsupported_scope', {...options, target: 'ios-enterprise'});
  fails(snapshot(), 'unsupported_scope', {...options, repository: 'VeamStudios/ChecklistInspectorPro-iOS'});
  const input = snapshot(); input.transport.target = 'ios-enterprise'; fails(input, 'incomplete_baseline');
});
test('rejects omitted, truncated, unfinished, repeated or unselected transport input', () => {
  for (const mutate of [
    s => s.transport.complete = false, s => delete s.transport.complete,
    s => s.transport.truncated = true, s => delete s.transport.truncated,
    s => s.transport.pages = [], s => s.transport.pages[0].cursor = 'unread-page',
    s => s.transport.pages[0].hasMore = true,
    s => s.transport.pages[0].nextCursor = 'unread-page',
    s => s.transport.pages[0].rows.push(copy(s.transport.pages[0].rows[0])),
    s => s.transport.selectedReleaseId = OTHER_ID,
    s => s.transport.pages[0].rows = []
  ]) { const input = snapshot(); mutate(input); fails(input, 'incomplete_baseline'); }
});
test('accepts a complete multipage query and rejects missing/repeated cursor hops', () => {
  const input = snapshot();
  input.transport.pages[0].hasMore = true; input.transport.pages[0].nextCursor = 'page-two';
  input.transport.pages.push({cursor: 'page-two', nextCursor: null, hasMore: false, rows: [row({id: OTHER_ID, version: 'v0.9.0', commit: 'b'.repeat(40), checkedAt: '2026-01-01T00:00:00Z'})]});
  assert.equal(validateBaseline(input, options).releaseId, RELEASE_ID);
  for (const mutate of [s => s.transport.pages[1].cursor = 'wrong-hop', s => s.transport.pages[1].hasMore = true, s => s.transport.pages[1].nextCursor = 'page-two']) {
    const bad = copy(input); mutate(bad); fails(bad, 'incomplete_baseline');
  }
});
test('requires a fresh complete inspection and permits only a bounded freshness policy', () => {
  for (const inspectedAt of ['2026-10-07T09:59:59Z', '2026-10-07T12:01:01Z']) {
    const input = snapshot(); input.inspectedAt = inspectedAt; fails(input, 'stale_baseline');
  }
  for (const maxAgeMs of [0, -1, Infinity, 2 * 60 * 60 * 1000 + 1]) fails(snapshot(), 'invalid_freshness', {...options, maxAgeMs});
  fails(snapshot(), 'stale_baseline', {...options, now: '2026-10-07T12:02:01Z', maxAgeMs: 2 * 60 * 1000});
});
test('stale, future or failed exact store verification cannot supply a baseline', () => {
  for (const edit of [r => r.observation.verification.checkedAt = '2026-10-07T09:00:00Z', r => r.observation.verification.checkedAt = '2026-10-07T12:01:01Z', r => r.observation.verificationError = 'lookup failed', r => r.observation.verificationStatus = 'error']) {
    const input = snapshot(); editObservation(input, edit); fails(input, 'unverified_baseline');
  }
});
test('an old positive display Observation does not replace a store-owned withdrawal or malformed owned proof', () => {
  const input = snapshot(), properties = input.transport.pages[0].rows[0].properties;
  properties.Observation = rich(JSON.stringify(JSON.parse(properties['App Store Observation'].rich_text[0].text.content).observation));
  editObservation(input, r => r.observation.phase = 'withdrawn'); fails(input, 'unverified_baseline');
  properties['App Store Observation'] = rich('{broken'); fails(input, 'invalid_observation');
  delete properties['App Store Observation']; fails(input, 'unverified_baseline');
});
test('store ownership and recorded time must be intact', () => {
  for (const edit of [r => r.owner = 'deploy', r => r.recordedAt = 'invalid', r => delete r.observation]) {
    const input = snapshot(); editObservation(input, edit); fails(input, 'invalid_observation');
  }
  const newerThanInspection = snapshot(); newerThanInspection.inspectedAt = '2026-10-07T11:57:00Z'; fails(newerThanInspection, 'invalid_observation');
});
test('requires exact platform, bundle, version, build, source, state and evidence', () => {
  for (const [key, value] of Object.entries({kind: 'manual', platform: 'MAC_OS', bundleId: 'com.other.app', version: '1.0.1', build: '8', commit: 'b'.repeat(40), state: 'PENDING_DEVELOPER_RELEASE', downloadable: false, evidence: 'https://example.com/build'})) {
    const input = snapshot(); editObservation(input, r => r.observation.verification[key] = value); fails(input, 'unverified_baseline');
  }
});
test('uploads and paused rollout do not qualify; an exact public ACTIVE rollout does', () => {
  for (const edit of [r => r.observation.phase = 'uploaded', r => r.observation.phase = 'prepare', r => {r.observation.phase = 'rollout'; r.observation.verification.phasedReleaseState = 'PAUSED';}]) {
    const input = snapshot(); editObservation(input, edit); fails(input, 'unverified_baseline');
  }
  const input = snapshot(); editObservation(input, r => {r.observation.phase = 'rollout'; r.observation.verification.phasedReleaseState = 'ACTIVE';});
  assert.equal(validateBaseline(input, options).version, '1.0.0');
});
test('rejects older baseline selection when a newer public, stale or withdrawn release is present', () => {
  for (const variant of [{}, {checkedAt: '2026-10-07T09:00:00Z'}, {phase: 'withdrawn'}]) {
    const input = snapshot(); input.transport.pages[0].rows.push(row({id: OTHER_ID, version: 'v2.0.0', commit: 'b'.repeat(40), ...variant})); fails(input, 'ambiguous_baseline');
  }
});
test('an uploaded future build cannot supersede the currently verified public baseline', () => {
  const input = snapshot(); input.transport.pages[0].rows.push(row({id: OTHER_ID, version: 'v2.0.0', commit: 'b'.repeat(40), phase: 'uploaded', state: 'PENDING_DEVELOPER_RELEASE'}));
  assert.equal(validateBaseline(input, options).version, '1.0.0');
});
test('rejects ambiguous public records at the same version', () => {
  const input = snapshot(); input.transport.pages[0].rows.push(row({id: OTHER_ID, build: '8', commit: 'b'.repeat(40)})); fails(input, 'ambiguous_baseline');
});
test('checkpoint declarations, candidate manifests and version headings are not shipment proof', () => {
  fails({kind: 'internal', targets: ['ios-consumer']}, 'incomplete_baseline');
  const input = snapshot(), selected = input.transport.pages[0].rows[0];
  const candidate = {...input.frozenManifest, schemaVersion: 1, event: 'baseline', key: `${REPO}/ios-consumer/baseline/v1.0.0`};
  selected.properties.Manifest = rich(JSON.stringify(candidate)); selected.properties['Manifest Hash'] = rich(hash(candidate));
  input.frozenManifest = candidate; input.manifestHash = hash(candidate); fails(input, 'unverified_baseline');
});
test('preserves legacy major.minor history and leaves baseline future/Unreleased notes eligible', () => {
  const text = '# Synthetic\n## Unreleased\n### New\n- Capture several photos.\n## 1.1.0\n### Fixed\n- Recover drafts offline.\n## 1.0.0\n### Fixed\n- Retain saved drafts.\n## 0.9\n### Feature\n- Add draft lists.\n';
  const baseline = validateBaseline(snapshot(text), options), result = eligibleEntries(text, baseline);
  assert.deepEqual(baseline.shippedSections.map(s => s.version), ['1.0.0', '0.9.0']);
  assert.deepEqual(result.entries.map(e => e.summary), ['Capture several photos.', 'Recover drafts offline.']);
  assert.deepEqual(result.entries.map(e => e.ref.startLine), [4, 7]);
  assert.equal(result.excludedEntries.length, 2);
});
test('unchanged upcoming entries can supply shared coverage candidates without a file touch', () => {
  const text = `## [Unreleased]\n### New\n- Capture several photos. [Work Item](https://www.notion.so/${'d'.repeat(32)}) [PR](https://github.com/${REPO}/pull/42)\n\n${HISTORY}`;
  const baseline = validateBaseline(snapshot(text), options), result = eligibleEntries(text, baseline);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].workItems, ['d'.repeat(32)]);
  assert.deepEqual(result.entries[0].prRefs, [{repository: REPO, number: 42}]);
  assert.deepEqual(result.entries[0].ref, {path: 'CHANGELOG.md', startLine: 3, endLine: 3});
});
test('historical notes never become coverage just because CHANGELOG.md is present', () => {
  const result = eligibleEntries(SOURCE, validateBaseline(snapshot(), options));
  assert.equal(result.entries.length, 0);
  assert.equal(result.excludedEntries.length, 1);
  assert.match(result.excludedEntries[0].reason, /Already shipped/);
});
test('moving a shipped note or adding source links while moving it cannot create upcoming coverage', () => {
  const text = '## 1.0.0\n### Fixed\n- Retain saved drafts.\n- Keep the other published fix.\n';
  const baseline = validateBaseline(snapshot(text), options);
  for (const extra of ['', ` [PR](https://github.com/${REPO}/pull/42)`]) {
    const head = `## Unreleased\n### Fixed\n- Retain saved drafts.${extra}\n## 1.0.0\n### Fixed\n- Keep the other published fix.\n`;
    assert.throws(() => eligibleEntries(head, baseline), error => error.code === 'published_history_changed' && error.details.publishedHistoryChanges[0].version === '1.0.0');
  }
});
test('preserves repeated note occurrence counts while retaining all published history', () => {
  const baseline = validateBaseline(snapshot(), options);
  const head = `## 1.1.0\n### Fixed\n- Retain saved drafts.\n- Retain saved drafts.\n${HISTORY}`;
  const result = eligibleEntries(head, baseline);
  assert.equal(result.entries.length, 2);
  assert.equal(result.excludedEntries.length, 1);
  assert.deepEqual(result.entries.map(e => e.ref.startLine), [3, 4]);
});
test('published wording, metadata, categories, added bullets and deletions require explicit correction handling', () => {
  const text = '## 1.0.0\n### Fixed\n- Retain saved drafts.\n  rcValue: draft_recovery\n';
  const baseline = validateBaseline(snapshot(text), options);
  for (const head of [text.replace('saved drafts', 'all drafts'), text.replace('draft_recovery', 'different_flag'), text.replace('### Fixed', '### Changed'), text + '- Another fix.\n', '## Unreleased\n### New\n- Add draft export.\n']) {
    assert.throws(() => eligibleEntries(head, baseline), error => error.code === 'published_history_changed');
  }
});
test('formatting-only changes retain published wording and do not demand a new note', () => {
  const baseline = validateBaseline(snapshot(), options);
  const result = eligibleEntries(SOURCE.replace('Retain saved', 'Retain   saved').replace(/\n/g, '\r\n'), baseline);
  assert.equal(result.entries.length, 0);
});
test('retains multiline ranges and source mappings without exposing release metadata as wording', () => {
  const head = `## Unreleased\n### Internal\n- Backfill draft records.\n  Complete before enabling export.\n  rcValue: draft_export\n  previewTag: Research Preview\n  [Work Item](https://app.notion.com/p/${'d'.repeat(32)})\n${HISTORY}`;
  const item = eligibleEntries(head, validateBaseline(snapshot(), options)).entries[0];
  assert.deepEqual(item.ref, {path: 'CHANGELOG.md', startLine: 3, endLine: 7});
  assert.deepEqual(item.flagKeys, ['draft_export']); assert.equal(item.previewTag, 'Research Preview');
  assert.deepEqual(item.workItems, ['d'.repeat(32)]);
  assert.match(item.summary, /Complete before enabling export/); assert.doesNotMatch(item.summary, /rcValue|previewTag/);
});
test('malformed or unsupported note content is reported instead of silently omitted', () => {
  const baseline = validateBaseline(snapshot(), options);
  for (const prefix of ['## Upcoming\n### New\n- Feature.\n', '## Unreleased\nUnindented missing bullet.\n', '## Unreleased\n- Missing category.\n', '## Unreleased\n### New\n', '## Unreleased\n### New\n- Feature.\n  ```swift\n', '## Unreleased\n### New\n- Feature.\n  rcValue:\n', '## 1.1.0\n### New\n- Feature.\n## 1.1\n### Fixed\n- Duplicate version.\n']) {
    assert.throws(() => eligibleEntries(prefix + HISTORY, baseline), error => error instanceof CoverageBaselineError);
  }
});
test('a malformed Work Item/PR link is an input issue, not fabricated semantic coverage', () => {
  const baseline = validateBaseline(snapshot(), options);
  for (const link of ['https://www.notion.so/not-a-page', `https://github.com/${REPO}/pull/not-a-number`]) {
    assert.throws(() => eligibleEntries(`## Unreleased\n### New\n- Draft export. [source](${link})\n${HISTORY}`, baseline), error => error.code === 'invalid_source_mapping' && error.details.ref.startLine === 3);
  }
});
test('requires a present shipped version and a validated baseline object', () => {
  fails(snapshot('## 0.9.0\n### Fixed\n- An older fix.\n'), 'missing_source_version');
  assert.throws(() => eligibleEntries(SOURCE, {version: '1.0.0', shippedEntries: []}), error => error.code === 'unvalidated_baseline');
});
test('invalid calendar dates, version syntax and ordering return structured input errors with real lines', () => {
  const baseline = validateBaseline(snapshot(), options);
  for (const prefix of ['## [1.1.0] - 2026-99-99\n### New\n- Export drafts.\n', '## [1.1.0] - 2026-02-30\n### New\n- Export drafts.\n', '## 01.1.0\n### New\n- Export drafts.\n']) {
    assert.throws(() => eligibleEntries(prefix + HISTORY, baseline), error => error instanceof CoverageBaselineError && error.details.ref.startLine === 1);
  }
  assert.throws(() => eligibleEntries(HISTORY + '\n## 1.1.0\n### New\n- Export drafts.\n', baseline), error => error.code === 'invalid_changelog');
});
test('malformed ownership on any queried row is not silently excluded', () => {
  const input = snapshot(), older = row({id: OTHER_ID, version: 'v0.9.0', commit: 'b'.repeat(40)});
  older.properties['App Store Observation'] = rich('{broken');
  input.transport.pages[0].rows.push(older); fails(input, 'invalid_observation');
});
test('selected verification extensions are copied rather than freezing caller-owned objects', () => {
  const input = snapshot(); editObservation(input, r => r.observation.verification.extra = {audience: ['synthetic']});
  const baseline = validateBaseline(input, options);
  assert.ok(Object.isFrozen(baseline.verification.extra.audience));
  assert.doesNotThrow(() => input.frozenManifest.operatorExtension = 'caller still mutable');
});
