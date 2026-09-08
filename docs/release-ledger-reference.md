# Release system reference

[Notion runbook](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5) · [Setup and troubleshooting](release-ledger-rollout.md)

Use this page when authoring release metadata or maintaining the automation. Expand only the section you need.

Work Items are the source of truth for feature scope, ownership and status. Feature Status is a view of that database. Releases and Feature Availability hold linked evidence; the automation targets data sources and Work Item IDs, independent of dashboard views.

## Release-note example

Include a unique file in every PR, never reuse another PR's note filename:

```json
{
  "kind": "feature",
  "summary": "Export selected reports together.",
  "workItems": ["0123456789abcdef0123456789abcdef"],
  "scope": "bulk-report-export-v1",
  "targets": ["web"],
  "audience": "Enterprise administrators",
  "limitations": "Cloud projects only",
  "audienceGate": true,
  "requiredReleaseKeys": ["VeamStudios/SiteAuditPro-Backend/backend/release/v3.53.0"]
}
```

The PR body contains `Release note: .release-notes/bulk-export.json` and the existing `Work Items:` URL-only bullet list. Committed IDs and body links must match. `fix` and `internal` allow an empty Work Items list. `internal` releases stay in Notion. Backend/customer features use `feature`, with the customer outcome as their summary; service deployment detail uses `internal`.

<details>
<summary>Targets, review approval and delivery scopes</summary>

Targets distinguish editions: `ios-consumer`, `ios-enterprise`, `android-consumer`, `android-enterprise`, `web`, `website`, `console`, `backend`, `cloudservices`. Product remains separate, so the same target can exist for SAP and CIP. Package versions are dependencies, never proof a consuming feature is released. A required package must be mapped to a verified consuming deployment before it can satisfy an availability component.

A current-head human PR approval freezes wording, classification, audience, limitations, target, scope, dependencies and WI links into the manifest. A missing review holds publication. The admin utility can explicitly approve an exact complete manifest with a review evidence link. Changing Notion's Changelog or Manifest afterward invalidates readiness; retries do not overwrite the edit. Corrections use a reviewed new event when the frozen manifest would change.

Use a **new scope ID for enhancements**. To plan delivery before a PR exists, create Feature Availability rows with their Work Item, target, scope, audience, limitations and explicit required release keys. Link all agreed targets through Work Items.Required Availability. The admin `approve-scope` operation snapshots the relation and its contracts; subsequent scope edits invalidate aggregate completion. One platform can be Available while the overall WI remains in development. Implementation tabs remain owned by the existing developer workflow.

</details>

<details>
<summary>How platform Done and Released are calculated</summary>

The existing `Web Dev Status`, `iOS Dev Status` and `Android Dev Status` fields follow **In Development → Done → Released**:

1. The existing implementation skill/Cursor automation sets In Development.
2. A client PR merged into `main` triggers `work-item-development.yml`, which calls the shared completion workflow. It reads explicit `Work Items:` links from GitHub and sets **only that repository's platform** to Done. SAP/CIP product relations must match. Unmerged closes, other base branches, inactive Work Items and unlinked fixes do not update status. Other linked open PRs in the same platform repository, including drafts and intermediate branches, hold completion. If required follow-up work has no PR yet, put `"developmentComplete": false` in the committed release note; the final PR can omit it or use true. Reviewers must check this declaration when a feature is split across PRs.
3. The release processor sets that platform to Released after every approved required availability scope for that platform is Available. It also verifies that the completing PR's exact head appears in the frozen release evidence for that scope. An old release cannot complete a new enhancement cycle. Consumer and Enterprise rows remain separate; both must be available if both belong to the agreed platform scope.
4. Only when **all** required platforms/components are available does the overall Work Item become Released. A successful web deploy plus its verification check can satisfy this; uploads, flags, dependencies, partial rollouts and failed deployments still wait.

The Work Items `Platform Development` rich-text property stores the latest completing PR, exact head/merge commit, merge time and scope for each platform. It is automation evidence, not a field authors maintain. Completion and its receipt are written in one Notion page update under the same central lock used by release processing. Duplicate/older events cannot mark a new development cycle Done, and merge events never downgrade Released. For enhancements, the existing development workflow must explicitly start In Development again.

Callers exist in both client Web repositories, both iOS repositories and SiteAuditPro-AndroidNew. Backend, CloudServices, packages, Console and promotional websites cannot complete a client platform. The privileged merge workflow never checks out or executes PR code; it reads committed JSON as data through the GitHub API. A manual workflow dispatch accepts a merged PR number to retry a failed status update without redeploying.

Completion writes require **both** organisation `RELEASE_LEDGER_MODE=live` and `RELEASE_LIFECYCLE_WRITES=true`. Shadow mode emits a proposed update as an Actions artifact without editing Work Items. The worker uses its corresponding mode/lifecycle environment settings for Released. Keep both lifecycle switches false until hosted Work Item Drift ownership is verified. These switches do not authorize blanket historical completion.

</details>

<details>
<summary>Exact commits, hotfixes and cherry-picks</summary>

`record-release.yml` checks out the candidate commit with full history. It enumerates commits from the previous Available production baseline and retrieves PR associations directly, paging all results. It reads notes from the candidate and originating PR commit, compares their hashes and checks current-head approval. No merge-date, latest-default-head, mirrored-relation or PR-title heuristic establishes contents.

Ambiguous/cherry-picked provenance uses `mapping_path: .release-provenance/<identity>.json`, containing `baseline`, `reviewPr`, and `commits` (exact SHA → PR number). The mapping must itself be present in a merged, human-reviewed PR and unchanged at the candidate. A non-ancestor hotfix baseline requires this explicit mapping. An open hotfix PR is included only when its exact reviewed head is an ancestor of the shipped commit. Missing mappings remain Unverified.

</details>

<details>
<summary>Deployment, store and Remote Config evidence</summary>

Normal web/backend/CloudServices pipelines prepare before deployment. iOS consumer preparation uses the approved beta's exact commit/build. Website version allocation moves before deployment. Enterprise, manual Android and the legacy iOS hotfix flow currently snapshot after successful upload/distribution; see the [shadow acceptance checklist](release-ledger-rollout.md). Their frozen notes still come from reviewed commits, not mutable Work Item text.

The manifest is saved in Notion and as a 90-day Actions artifact; Notion is the durable history. All WI IDs remain in the manifest even if the convenience relation exceeds Notion's 100-item request limit. Individual availability records use the complete manifest, not that relation. Very large single properties (>180,000 characters) fail explicitly rather than truncate.

The producer only records successful jobs. An optional repository variable `RELEASE_VERIFICATION_URL` supplies an HTTPS verification endpoint. Its successful response is paired with the successful deployment of the exact commit; an absent endpoint leaves availability waiting for verified manual evidence. Multi-service production depends on all four CloudServices jobs. No record failure reruns a deployment: retry the recording job only.

App Store monitoring reads pending ledger rows, resolves bundle/platform/version, reads the version's related build, and checks phased-release state. Enterprise is separate. A version match with a different build fails. Uploads wait, phased releases remain Limited rollout. Apple does not provide an exact release timestamp through these observations: the observation explicitly records `timeBasis: first-observed`; an operator can supply the actual timestamp. Do not interpret ASC createdDate as release time.

Android and managed distribution initially use the verified manual path. Specify the exact versionCode, evidence link, actual time and intended audience using `confirm-availability`. A selected "Live" value in the old marking workflow alone is insufficient. Remote Config booleans are only observations: use `audienceGate` for flags, entitlements and conditional audiences, then verify that audience explicitly. A later activation creates a separate event dependent on its deployed implementation.

</details>

<details>
<summary>Which automation owns each field?</summary>

| Fields | Sole writer after cutover |
|---|---|
| Platform Dev Status: Not Started / In Development; AI Implementation | Existing developer/Work Item Drift process; hosted configuration must be inspected before cutover |
| Platform Dev Status: Done; Platform Development evidence | Shared main-merge completion workflow, with lifecycle writes enabled after ownership verification |
| Platform Dev Status: Released | Release processor, after approved platform scope and completing-PR evidence are verified |
| Work Item Required Availability and scope approval | Product owner, through reviewed scope/admin helper |
| Work Item Released | Release processor, only with `RELEASE_LIFECYCLE_WRITES=true` after ownership verification |
| Production Remote Config values | Existing production mirror; release-state input is disabled when org mode is live |
| Frozen manifest, source commit/build, deployment/store observations | Shared recorder and App Store reconciler |
| Availability/audience evidence and manual approvals | Explicit operator verification, bound to expected manifest hash |
| Release/Feature Availability state and Slack receipts | Notion release processor |
| GitHub mirror fields | Existing mirror workers, unchanged |

</details>

<details>
<summary>Credentials, environment settings and operating modes</summary>

The recorder needs existing Release Bot credentials (`BOT_RELEASE_APP_ID`, `BOT_RELEASE_PRIVATE_KEY`) plus `NOTION_TOKEN` shared with Releases. The bot needs read access to each caller and **contents write on VeamStudios/.github** for the shared lock. The worker GitHub credential needs equivalent central-lock access. A dedicated lock repository can replace `.github` in both implementations if narrower access is chosen before rollout.

The worker needs the datasets in `.env.example`, `RELEASE_SLACK_BOT_TOKEN`, `RELEASE_SLACK_CHANNEL_ID`, `RELEASE_OPERATIONS_CHANNEL_ID`, `RELEASE_CUTOVER_AT`, and explicit mode. Use a Slack bot with chat write and channel-history/metadata read access, already a member of both destination channels. Webhooks cannot update prior announcements or reconcile uncertain delivery.

| Mode | GitHub producer | Existing direct release notices | Worker publisher |
|---|---|---|---|
| off / unset | No-op | Continues | No-op |
| shadow | Records evidence | Continues | Computes states and Shadow readiness, no Slack |
| live | Records evidence | Disabled | Eligible records post/update automatically |

</details>

<details>
<summary>Publication lock and Slack delivery recovery</summary>

Publication and recording share an atomic GitHub ref lock (`refs/tags/veam-release-ledger-lock`). An annotated tag stores owner, nonce and acquisition time. A crash or cancellation during recording can leave the lock in place; there is deliberately no unsafe time-based takeover. Confirm no holder is active, reconcile any Sending receipts against Slack, then delete **only that exact lock ref**. Never delete software release tags.

The durable Sending marker precedes Slack. If Slack succeeds but receipt persistence fails, the next run searches all history pages for the stable key and saves the original timestamp. It never automatically retries an uncertain send with no matching message. An operator must verify absence before resetting Pending. Corrections use chat.update with the original timestamp. Per-release failures go to the operations channel with an independent durable receipt; a total Notion outage prevents that receipt too, so hosted worker-run failure monitoring must also be routed to operations before cutover.

</details>

Primary API references: [Notion sync schedules](https://developers.notion.com/workers/guides/syncs), [App Store related build](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversions-_id_-build), [App Store phased release](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversions-_id_-appstoreversionphasedrelease), [Slack message updates](https://docs.slack.dev/reference/methods/chat.update/).

## Releases presentation

Notion release titles use `SAP Web 5.10.0`, `CIP iOS 2.2.0`, or `CloudServices 1.14.0`; Enterprise editions and separate Activation/Withdrawal events remain explicit. Titles and Products relations are presentation fields, not release identities. Frozen manifest product/target/version strings and hashes are unchanged.

The recorder and App Store monitor inspect Releases.Target's schema and support both machine text values and readable select options during migration. Products uses the existing Products relation, with explicit SAP/CIP/Shared page mappings; conflicting existing relations and unknown mappings require reconciliation. Install both shared-action and worker support before converting Target under the shared release lock. Keep notification receipts and hashes, hidden from normal views, for delivery recovery.
