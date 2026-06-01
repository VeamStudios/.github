# VeamStudios/.github

Shared GitHub Actions workflows, composite actions, and organisation defaults for all VeamStudios repositories.

## Composite Actions

### `select-xcode`

Selects a specific Xcode installation on macOS runners.

```yaml
- uses: VeamStudios/.github/.github/actions/select-xcode@main
  # with:
  #   xcode-version: "26.3"   # default
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

### `notify-release.yml`

Sends a Slack notification to the releases channel. Optionally checks out `changelog_git_ref` and excerpts the matching section from `CHANGELOG.md` (same repo as the caller) so Slack shows per-release notes plus links to the repository and GitHub release.

```yaml
jobs:
  notify:
    uses: VeamStudios/.github/.github/workflows/notify-release.yml@main
    with:
      version: v${{ inputs.version }}
      environment: production
      changelog_git_ref: ${{ needs.deploy.outputs.commit_sha }}
    secrets:
      SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}
```

- `changelog_git_ref` — set to the deployed commit (or other ref) so `CHANGELOG.md` at that SHA is used. When empty, only the generic `slack_footer_mrkdwn` line is sent.
- `slack_footer_mrkdwn` — used when the changelog is missing or has no `##` section for the version.

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
| `pr-ios-build.yml` | Build iOS app on pull requests |
| `pr-spm-package-update.yml` | Auto-update SPM package dependencies |
| `qa-pipeline.yml` | `Has Linked Notion Work Item` on PR open/update (WI URL required for `feat/` / `feature/` branches only); QA brief on `bot: qa needed` |
| `issue-cursor-agent.yml` | Triage GitHub issues with an AI agent |
| `release-notifications.yml` | iOS production Slack notification (beta/cloud provenance + optional CHANGELOG excerpt) |

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
| `qa.yml` | `BOT_QA_PRIVATE_KEY`, `vars.BOT_QA_APP_ID` | Caller for `qa-pipeline.yml` |
| `web-tests.yml` | none beyond `GITHUB_TOKEN` | `packages: read` is granted by the caller |
| `ios-tests.yml` | `BOT_RELEASE_PRIVATE_KEY`, `vars.BOT_RELEASE_APP_ID` | Same Release Bot App used by `pr-ios-build.yml` |
| `dependency-review.yml` | `GITHUB_TOKEN` | None required; uses `actions/dependency-review-action` |
| `stale.yml` | `GITHUB_TOKEN` | `issues: write`, `pull-requests: write` granted by reusable |
| `auto-assign-reviewers.yml` | `GITHUB_TOKEN` | `pull-requests: write` granted by reusable |

## Versioning

All references use `@main` so repos pick up updates automatically. If you need stability, pin to a specific commit SHA.
