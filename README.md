# VeamStudios/.github

Shared GitHub Actions workflows, composite actions, and organisation defaults for all VeamStudios repositories.

## Composite Actions

### `select-xcode`

Selects either an exact stable Xcode release or `latest-stable` (the action default), verifies the resolved Xcode and Swift versions, and publishes them in the job summary. Beta installations are excluded even when a numeric application symlink exists.

Shared workflows default to Xcode `27.0`; direct callers pin `27.0` explicitly. The action default remains runner-relative so existing direct callers can migrate independently.

Xcode 27 jobs use `xcode-27` or `xcode-27-xlarge`; `macos-26` images contain Xcode 26 only. Shared build, test, and deployment workflows retain the macOS 26 runner when a caller explicitly requests `26.x`, allowing caller PRs to land after the shared update. `latest-stable` selects from the Xcode 27 image.

The [20260912.0186 runner image](https://github.com/actions/runner-images/releases/tag/xcode-27-arm64/20260912.0186), published on 2026-09-17, includes Xcode 27.0 build `27A266a`, matching [Apple's September 14 release](https://developer.apple.com/news/releases/), despite retaining a `Release_Candidate` application directory. The image is still rolling out, so require the Xcode toolchain checks on both runner sizes before merging. Merge the shared change before the SAP, CIP, Annotator, and ImageCaching caller updates.

```yaml
- uses: VeamStudios/.github/.github/actions/select-xcode@main
  with:
    xcode-version: "27.0"
    minimum-swift-version: "6.3"
```

### `setup-node-github-packages`

Installs Node.js and configures npm/yarn to authenticate with the `@veamstudios` GitHub Packages registry. Works with both `npm ci` and `yarn publish`.

```yaml
- uses: VeamStudios/.github/.github/actions/setup-node-github-packages@main
  # with:
  #   node-version: "24.x"   # default
  #   cache: "npm"            # or "yarn"
```

### `setup-asc-api-key`

Writes the App Store Connect API key `.p8` file to the filesystem for Fastlane and xcodebuild.

```yaml
- uses: VeamStudios/.github/.github/actions/setup-asc-api-key@main
  with:
    key-id: ${{ secrets.APP_STORE_CONNECT_API_KEY_ID }}
    key-content: ${{ secrets.APP_STORE_CONNECT_API_KEY_CONTENT }}
```

## Reusable Workflows

All reusable workflows are called with `uses:` at the job level.

### `web-ci.yml`

Full CI pipeline for web apps: format check, lint, typecheck, and build.

```yaml
jobs:
  ci:
    uses: VeamStudios/.github/.github/workflows/web-ci.yml@main
    # with:
    #   node_version: "24.x"   # default
    #   build_command: "build"  # default
```

### `merge-gate.yml`

Checks whether any PRs were merged to a branch within a time window. Used by nightly deploy workflows to skip builds when nothing changed.

```yaml
jobs:
  check:
    uses: VeamStudios/.github/.github/workflows/merge-gate.yml@main
    permissions:
      pull-requests: read
    # with:
    #   base_branch: "main"   # default
    #   window_hours: 24       # default
```

**Output:** `should_deploy` (`"true"` / `"false"`)

### `create-github-release.yml`

Mints a Release Bot token and creates a GitHub release with optional auto-generated notes.

```yaml
jobs:
  release:
    uses: VeamStudios/.github/.github/workflows/create-github-release.yml@main
    with:
      version: ${{ inputs.version }}
      deploy_sha: ${{ needs.deploy.outputs.commit_sha }}
      environment: prod
    secrets:
      BOT_RELEASE_PRIVATE_KEY: ${{ secrets.BOT_RELEASE_PRIVATE_KEY }}
```

**Outputs:** `release_url`, `tag_name`

### Release recording and announcements

Production callers use `record-release.yml` to save exact shipped evidence in Notion. `reconcile-app-store.yml` verifies the exact iOS build and distribution state. NotionWorkers publishes eligible release entries to Slack and saves a receipt before retries can send again. There is one release publisher.

`complete-work-item-development.yml` records merged PR/head evidence. The team completes QA through the existing platform Dev Status field; verified production availability then allows the worker to mark that platform Released.

See [the release system reference](docs/release-ledger-reference.md) for website changelog paths, held entries and recovery previews.

### `remote-config-notion-sync.yml`

For sync retries, use the current standalone workflow. An old run may contain a retired workflow reference; rerunning that historical caller can no longer resolve the removed path.

Mirrors production observations into Work Items, the source of truth for feature scope, ownership and status. Feature Status is a view of those same records. The shared workflow/action and product schedule files use `remote-config-notion-sync`; they do not depend on a dashboard page. The `launch-hub-sync-prod` GitHub environment retains its configured credentials. It copies production Remote Config defaults such as `missing`, `false`, `research-preview`, `true`, or any other Firebase default string, plus `no platform key` when a Work Item has no Remote Config key for that platform. It also mirrors production deployment/release evidence. It does not establish intended-audience availability or decide whether a feature should be enabled. Platform lifecycle writes belong to the release ledger; this mirror does not set release status.

`Last Production Sync` changes only alongside values from a successful Firebase read. A failed read leaves the previous observation intact. Calls with no Firebase project are a no-op. Missing required configuration, API read failures and failed Notion updates fail the sync job with an error summary; one failed Work Item update does not stop the others. A failed sync after deployment does not mean the deployment failed. Correct the reported problem and retry the sync job or the standalone sync workflow, not the deployment. Dry runs perform the same reads and report errors but never write to Notion.

```yaml
jobs:
  remote-config-notion-sync:
    uses: VeamStudios/.github/.github/workflows/remote-config-notion-sync.yml@main
    with:
      product: cip
      platform: web
      firebase_project_id: checklistinspectorpro
      github_environment: prod
    secrets: inherit
```

- `product` — product slug used to filter Work Items. Supported values are `cip` and `sap`.
- `product_page_id` — optional Notion Product page ID override.
- `platform` — one of `ios`, `web`, `android`, `backend`, or `all`; deployment/release status writes only apply to `ios`, `web`, and `android`. `backend` and `all` refresh Remote Config values only.
- `firebase_project_id` — optional production Firebase project ID. When set with `SERVICE_ACCOUNT_BASE64`, the workflow reads the production Remote Config template and writes exact values to the `iOS Prod RC Value`, `Web Prod RC Value`, and `Android Prod RC Value` select fields. A configured key absent from Firebase is written as `missing`; a blank platform key is written as `no platform key`.
- `github_environment` — optional GitHub environment name, such as `prod`, used when `SERVICE_ACCOUNT_BASE64` is scoped to a deployment environment.
- Platform Dev Status is owned by the release ledger: merged PR → Done, verified deployment/live build → Released. This action only refreshes Remote Config values and evidence. The reusable workflow accepts legacy production inputs as ignored compatibility fields for older callers.
- `production_version` — deprecated and ignored. Work Items do not store a shared production version.
- `dry_run` — prints the planned updates without changing Notion.

### `update-changelog-website.yml`

Copies a `CHANGELOG.md` from the caller repo to a marketing website repo.

```yaml
jobs:
  changelog:
    uses: VeamStudios/.github/.github/workflows/update-changelog-website.yml@main
    with:
      source_file: CHANGELOG.md
      deployed_ref: ${{ needs.deploy.outputs.commit_sha }}
      destination_repo: VeamStudios/example.com
      destination_folder: src/assets/changelog
      version: v${{ inputs.version }}
    secrets: inherit
```

### `web-tests.yml`

Runs tests for a Node-based repo. Pairs with `web-ci.yml` (which does lint/typecheck/build).

```yaml
jobs:
  tests:
    uses: VeamStudios/.github/.github/workflows/web-tests.yml@main
    # with:
    #   node_version: "24.x"
    #   test_command: "test"
    #   coverage_artifact_path: "coverage"
```

### `ios-tests.yml`

Runs `xcodebuild test` on a scheme against a simulator destination. Uses the Release Bot App for SwiftPM private deps, same as `pr-ios-build.yml`.

```yaml
jobs:
  tests:
    uses: VeamStudios/.github/.github/workflows/ios-tests.yml@main
    with:
      scheme: "SiteAuditPro"
      project: "SiteAuditPro.xcodeproj"
    secrets:
      BOT_RELEASE_PRIVATE_KEY: ${{ secrets.BOT_RELEASE_PRIVATE_KEY }}
```

### `dependency-review.yml`

Blocks PRs that add known-vulnerable packages (GHSA advisories) or disallowed licenses. Thin wrapper around `actions/dependency-review-action`.

```yaml
jobs:
  review:
    uses: VeamStudios/.github/.github/workflows/dependency-review.yml@main
    with:
      fail_on_severity: high
```

### `stale.yml`

Marks inactive issues/PRs as stale and eventually closes them. Schedule from the caller (daily cron is typical). Label `keep-open` exempts an item from the sweep.

```yaml
jobs:
  stale:
    uses: VeamStudios/.github/.github/workflows/stale.yml@main
```

### `auto-assign-reviewers.yml`

Requests reviewers (users and/or teams) the moment a PR opens or is marked ready. Complements CODEOWNERS.

```yaml
jobs:
  assign:
    uses: VeamStudios/.github/.github/workflows/auto-assign-reviewers.yml@main
    with:
      reviewers: "alice,bob,carol"
      team_reviewers: "ios"
```

### Other workflows

| Workflow | Purpose |
|---|---|
| `deploy-ios-testflight.yml` | Build and upload an iOS app to TestFlight |
| `hotfix-prepare.yml` / `hotfix-deploy.yml` | iOS hotfix branch and deploy flow |
| `remote-config-notion-sync.yml` | Mirror production Remote Config values and deployment/release state into Work Items |
| `pr-ios-build.yml` | Build iOS app on pull requests |
| `pr-spm-package-update.yml` | Auto-update SPM package dependencies |
| `qa-pipeline.yml` | PR governance: `Has Linked Notion Work Item` on PR open/update (`Work Items:` list with one or more Notion WI URLs required for `feat` titles, including scoped or breaking forms; singular `Work Item:` remains supported), `bot: qa needed` routing to QA Project 26 as `Not Started`, and label-gated QA auto-merge |
| `issue-cursor-agent.yml` | Triage GitHub issues with an AI agent |

## Caller Templates

The `caller-templates/` directory contains example workflow files that repos can copy to adopt shared workflows quickly.

### Which templates each repo should adopt

| Repo | Templates to copy |
|---|---|
| `ChecklistInspectorPro-iOS` | `qa.yml`, `checklistinspectorpro-ios-tests.yml`, `dependency-review.yml`, `stale.yml`, `auto-assign-reviewers.yml` |
| `ChecklistInspectorPro-Web` | `qa.yml`, `web-ci.yml`, `web-tests.yml`, `dependency-review.yml`, `stale.yml`, `auto-assign-reviewers.yml` |
| `ChecklistInspectorPro-Backend` | `qa.yml`, `web-tests.yml` (if Node), `dependency-review.yml`, `stale.yml`, `auto-assign-reviewers.yml` |
| `SiteAuditPro-iOS` | `qa.yml`, `siteauditpro-ios-tests.yml`, `dependency-review.yml`, `stale.yml`, `auto-assign-reviewers.yml` |
| `SiteAuditPro-Web` | `qa.yml`, `web-ci.yml`, `web-tests.yml`, `dependency-review.yml`, `stale.yml`, `auto-assign-reviewers.yml` |
| `SiteAuditPro-Backend` | `qa.yml`, `web-tests.yml` (if Node), `dependency-review.yml`, `stale.yml`, `auto-assign-reviewers.yml` |

### Required secrets

The new templates rely on secrets already configured at the org or repo level:

| Template | Secrets | Notes |
|---|---|---|
| `qa.yml` | `BOT_QA_PRIVATE_KEY`, org `vars.BOT_QA_CLIENT_ID` | Caller for `qa-pipeline.yml`; the QA GitHub App needs Organization Projects write access |
| `web-tests.yml` | none beyond `GITHUB_TOKEN` | `packages: read` is granted by the caller |
| `ios-tests.yml` | `BOT_RELEASE_PRIVATE_KEY`, org `vars.BOT_RELEASE_CLIENT_ID` | Same Release Bot App used by `pr-ios-build.yml` |
| `remote-config-notion-sync.yml` | `NOTION_TOKEN`, `SERVICE_ACCOUNT_BASE64` | `SERVICE_ACCOUNT_BASE64` is only required when reading Firebase Remote Config; use `github_environment` when it is environment-scoped |
| `dependency-review.yml` | `GITHUB_TOKEN` | None required; uses `actions/dependency-review-action` |
| `stale.yml` | `GITHUB_TOKEN` | `issues: write`, `pull-requests: write` granted by reusable |
| `auto-assign-reviewers.yml` | `GITHUB_TOKEN` | `pull-requests: write` granted by reusable |

## Versioning

All references use `@main` so repos pick up updates automatically. If you need stability, pin to a specific commit SHA.
