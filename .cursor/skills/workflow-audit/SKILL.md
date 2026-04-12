---
name: workflow-audit
description: >-
  Audit and compare GitHub Actions workflows across VeamStudios repositories for
  consistency. Use when the user wants to run the workflow audit, review workflow
  differences, compare workflow snapshots, standardize CI/CD across repos, or
  mentions audit.rb, by-type, or workflow consistency.
---

# Workflow Audit

Compare GitHub Actions caller workflows across the ChecklistInspectorPro and SiteAuditPro
repository families to find and resolve inconsistencies.

## Key Files

| File | Purpose |
|------|---------|
| `tools/actions-audit/repos.yml` | Manifest of repos, branches, and families to audit |
| `tools/actions-audit/audit.rb` | Script that fetches workflows via `gh` API and generates snapshots + diffs |
| `audit/by-type/README.md` | Index table of all workflow groups with diff status |
| `audit/by-type/<scope>/<category>/differences.md` | Plain-English summary of structural differences |
| `audit/by-type/<scope>/<category>/snapshots/*.yml` | Raw YAML snapshots named `<repo-key>__<category>.yml` |

## Phase 1: Run the Audit

Prerequisites: `gh` CLI authenticated with access to VeamStudios repos, Ruby installed.

```bash
ruby tools/actions-audit/audit.rb
```

This wipes `audit/` and regenerates everything fresh. Takes ~30-60 seconds (API calls).

Output structure:

```
audit/
  by-type/
    README.md                          # index table
    <scope>/<category>/
      differences.md                   # plain-English diff summary
      snapshots/<repo-key>__<cat>.yml  # raw YAML per repo
  inventory/                           # JSON reference data
  reports/
    consistency-report.md              # high-level summary
```

After running, read `audit/by-type/README.md` to show the user which workflow groups have
differences (the `Differences` column says `yes`).

## Phase 2: Interactive Review

When the user asks to review a workflow type (e.g. "let's review ios/deploy-beta"):

### Step 1 -- Read the summary

Read `audit/by-type/<scope>/<category>/differences.md`.

If it says "All snapshots are structurally identical" -- tell the user and move on.

### Step 2 -- Load the snapshots

Read all files in `audit/by-type/<scope>/<category>/snapshots/`.
The baseline snapshot is identified in `differences.md`.

### Step 3 -- Walk through each difference

For each bullet in the "Different" section of `differences.md`:

1. Show the relevant YAML from both snapshots side by side using code references.
2. Explain what the difference means in plain language.
3. Flag whether the difference looks **product-specific** (contains repo/product names like
   `cip`, `sap`, `ChecklistInspectorPro`, `SiteAuditPro`, package names, dispatch event
   types) or **unintentional drift** (different action versions, missing steps, different
   auth methods for the same purpose).
4. Ask the user what to do:
   - **Align**: make the differing repo match the baseline
   - **Keep different**: intentional per-repo difference, leave as-is
   - **Use this version instead**: adopt the differing repo's approach as the new standard

### Step 4 -- Summarize decisions

After all differences are reviewed, output a summary table:

```markdown
| Difference | Decision | Notes |
|------------|----------|-------|
| `jobs.deploy.with.ipa_path` | Keep different | Product-specific path |
| `jobs.update.steps[0].uses` | Align to baseline | Should use same auth method |
```

### Step 5 -- Apply changes (if requested)

If the user says "apply" or "make the changes":

1. Confirm which repos and files will be modified.
2. The target files live in the external repos, not this workspace. Ask the user for
   local checkout paths if needed.
3. Make the YAML edits directly in the target repo checkouts.

## Scope Categories

Workflows are grouped by platform family and category:

- **backend/**: `ci`, `deploy-dev`, `deploy-beta`, `deploy-production`, `notify-release`, `update-models`
- **ios/**: `deploy-dev`, `deploy-beta`, `deploy-production`, `pr-build`, `hotfix-prepare`, `hotfix-deploy`, `generate-screenshots`, `update-models`
- **web/**: `ci`, `deploy-dev`, `deploy-beta`, `deploy-production`, `firebase-hosting-pull-request`, `notify-release`, `update-models`
- **models/**: `ci`, `release`
- **cross-repo/**: `pr-title-check`, `qa-pipeline`, `issue-bot`, `pr-notion-docs-sync`

## What Counts as a Difference

The audit uses **structural equality**: YAML is parsed, the top-level `name` key is ignored,
and values are compared recursively. Comments, blank lines, and formatting are ignored.

Differences are reported as YAML paths like `jobs.update.steps[0].uses` with the current
value and the baseline value.

## Tips

- Product-specific values (package names, dispatch event types, IPA paths, project IDs) are
  expected to differ and should almost always be kept different.
- Auth method differences (PAT via `VEAM_READ_TOKEN` vs GitHub App token via
  `create-github-app-token`) are worth standardizing -- the App token approach is generally
  preferred.
- Action version differences (`github-script@v7` vs `@v8`) should be aligned to the latest.
- If one repo has extra steps (like `Detect package changes`) that the other lacks, consider
  whether the extra step is an improvement worth adopting everywhere.

## Updating the Manifest

To add or change repos, edit `tools/actions-audit/repos.yml`. Each entry needs:

```yaml
- key: short-name        # e.g. sap-ios
  owner: VeamStudios
  name: RepoName
  url: https://github.com/VeamStudios/RepoName
  product: ProductName    # ChecklistInspectorPro or SiteAuditPro
  family: ios             # ios, web, backend, or models
  source:
    type: branch          # or "pr"
    ref: main             # branch name or commit SHA
    label: main           # display label
```

For a PR branch, use the PR's head SHA or branch name and set `label` to something like `pr-1234`.
