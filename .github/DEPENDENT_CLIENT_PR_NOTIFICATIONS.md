# Dependent Web/iOS PR notifications (backend deploy)

Backend deploy workflows (SAP and CIP: dev, beta, production) call [`notify-dependent-client-prs.yml`](workflows/notify-dependent-client-prs.yml).

## Mention convention

In **Web** and **iOS** PR descriptions, cite the blocking backend PR with the **full** repo reference so automation can find open PRs:

| Product | Example mention |
|---------|-----------------|
| SAP | `VeamStudios/SiteAuditPro-Backend#142` |
| CIP | `VeamStudios/ChecklistInspectorPro-Backend#88` |

Avoid bare `#123` in client repos (ambiguous). Multiple timeline comments may appear as the backend promotes **dev → beta → prod**.

## Workflow inputs (optional)

| Input | Purpose |
|-------|---------|
| **backend_pr_numbers** | Comma-separated PR numbers for this deploy; if empty, resolved via GitHub “pulls associated with commit” for `deploy_sha`. |
| **dependent_pr_urls** | Newline-separated full PR URLs on Web/iOS to notify even when search misses. |

## Bot permissions

The Release Bot GitHub App must be able to comment on the Web and iOS repositories (`pull_requests: write`). Organization variable `BOT_RELEASE_CLIENT_ID` must be available to each backend repo.
