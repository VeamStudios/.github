# Release rollout record

Current operating instructions: [release reference](release-ledger-reference.md) and [Notion runbook](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5). The dated checklist below describes the original rollout and is retained as history; its JSON/shadow-mode instructions are superseded by the changelog announcement implementation.

<details><summary>Original rollout evidence and checklist</summary>

# Release setup and troubleshooting

[Notion runbook](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5) · [Technical reference](release-ledger-reference.md) · [Implementation Work Item](https://www.notion.so/3d4069083a038174982cc98d9c3b20cd)

> **Not live.** Code is in draft PRs. No worker deployment or notification cutover has occurred. Access observations below were recorded on 7 September 2026; recheck them during setup.

## Turn it on: one coordinated rollout

Complete these in order across all products.

### 1. Land the code with automation off

- [ ] Merge [shared PR #57](https://github.com/VeamStudios/.github/pull/57) first, then the worker and product callers.
- [ ] Rerun dependent checks once the shared workflows exist on `main`.
- [ ] Keep publication and lifecycle writes disabled.

### 2. Finish access and ownership

- [ ] Give the hosted worker access to Releases, Feature Availability and Work Items; verify Console access.
- [ ] Inspect hosted Work Item Drift and Manager Product. Agree who owns each status transition.
- [ ] Verify the Work Items `Platform Development` field and the merge workflow's access.
- [ ] Configure bot permissions, release/operations channels and production verification endpoints. [Settings reference](release-ledger-reference.md).
- [ ] Configure independent hosted-run failure monitoring for a total Notion outage.

### 3. Establish the starting baseline

- [ ] Verify the current production build and intended audience for every target, prioritising Enterprise.
- [ ] Record baselines as historical so they cannot announce. Keep unsupported claims **Unverified**.

### 4. Test in shadow mode

- [ ] Enable shadow for every producer and the worker. Existing release notices continue; the new publisher sends nothing.
- [ ] Compare proposed records, statuses and messages with actual releases.
- [ ] Exercise every scenario in the expandable checklist below. Record evidence before accepting the rollout.

### 5. Cut over together

- [ ] Finish in-flight legacy notices and pause new production releases during the switch.
- [ ] Set the GitHub organisation mode to `live`, disabling legacy release notices.
- [ ] Enable the worker's live mode with the agreed cutover timestamp.
- [ ] Enable GitHub and worker lifecycle writes only after field ownership is verified.

**To stop publication:** set the **worker** to `shadow`. Keep the organisation mode `live` so evidence recording continues and old notifications do not restart.

## When something goes wrong

| Symptom | Next step |
|---|---|
| Workflow cannot fetch a shared file at `@main` | Confirm the shared PR has merged, then rerun the dependent check. |
| Platform did not become Done | Check the PR merged into `main`, Work Item links/product, other open PRs and the incomplete declaration. After fixing access/configuration, retry **Work Item Development Completion** with the merged PR number. |
| Platform is Done but not Released | Check its approved delivery scope, completing-PR evidence, store build, dependencies and audience access. |
| Release evidence recording failed | Fix the error and retry **only the recording job**. Do not redeploy to retry a notification. |
| Release wording changed | Have the exact frozen content reviewed again. Changed wording invalidates publication readiness. |
| Slack delivery is uncertain | Inspect the original attempt and message receipt. Reconcile before retrying; reset Pending only after confirming no send occurred. |
| Shared lock is stuck | Follow the [lock recovery reference](release-ledger-reference.md). Verify no holder is active before deleting the exact lock ref. |
| Notion is unavailable | Restore integration access and retry failed work. Use independent hosted-run monitoring for alerts. |

<details>
<summary>Shadow acceptance checklist</summary>

- [ ] One feature spans repos, versions and platforms; consumer and Enterprise availability differ.
- [ ] A bug-fix-only release needs no Work Item; internal maintenance stays out of Slack; a backend customer feature can announce.
- [ ] Store upload, phased rollout and full availability remain distinct. Verify exact app identifiers and builds.
- [ ] Disabled flags, conditional access and delayed dependencies hold availability.
- [ ] Hotfixes, cherry-picks, failed/partial deployments and rollback preserve correct evidence.
- [ ] Missing links, delayed mirrors and more links than relation caps do not silently omit contents.
- [ ] Duplicate/concurrent events, Notion outages, uncertain Slack sends and edited wording cannot publish incorrectly.
- [ ] Main-merge completion, a manual retry, a shadow proposal and a multi-PR feature behave correctly.
- [ ] Each declared edition includes the exact completing PR before its platform becomes Released.
- [ ] Verify post-upload manifest snapshots for Enterprise, manual Android and the legacy iOS hotfix path before accepting those paths.
- [ ] Check for duplicate release identities, missing receipts and stuck locks.

</details>

<details>
<summary>Recorded access checks — 7 September 2026</summary>

- Hosted NotionWorkers capabilities are reachable; the release processor is not deployed.
- The hosted Notion credential returns 404 for both new datasets. Share Releases and Feature Availability with the existing worker integration before shadow execution.
- The local Notion credential returns 401; do not substitute it for the hosted integration.
- The local GitHub credential reads Console and the shared repository with write permission. Console connector access remains a separate limitation.
- Hosted Work Item Drift configuration has not been supplied. Lifecycle writes remain disabled.
- New Slack release/operations bot settings are not configured in the hosted worker. Existing Slack credentials have not been changed.

</details>

<details>
<summary>Unverified baseline candidates — 7 September 2026</summary>

These are exact latest GitHub release metadata candidates read on 7 September. They do not establish current production or customer availability. No historical announcements are allowed.

| Product / target | Candidate | Commit | Availability |
|---|---|---|---|
| Site Audit Pro / web | [v5.10.0](https://github.com/VeamStudios/SiteAuditPro-Web/releases/tag/v5.10.0) | `bab394a048b4b78a54328936553cbd2cacb91a91` | Unverified |
| Checklist Inspector Pro / web | [v1.3.0](https://github.com/VeamStudios/ChecklistInspectorPro-Web/releases/tag/v1.3.0) | `bdd520ce86a247af77856c47438ef0c9539da05b` | Unverified |
| Site Audit Pro / backend | [v3.52.1](https://github.com/VeamStudios/SiteAuditPro-Backend/releases/tag/v3.52.1) | `47b74e9a019dc03f259130ab8dc0892b0fd3331f` | Unverified |
| Checklist Inspector Pro / backend | [v0.37.0](https://github.com/VeamStudios/ChecklistInspectorPro-Backend/releases/tag/v0.37.0) | `2876592b31b0f6cb185517bd2b214d6b12fdae4b` | Unverified |
| Checklist Inspector Pro / ios-consumer | [v2.2.0](https://github.com/VeamStudios/ChecklistInspectorPro-iOS/releases/tag/v2.2.0) | `8a58654790a59a838ef6b1ec4462bc52d8757170` | Unverified |
| Site Audit Pro / website | [v0.0.27](https://github.com/VeamStudios/siteauditpro.com/releases/tag/v0.0.27) | `19f95504ba9ee9e351d7c4f882f4c1e9a9f96645` | Unverified |
| Checklist Inspector Pro / website | [v0.0.3](https://github.com/VeamStudios/checklistinspectorpro.com/releases/tag/v0.0.3) | `2b1de236ad1e18f145a70f0bf6f8c4ca1cf902c4` | Unverified |
| Shared CloudServices / cloudservices | [v1.14.0](https://github.com/VeamStudios/CloudServices/releases/tag/v1.14.0) | `3f82c3776ace46d2bfe52ccf806df7394adbecb1` | Unverified |
| Site Audit Pro / ios-consumer | [10.7.0.1](https://github.com/VeamStudios/SiteAuditPro-iOS/releases/tag/10.7.0.1) | `5a940d890e4d3dc7ca753efcb6e76ec911f294ad` | Unverified |

Enterprise iOS, Enterprise Android, consumer Android and Console still need exact current distribution/deployment evidence. A CIP Enterprise pipeline was not found in the current repository; do not infer an edition from the main app.

Baseline manifests are provided in `release-baseline-candidates.json`. They deliberately have incomplete provenance, no approved hash, no availability claim and no customer changelog. Import only after resolving integration access; verify each current build and intended audience before approving a baseline.

</details>

<details>
<summary>Implementation and validation record</summary>

- 7 September: release evidence, availability processing, Work Items views and draft callers prepared.
- 8 September: Work Items confirmed as the source of truth; Feature Status replaces the removed dashboard view. Automation does not depend on a dashboard page.
- 8 September: added platform Done on main merge and Released after verified platform availability. Both lifecycle switches remain gated; no Work Item status was changed during implementation.
- 114 worker tests and 15 shared release/completion tests passed; TypeScript typecheck and production compilation passed.
- Changed workflows passed actionlint. The initial implementation excluded its stale `create-github-app-token@v3` client-id diagnostic after checking the official action schema.
- Existing App Store and production mirror tests passed during the initial implementation.
- Real hosted shadow runs, App Store credentials, manual Android evidence, Slack scopes/channel membership and production verification remain rollout checks.

</details>


</details>
