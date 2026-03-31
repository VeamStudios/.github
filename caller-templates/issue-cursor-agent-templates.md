# Issue Cursor Agent Caller Templates

Use these examples to call the reusable workflow at `VeamStudios/.github/.github/workflows/issue-cursor-agent.yml@main`.

## Required configuration

- Repository variable: `BOT_CURSOR_APP_ID`
- Repository secret: `BOT_CURSOR_PRIVATE_KEY`
- Repository secret: `CURSOR_API_KEY`

## Minimal caller

Use this when you want both `bot: fix` and `bot: triage` with the workflow defaults.

```yaml
name: Issue Bot

on:
  issues:
    types: [labeled]

jobs:
  cursor-agent:
    if: "${{ github.event.label.name == 'bot: fix' || github.event.label.name == 'bot: triage' }}"
    uses: VeamStudios/.github/.github/workflows/issue-cursor-agent.yml@main
    with:
      github-app-id: ${{ vars.BOT_CURSOR_APP_ID }}
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      GITHUB_APP_PRIVATE_KEY: ${{ secrets.BOT_CURSOR_PRIVATE_KEY }}
```

## JavaScript repo caller

Use this when the agent should install dependencies before running and CI should verify with a deterministic test command after `bot: fix`.

```yaml
name: Issue Bot

on:
  issues:
    types: [labeled]

jobs:
  cursor-agent:
    if: "${{ github.event.label.name == 'bot: fix' || github.event.label.name == 'bot: triage' }}"
    uses: VeamStudios/.github/.github/workflows/issue-cursor-agent.yml@main
    with:
      github-app-id: ${{ vars.BOT_CURSOR_APP_ID }}
      setup-command: npm ci
      test-command: npm test -- --runInBand
      extra-prompt: |
        This repository uses npm.
        Prefer targeted changes.
        Keep PR descriptions concise and reviewer-friendly.
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      GITHUB_APP_PRIVATE_KEY: ${{ secrets.BOT_CURSOR_PRIVATE_KEY }}
```

## Customized labels caller

Use this when a repo wants different labels or branch naming while keeping the same workflow behavior.

```yaml
name: Issue Bot

on:
  issues:
    types: [labeled]

jobs:
  cursor-agent:
    if: "${{ github.event.label.name == 'ai: fix' || github.event.label.name == 'ai: triage' }}"
    uses: VeamStudios/.github/.github/workflows/issue-cursor-agent.yml@main
    with:
      github-app-id: ${{ vars.BOT_CURSOR_APP_ID }}
      fix-label: ai: fix
      triage-label: ai: triage
      branch-prefix: automation/issue
      post-start-comment: false
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      GITHUB_APP_PRIVATE_KEY: ${{ secrets.BOT_CURSOR_PRIVATE_KEY }}
```

## Local caller for testing in this repo

Use this while iterating on the reusable workflow before another repository consumes it.

```yaml
name: Issue Bot Test

on:
  issues:
    types: [labeled]

jobs:
  cursor-agent:
    if: "${{ github.event.label.name == 'bot: fix' || github.event.label.name == 'bot: triage' }}"
    uses: ./.github/workflows/issue-cursor-agent.yml
    with:
      github-app-id: ${{ vars.BOT_CURSOR_APP_ID }}
      setup-command: echo "Add repo-specific setup here"
      test-command: echo "Add repo-specific verification here"
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      GITHUB_APP_PRIVATE_KEY: ${{ secrets.BOT_CURSOR_PRIVATE_KEY }}
```
