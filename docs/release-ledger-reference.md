# Release system reference

[Team runbook](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5) · [Worker setup](https://github.com/VeamStudios/NotionWorkers/blob/main/docs/release-setup.md)

Generate announcements from the reviewed changelog and shipped PR links, with a permanent Notion record of what became available.

## Developer checklist

1. Update `CHANGELOG.md` with customer-facing headings and wording. Keep the repository’s existing format.
2. Link feature PRs using the existing `Work Items:` list. Bug fixes can have no Work Item.
3. Review the changelog with the code, complete QA and use the normal deployment workflow.

**Expected result:** automation records the exact shipped release. Available changelog entries post to Slack with a Notion link and linked Work Item descriptions. Backend and CloudServices stay in Notion. There is no required release-note JSON file or `Release note:` PR field.

<details><summary>What the announcement contains</summary>

Release heading → available changelog headings/bullets → full Notion release record → Includes these Work Items.

Descriptions come from Feature Changelog Text, falling back to the Work Item title. Both wording and descriptions are frozen. Notion retains the complete changelog, all shipped Work Item links, waiting reasons, source evidence and an expandable Posted to Slack section with exact message text, timestamp and link. Corrections retain the original text and update the same Slack message.

</details>

<details><summary>Exact contents and missing notes</summary>

The recorder reads CHANGELOG.md at the shipped commit and compares it with the previous verified production commit, independent of announcement readiness. It includes skipped versions, multiline entries and Unreleased. Moving unchanged entries between version headings does not announce them again. Editing an already deployed version is held for correction.

PR inclusion comes from GitHub commit associations, paginated directly rather than through the daily Notion mirror. Ambiguous/cherry-picked provenance requires the existing reviewed `.release-provenance/` mapping. It is an exceptional operator recovery path, not routine developer input.

For ambiguous changelog-to-feature mapping, add a normal Markdown Work Item or shipped PR link beside the entry. Raw rcValue and previewTag metadata is retained as gating information and excluded from the changelog text. Preview restrictions remain visible.

Missing wording or evidence produces a precise warning; merging and deployment remain possible. To supply notes after a release was recorded, merge a reviewed CHANGELOG.md PR with links to the shipped source PRs. Run **Refresh reviewed release notes** in VeamStudios/.github with repository, Notion release page ID and wording PR number. The supplement is stored separately from the immutable original Manifest. Already posted entries cannot be rewritten by this workflow; use a message correction instead.

</details>

<details><summary>Availability and later activation</summary>

Deployment evidence and announcement readiness are separate. Websites, Web, Console, Backend and CloudServices require successful required deployments plus verification. iOS requires exact bundle/version/platform/build and confirmed distribution; upload alone waits. Phased rollout stays Limited rollout. Android/managed distribution retains exact-build manual confirmation.

Feature availability is scoped to Work Item, release, target and edition. A release-wide checkbox, an older Available Work Item, or a boolean Remote Config default cannot unlock a new feature. Existing approved Feature Availability scopes can supply the dependencies and audience evidence. Missing scope evidence stays Waiting. An operator can use `confirm-change` in the worker admin tool with an exact manifest hash, scope, evidence URL and actual availability time. This records evidence for that scope and this release; it does not change agreed overall Work Item scope.

Available fixes can post while a feature waits. Once verified, only the newly available entries appear in a separate activation message, with a distinct stable identity and receipt. Backend and CloudServices never post to the release channel. Historical records remain suppressed.

Work Item lifecycle writes remain separately controlled by RELEASE_LIFECYCLE_WRITES in GitHub and the hosted worker. This change does not enable them. Package publication is dependency evidence, never proof that a consuming feature is available.

</details>

<details><summary>Notion properties and recovery</summary>

The default Releases view shows Name, Products, Target, Version, State, Released At and Work Items. The Automation view retains manifests, hashes, IDs, receipts and the Announcements ledger. The duplicate text Product can be removed after all compatible readers and writers are deployed; Feature Availability's separate Product property remains.

Announcements stores each selected entry set and exact text before publication, plus any reviewed supplement and correction history. NotionWorkers is the sole publisher. Recording/publication use the existing atomic GitHub ref lock. Transient Notion reads and idempotent writes retry with bounded backoff and Retry-After. Creates and block appends are reconciled before another attempt. Unchanged properties are not written.

If Slack delivery is uncertain, the worker searches channel history for the stable event key/hash before saving the original receipt. It does not blindly resend an uncertain message. `correct-announcement` queues reviewed complete text for a known message; chat.update is repeatable without posting a second message.

Needs attention includes actual unresolved errors, including historical records. Historical/Unverified alone is not an operational failure. Recovered errors are cleared only after processing succeeds; Operations Receipt retains diagnostics, and worker logs preserve failures even when error-reporting writes fail. Retry the recording or worker job, never redeploy software solely to retry a notification.

Concurrent writers wait for the existing lock for up to 30 acquisition attempts (two seconds between attempts), then return an actionable retry error. A lost creation or deletion response is reconciled by the unique owner tag before proceeding. Normal consumer/Enterprise overlap does not require manual recovery.

A cancelled job can leave `refs/tags/veam-release-ledger-lock`. Verify no holder is active, reconcile Sending receipts, then remove only that exact lock ref. Preserve cancel-in-progress: true. Never remove software version tags. The lock is never stolen merely because it is old.

</details>

Checked: 2026-09-09 against shared recorder, NotionWorkers and focused regression tests. Live deployment and evidence checks are recorded in the rollout record. API references: [Notion status codes](https://developers.notion.com/reference/status-codes), [Slack corrections](https://docs.slack.dev/reference/methods/chat.update/).
