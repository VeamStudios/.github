'use strict';

// Synthetic test fixture only. No real release/Work Item/ledger records.
const {execFileSync} = require('node:child_process');
const {rich, hash} = require('../../record');
const REPOSITORY = 'VeamStudios/SiteAuditPro-iOS';
const RELEASE_ID = '11111111-1111-4111-8111-111111111111';
const COLLECTION_ID = '33333333-3333-4333-8333-333333333333';
const DEFAULT_SOURCE = '# Synthetic app\n\n## 1.0.0\n### Fixed\n- Retain saved drafts.\n';

function makeReleaseRow({id = RELEASE_ID, version = 'v1.0.0', build = '7', commit = 'a'.repeat(40), phase = 'live', state = 'READY_FOR_DISTRIBUTION', checkedAt = new Date(Date.now() - 60000).toISOString()} = {}) {
  const manifest = {schemaVersion: 2, repository: REPOSITORY, target: 'ios-consumer', event: 'release', version, build, commit, key: `${REPOSITORY}/ios-consumer/release/${version}`, provenanceComplete: true};
  const observation = {phase, verification: {kind: 'app-store', platform: 'IOS', version: version.replace(/^v/, ''), build, commit, bundleId: 'com.veamstudios.iaudit', appStoreVersionId: 'synthetic-store-version', state, downloadable: true, phasedReleaseState: phase === 'rollout' ? 'ACTIVE' : 'COMPLETE', checkedAt, evidence: 'https://api.appstoreconnect.apple.com/v1/appStoreVersions/synthetic-store-version/build'}};
  return {id, properties: {Manifest: rich(JSON.stringify(manifest)), 'Manifest Hash': rich(hash(manifest)), 'App Store Observation': rich(JSON.stringify({owner: 'store', recordedAt: checkedAt, observation}))}};
}

function makeSnapshot({now = new Date().toISOString(), sourceText = DEFAULT_SOURCE, version = 'v1.0.0', build = '7', commit = 'a'.repeat(40)} = {}) {
  const inspectedAt = new Date(now).toISOString();
  const selected = makeReleaseRow({version, build, commit, checkedAt: new Date(Date.parse(inspectedAt) - 60000).toISOString()});
  // Independent Git implementation catches incorrect byte length/newline/UTF-8
  // assumptions in the production validator's Git blob hash implementation.
  const blob = execFileSync('git', ['hash-object', '--stdin'], {input: sourceText, encoding: 'utf8'}).trim();
  return {schemaVersion: 1, repository: REPOSITORY, target: 'ios-consumer', inspectedAt,
    transport: {kind: 'notion-release-ledger', dataSourceId: COLLECTION_ID, repository: REPOSITORY, target: 'ios-consumer', complete: true, truncated: false, selectedReleaseId: RELEASE_ID, pages: [{cursor: null, nextCursor: null, hasMore: false, rows: [selected]}]},
    frozenManifest: JSON.parse(selected.properties.Manifest.rich_text[0].text.content), manifestHash: selected.properties['Manifest Hash'].rich_text[0].text.content,
    source: {repository: REPOSITORY, path: 'CHANGELOG.md', commit, blob, text: sourceText}};
}

module.exports = {makeSnapshot, makeReleaseRow, DEFAULT_SOURCE, REPOSITORY};
