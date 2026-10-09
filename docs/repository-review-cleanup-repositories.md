# Repository rules cleanup proposal

Audited 2026-10-09T22:36:58.669202+00:00. This file proposes configuration changes; nothing has been applied. Scope: 56 repositories; StaffManagerPro-Backend excluded.

Exact operations: 70 — 2 delete disabled legacy, 56 delete team review, 3 update classic reviews, 9 update ruleset.

Keep PRs, squash-only merging, existing conversation-resolution, CI and Work Item checks. Retain independent Safety/check/Work Item bypass lists. Review-only bypass lists disappear with Team review rulesets. CODEOWNERS files remain optional routing. No repository permission or team membership changes.

| Repository | Configuration changes |
|---|---|
| .github | Delete Team review #24578330 |
| AI-Setup | Delete Team review #24578339; Clear classic review settings on `main` |
| AIToolKit-iOS | Delete Team review #24580867 |
| ARCHIVE_Research_HTMLPDF | Delete Team review #24580886 |
| ASOMarketing | Delete Team review #24578353; Update Safety #24578350 |
| AdminPortal-iOS | Delete Team review #24578370; Update Safety #24578366 |
| Annotator-SAP | Delete Team review #24580900 |
| Annotator-Web | Delete Team review #24578382 |
| Annotator-iOS | Delete Team review #24580923 |
| AppCheckSample | Delete Team review #24580932 |
| BNHtmlPdfKit | Delete Team review #24580946 |
| BallAndBerry | Delete Team review #24580957 |
| ChecklistInspector-iOS | Delete Team review #24580974 |
| ChecklistInspectorPro-Backend | Delete Team review #24578398 |
| ChecklistInspectorPro-Models | Delete Team review #24578409; Delete disabled legacy #915123 |
| ChecklistInspectorPro-Web | Delete Team review #24578414 |
| ChecklistInspectorPro-iOS | Delete Team review #24578423 |
| CloudServices | Delete Team review #24578430 |
| CookBrown | Delete Team review #24580986 |
| CustomCamera | Delete Team review #24580997 |
| DrawSignature-iOS | Delete Team review #24581014 |
| ImageCaching-Android | Delete Team review #24581027 |
| ImageCaching-CIP | Delete Team review #24581037 |
| ImageCaching-SAP | Delete Team review #24578446 |
| Infrastructure | Delete Team review #24578451; Update Safety #1462357 |
| MapEditor-iOS | Delete Team review #24581052 |
| NotionWorkers | Delete Team review #24578458 |
| OperatingSystemPro | Delete Team review #24578468 |
| Planning | Delete Team review #24578474; Update Safety #24578473 |
| ReportLens | Delete Team review #24581073 |
| ReportPrototypes-Web | Delete Team review #24581086 |
| RiteHite | Delete Team review #24581118; Clear classic review settings on `main` |
| SSTN_Customer | Delete Team review #24581139 |
| SiteAuditPro-Android | Delete Team review #24581158 |
| SiteAuditPro-AndroidNew | Delete Team review #24581171; Update Required checks #24581173; Update Safety #2379591 |
| SiteAuditPro-Backend | Delete Team review #24578484 |
| SiteAuditPro-Console | Delete Team review #24581186 |
| SiteAuditPro-Models | Delete Team review #24578492; Delete disabled legacy #1462432 |
| SiteAuditPro-Promo | Delete Team review #24581203 |
| SiteAuditPro-Themes | Delete Team review #24581232 |
| SiteAuditPro-Web | Delete Team review #24581249 |
| SiteAuditPro-iOS | Delete Team review #24578200 |
| StaffManagerPro-Models | Delete Team review #24578503 |
| StaffManagerPro-StaffPortal | Delete Team review #24578514; Update Safety #24578512 |
| StaffManagerPro-iOS | Delete Team review #24578522; Update Safety #24578520 |
| Support | Delete Team review #24578530 |
| TS-Core | Delete Team review #24578535 |
| UIExperiments-iOS | Delete Team review #24581263 |
| checklistinspector.com | Delete Team review #24581276 |
| checklistinspectorpro.com | Delete Team review #24578540 |
| help-centres | Delete Team review #24581289; Update Safety #24581285; Clear classic review settings on `main` |
| huekit | Delete Team review #24581321 |
| siteauditpro.com | Delete Team review #24581348 |
| templates.checklistinspector.com | Delete Team review #24581380 |
| templates.cleversurveyapp.com | Delete Team review #24581404 |
| veamstudios.com | Delete Team review #24581441 |

## Legacy Models distinction

SAP Models legacy ruleset #1462432 contains only protections covered by retained Safety. CIP Models legacy #915123 additionally contains the disabled historical `check_pr_title / check_pr_title` context. It is not currently enforced, does not exist in current main workflows, and is deliberately not restored. Current active `Verify`, `check`, `release_contract`, `Build`, and `Run` requirements are preserved. Explicit deletion approval must acknowledge this historical difference.

## Verification limits

Audit repository merge-option fields are null, so this manifest does not infer or update them. Before applying, re-read every object and reject configuration drift. Use the exact review subresource for classic updates; do not replace whole branch protection. Existing request-changes reviews and conversation-resolution can still block a PR even with zero approval count.
