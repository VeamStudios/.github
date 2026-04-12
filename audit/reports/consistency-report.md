# Cross-Repo Workflow Consistency Report

Generated at `2026-04-12T18:01:54Z`.
Source manifest: `tools/actions-audit/repos.yml`.

## Repo Summary

| Repo | Family | Source | Workflows | Shared Calls | Legacy Calls | Local Calls |
| --- | --- | --- | --- | --- | --- | --- |
| VeamStudios/ChecklistInspectorPro-iOS | ios | main | 12 | 13 | 0 | 0 |
| VeamStudios/ChecklistInspectorPro-Models | models | main | 3 | 1 | 0 | 0 |
| VeamStudios/ChecklistInspectorPro-Backend | backend | main | 9 | 1 | 0 | 5 |
| VeamStudios/ChecklistInspectorPro-Web | web | main | 11 | 3 | 0 | 4 |
| VeamStudios/SiteAuditPro-Web | web | main | 11 | 3 | 0 | 4 |
| VeamStudios/SiteAuditPro-iOS | ios | pr-2393 | 11 | 12 | 0 | 0 |
| VeamStudios/SiteAuditPro-Models | models | main | 3 | 1 | 0 | 0 |
| VeamStudios/SiteAuditPro-Backend | backend | main | 10 | 2 | 0 | 5 |

## Key Findings

- Reusable workflows with undeclared secret dependencies: deploy-ios-testflight.yml, hotfix-deploy.yml, hotfix-prepare.yml, pr-spm-package-update.yml, update-changelog-website.yml.
- Org-level secrets/variables could not be inventoried with the current token.

## Review

Browse `audit/by-type/` for snapshots grouped by workflow type.
Each folder contains raw YAML snapshots and a `differences.md` summary.
To walk through differences interactively, ask the AI to review a specific folder.
