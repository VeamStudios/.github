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
  #   node-version: "20.x"   # default
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
    #   node_version: "20.x"   # default
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

Sends a Slack notification to the releases channel.

```yaml
jobs:
  notify:
    uses: VeamStudios/.github/.github/workflows/notify-release.yml@main
    with:
      version: v${{ inputs.version }}
      environment: production
    secrets:
      SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}
```

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

### Other workflows

| Workflow | Purpose |
|---|---|
| `deploy-ios-testflight.yml` | Build and upload an iOS app to TestFlight |
| `hotfix-prepare.yml` / `hotfix-deploy.yml` | iOS hotfix branch and deploy flow |
| `pr-ios-build.yml` | Build iOS app on pull requests |
| `pr-title-conventions.yml` | Enforce PR title format |
| `pr-notion-docs-sync.yml` | Sync PR content to Notion |
| `pr-spm-package-update.yml` | Auto-update SPM package dependencies |
| `qa-pipeline.yml` | QA test pipeline |
| `issue-cursor-agent.yml` | Triage GitHub issues with an AI agent |
| `release-notifications.yml` | Extended release notifications (iOS) |

## Caller Templates

The `caller-templates/` directory contains example workflow files that repos can copy to adopt shared workflows quickly. For Notion PR sync, copy `pr-notion-docs-sync.yml`. See [.github/pr-notion-docs-sync.md](.github/pr-notion-docs-sync.md).

## Versioning

All references use `@main` so repos pick up updates automatically. If you need stability, pin to a specific commit SHA.
