'use strict';
const { resolveBaseline } = require('./changelog-baseline');
const RELEASES_ID = '8beb58ea-dd4f-4777-8799-b6694ade6317';

// Owned by the pinned shared action, never by PR source/description/caller input.
// Add repositories only after their release proof and assessment sample are checked.
function policyFor(repository) {
  if (repository !== 'VeamStudios/SiteAuditPro-iOS') throw Error('Missing-entry enforcement has no validated release policy for this repository.');
  return { repository, releasesId: RELEASES_ID, targets: ['ios-consumer', 'ios-enterprise'],
    changelogPaths: ['CHANGELOG.md'], changelogFormat: 'categorized' };
}
async function resolvePolicyBaselines(config, lookup = resolveBaseline) {
  const policy = policyFor(config.repo);
  const consumer = await lookup({ api: config.api, repo: policy.repository, target: 'ios-consumer', releasesId: policy.releasesId });
  let enterprise;
  try {
    enterprise = await lookup({ api: config.api, repo: policy.repository, target: 'ios-enterprise', releasesId: policy.releasesId });
  } catch (error) {
    // Owner instruction on 2026-10-07: assume Enterprise 10.7.3 used the
    // consumer release timing. This is an explicit assumption, not verified
    // Enterprise artifact provenance. Never carry it into another version or
    // override contradictory, malformed, failed or ambiguous ledger evidence.
    if (error.code !== 'missing' || consumer.version.replace(/^v/, '') !== '10.7.3') throw error;
    enterprise = { ...consumer, assumed: true,
      assumption: 'Enterprise 10.7.3 uses the consumer 10.7.3 source baseline by owner instruction; Enterprise artifact provenance is not independently verified.' };
  }
  return [{ target: 'ios-consumer', ...consumer }, { target: 'ios-enterprise', ...enterprise }];
}
module.exports = { policyFor, resolvePolicyBaselines };
