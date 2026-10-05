# Release system reference

[Team runbook](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5) · [Worker setup](https://github.com/VeamStudios/NotionWorkers/blob/main/docs/release-setup.md)

Generate one deployment announcement from the complete frozen deployed changelog and shipped PR links, with a permanent Notion record of what shipped. Feature readiness remains a separate Notion projection.

## Developer checklist

1. Update `CHANGELOG.md` with customer-facing headings and wording. Keep the repository’s existing format.
2. Link feature PRs using the existing `Work Items:` list. Bug fixes can have no Work Item.
3. Review the changelog with the code, complete QA and use the normal deployment workflow.

**Expected result:** automation records the exact shipped release. Its complete frozen deployed changelog posts to Slack with a Notion link and linked Work Item descriptions once deployment publication checks pass. Backend and CloudServices stay in Notion. There is no required release-note JSON file or `Release note:` PR field.

<details><summary>What the announcement contains</summary>

Release heading → complete frozen deployed changelog headings/bullets → full Notion release record → Includes these Work Items.

Work Item labels use their titles; release wording comes from the shipped repository changelog. Both wording and descriptions are frozen. Notion retains the complete changelog, all shipped Work Item links, waiting reasons, source evidence and an expandable Posted to Slack section with exact message text, timestamp and link. Corrections retain the original text and update the same Slack message.

</details>

<details><summary>Exact contents and missing notes</summary>

The recorder reads CHANGELOG.md at the shipped commit and compares it with the previous verified production commit, independent of announcement readiness. It includes skipped versions, multiline entries and Unreleased. Moving unchanged entries between version headings does not announce them again. Editing an already deployed version is held for correction.

PR inclusion comes from GitHub commit associations, paginated directly rather than through the daily Notion mirror. Ambiguous/cherry-picked provenance requires the existing reviewed `.release-provenance/` mapping. It is an exceptional operator recovery path, not routine developer input.

For ambiguous changelog-to-feature mapping, add a normal Markdown Work Item or shipped PR link beside the entry. Raw rcValue and previewTag metadata is retained as gating information and excluded from the changelog text. Preview restrictions remain visible.

Missing changelog wording or deployment verification holds publication; merging and deployment remain possible. Feature mapping warnings remain visible without removing shipped changelog entries from the deployment announcement. Consumer Android also retains its reviewed wording gate and uncertain Slack delivery always requires receipt reconciliation. To supply notes after a release was recorded, merge a reviewed CHANGELOG.md PR with links to the shipped source PRs. Run **Recheck release announcement evidence** in VeamStudios/NotionWorkers with repository and Notion release page ID. Supply the wording PR number only when adding reviewed wording; otherwise the original shipped sources are rechecked. The default is a read-only preview. Inspect its exact changes and holds before applying the supplement. The supplement is stored separately from the immutable original Manifest. Already posted entries cannot be rewritten by this workflow; use a message correction instead.

</details>

<details><summary>Availability and later activation</summary>

Deployment evidence and feature readiness are separate. Websites, Web, Console, Backend and CloudServices require successful required deployments plus verification. iOS requires exact bundle/version/platform/build and confirmed distribution; upload alone waits. The App Store writer preserves raw phased release state and progress, while its existing phase mapping remains `rollout` until Apple returns `COMPLETE` or explicitly no phased release. Consumer Android requires hourly exact-build Play verification of published production lifecycle and completed rollout, with manual workflow retry. Enterprise distribution remains separate and requires its own exact-build confirmation.

Feature availability is scoped to Work Item, release, target and edition. A release-wide checkbox, an older Available Work Item, or a boolean Remote Config default cannot unlock a new feature. Existing approved Feature Availability scopes can supply the dependencies and audience evidence. Missing scope evidence stays Waiting. An operator can use `confirm-change` in the worker admin tool with an exact manifest hash, scope, evidence URL and actual availability time. This records evidence for that scope and this release; it does not change agreed overall Work Item scope.

The deployment announcement contains the complete frozen deployed changelog, including features whose readiness is still waiting in Notion. Later feature readiness changes update Notion projections without repeating deployment changelog entries in Slack. Independently recorded explicit activation events have their own distinct event identity and receipt. Releases `State = Waiting` can coexist with `Notification State = Sent`. Backend and CloudServices never post to the release channel. Historical records remain suppressed.

GitHub producers always record merged PR and production evidence. The hosted worker uses RELEASE_LEDGER_MODE=live and RELEASE_LIFECYCLE_WRITES=true; the live readiness check rejects disabled values. Package publication is dependency evidence, never proof that a consuming feature is available.

</details>

<details><summary>Notion properties and recovery</summary>

The default Releases view shows Name, Products, Target, Version, State, Released At and Work Items. The Automation view retains manifests, hashes, IDs, receipts and the Announcements ledger. The duplicate text Product can be removed after all compatible readers and writers are deployed; Feature Availability's separate Product property remains.

Announcements stores each selected entry set and exact text before publication, plus any reviewed supplement and correction history. NotionWorkers is the sole publisher. Recording/publication use the existing atomic GitHub ref lock. Transient Notion reads and idempotent writes retry with bounded backoff and Retry-After. Creates and block appends are reconciled before another attempt. Unchanged properties are not written.

If Slack delivery is uncertain, the worker searches channel history for the stable event key/hash before saving the original receipt. It does not blindly resend an uncertain message. `correct-announcement` queues reviewed complete text for a known message; chat.update is repeatable without posting a second message.

Needs attention includes actual unresolved errors, including historical records. Historical/Unverified alone is not an operational failure. Recovered errors are cleared only after processing succeeds; Operations Receipt retains diagnostics, and worker logs preserve failures even when error-reporting writes fail. Retry the recording or worker job, never redeploy software solely to retry a notification.

Shared-action writers wait for the existing lock for up to five minutes by default, leaving room for normal worker holds of roughly two minutes. The wait budget uses monotonic elapsed time, including acquisition and reconciliation requests, with at most two seconds between attempts. No new acquisition starts at or after the deadline; an in-flight request and its ownership reconciliation must finish and can extend elapsed time beyond the budget. A lost creation or deletion response is reconciled by the unique owner tag before proceeding. Normal consumer/Enterprise overlap does not require manual recovery.

`record-release.yml` and the release-ledger composite action accept optional `lock_wait_ms` (default `300000`). Direct Node entry points accept `RELEASE_LEDGER_LOCK_WAIT_MS`; programmatic `withLock` callers can pass `timeoutMs`. Values must be non-negative safe integers in milliseconds; `0` makes one immediate attempt without contention waits. Existing callers need no changes. Explicit legacy `attempts` remains an additional cap, while the default no longer stops after 30 attempts. The timeout reports elapsed time, budget, attempt count, shared repository/ref, last observed holder tag SHA and last acquisition error. Inspect that exact tag and its ownership metadata if recovery is needed. This setting only changes acquisition waiting, not lock lifetime, worker scheduling or the protected operation.

A cancelled job can leave `refs/tags/veam-release-ledger-lock`. Verify no holder is active, reconcile Sending receipts, then remove only that exact lock ref. Recovery workflows use cancel-in-progress: false so a newer retry does not interrupt a lock holder. Never remove software version tags. The lock is never stolen merely because it is old.

</details>

Checked: 2026-10-05 for the shared source contract and local regression tests. The draft iOS writer/worker integration is not deployed or runtime-verified. Prior live deployment and evidence checks are recorded separately in the rollout record. API references: [Notion status codes](https://developers.notion.com/reference/status-codes), [Slack corrections](https://docs.slack.dev/reference/methods/chat.update/).

## Work Item delivery contract (version 1)

New manifests freeze preserved scope exceptions from the supporting automation ledger and the existing platform RC Key from the Work Item. A linked client PR merged into main sets its existing platform Dev Status to Done and records exact PR/head evidence. A verified production deployment/distribution containing that PR sets the same field to Released. Other open PRs, release-note declarations and wording approval do not block the merge transition. Platform Released is independent of feature flags, service dependencies and Slack publication; overall Work Item availability retains those checks. Blank platform fields remain unknown, N/A excludes a platform, and mobile editions follow product defaults unless a preserved scope exception applies. No separate scope approval fields are maintained on Work Items.

NotionWorkers generates supporting availability rows per Work Item, target, change and release. Exact transport evidence, the latest completed PR, current matching scope and dependencies must agree. Fresh production RC evidence includes defaults and conditional expressions; unrestricted true values can resolve automatically. Restricted audiences require a confirmation bound to the exact release/configuration hash. Missing wording holds publication without blocking verified delivery status. Earlier availability is retained when a new development cycle starts.

HTTP verification requires a JSON endpoint reporting the shipped repository and commit, not merely HTTP 200. Hosting deploys embed release-info.json through a post-build Firebase predeploy hook; backends return it from version. CloudServices verifies Ready state, immutable revision commit labels and 100% traffic for email/exporter/main/pdf. Consumer Android's scheduled production monitor refreshes exact-build published lifecycle and completed rollout evidence; its manual dispatch retries verification without publishing an app. Enterprise distribution uses separate confirmation. Recording failures can be retried via Re-run failed jobs without rerunning successful deployment jobs.

An audited historical production baseline may be stored in Observation.baseline with the immutable manifest hash, repository/target/commit/build and source evidence links. It is used only to choose the next comparison baseline. Historical announcement suppression and unverified historical feature availability remain unchanged. The baseline commit is read from the verified frozen manifest, never a mutable display property.

## App Store observation contract

The shared writer adds exact normalized `verification.version` and `platform = IOS` to the existing frozen build/commit, bundle/app/version IDs, resolved state, build evidence URL and `checkedAt`. `appVersionState` takes precedence over deprecated `appStoreState`; both raw state fields and `downloadable` are retained when returned by Apple. A true `downloadable` value alone is insufficient without a distribution state and matching build.

For a linked phased resource, `phasedReleaseState`, `currentDayNumber`, `totalPauseDuration` and `startDate` are copied exactly when present, with `phasedReleaseId` and `phasedReleaseEvidence`. No percentage or completed rollout is inferred from the day number. An explicit null phased relationship emits the internal absence marker `phasedReleaseState = NONE` and a null `phasedReleaseId`; lookup errors, including HTTP 404, cannot establish absence. Unknown linked states remain raw `rollout` observations.

Each monitor execution rechecks previously live and rollout rows, excluding only matching terminal supersession evidence. `verification.checkedAt` and `Observed At` describe the fresh check; `releasedAt` and `Released At` preserve the first observed distribution time through rollout changes. A TestFlight upload timestamp is not used as that release time. Exact-build removed-from-sale or explicitly non-downloadable evidence records `withdrawn`; an initially negative observation records only the check time and cannot manufacture a release time. A failed lookup or a formerly released version no longer returning distribution evidence preserves its last raw proof and old `checkedAt`, adds blocking `verificationError` plus `verificationAttempt.at`, and fails the monitor. Successful rechecks clear only the recovered verification error and retain recovery diagnostics and unrelated delivery errors. Historical buildless baselines and withdrawn rows retain their existing exemptions; dry runs write nothing.

Apple's explicit `REPLACED_WITH_NEW_VERSION` is normal terminal supersession, not a withdrawal or an API failure. After confirming the exact related build, the writer stores fresh raw negative evidence in `Observation.superseded`: the version/build/commit, bundle/app/version IDs, raw state fields, `checkedAt`, evidence URL and frozen `manifestHash`. It retains the historical phase, first release time and successful `verification` unchanged for delivery history and comparison baselines, while setting the blocking `verificationError = App Store version was replaced by a newer version; historical delivery evidence is retained`. Supersession does not add an operational error to the monitor result or clear unrelated delivery errors. Only that exact hash/version/build/commit/bundle/version-ID/time-bound marker and matching hold are exempt from subsequent checks; mismatches recheck. Thus ordinary older versions do not fail every hourly run, and current non-superseded released rows still detect genuine retractions.

The current SAP consumer/Enterprise and CIP consumer callers run hourly. This writer contract supports the separate draft NotionWorkers iOS publication policy: fresh exact-build downloadable `ACTIVE` observations may be announced as Released while raw phased evidence remains available. Deploy and verify the writer before enabling that policy; this shared change does not deploy or alter the worker policy. A two-hour worker freshness window must hold publication when scheduled verification is delayed or fails.

Apple references: [version attributes](https://developer.apple.com/documentation/appstoreconnectapi/appstoreversion/attributes-data.dictionary), [phased attributes](https://developer.apple.com/documentation/appstoreconnectapi/appstoreversionphasedrelease/attributes-data.dictionary), [phased states](https://developer.apple.com/documentation/appstoreconnectapi/phasedreleasestate), and [manual download during phased release](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases).

## Marketing website changelogs

Website deployment compares these paths with its previous verified production commit:

| Website | App | Path |
| --- | --- | --- |
| siteauditpro.com | Web | `src/app/content/changelogs/web/CHANGELOG.md` |
| siteauditpro.com | iOS | `src/app/content/changelogs/ios/CHANGELOG.md` |
| siteauditpro.com | Android | `src/app/content/changelogs/android/changelog.md` |
| checklistinspectorpro.com | Web | `src/assets/changelog-web/CHANGELOG.md` |
| checklistinspectorpro.com | iOS | `src/assets/changelog-ios/CHANGELOG.md` |

Each changed version produces website wording such as **Updated changelog for Web App Release 5.11.0**. App feature notes and Work Item associations are not copied into the website release. Reviewed manual changes are supported for every path. Automated copies require the registered Release Bot, a single allowed destination path and content matching the exact source commit/version. New sync commits include source repository/commit/path trailers. Unrelated bot edits require normal provenance.

A failed recording job is retried after successful deployment with **Re-run failed jobs**. Missing notes, unreviewed wording or ambiguous associations remain visible in Notion and produce a deduplicated operations alert. Routine QA and audience waits remain normal waiting states. Use the worker admin `inspect` action to preview eligible text, holds and existing receipts without writes; do not reset a Sending receipt to bypass reconciliation.
