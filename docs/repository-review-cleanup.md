# Repository review cleanup proposal

Status: proposed; not activated. Merging this PR changes only the files in this repository. It neither changes repository settings nor approves a later rollout. Exact action-time approval from Harry is required before any GitHub settings mutation.

The proposed policy trusts developers to choose when human review is useful. Pull requests and required CI remain mandatory, but approvals, CODEOWNER approvals and automatic approval dismissal are no longer merge requirements. CODEOWNERS files stay for optional routing. Auto-merge remains available and per-PR opt-in. Models follow the same approval-free policy; their publishing workflows and checked release metadata remain unchanged.

Scope: the original 56-repository rollout, excluding inactive StaffManagerPro-Backend. [Per-repository changes](repository-review-cleanup-repositories.md) list every affected rule ID and branch pattern. [Exact configuration plan](repository-review-cleanup-plan.json) contains before snapshots, requests and expected results. The snapshot is evidence, not a substitute for a fresh preflight.

## Exact proposed changes

| Operation | Count | Scope |
|---|---:|---|
| Delete obsolete Team review rulesets and their review-only bypass lists | 56 | All repositories in scope, including currently disabled review sets |
| Delete disabled historical rulesets | 2 | SAP Models and CIP Models |
| Remove extra approval for unattributed changes | 6 | ASOMarketing, AdminPortal-iOS, Infrastructure, Planning, StaffManagerPro-StaffPortal, StaffManagerPro-iOS Safety |
| Restore Safety | 2 | AndroidNew and help-centres |
| Restore required CI | 1 | AndroidNew |
| Clear classic review requirements and stale-review dismissal | 3 | AI-Setup main, help-centres main, RiteHite main (whose default branch is dev) |

Safety retains the PR requirement, squash-only merges, and protection against default-branch force-push and deletion. All other active Required checks and Work Item rules remain unchanged, including exact context names, application bindings, and current-branch requirements. No permissions, team membership, bot identities, or independent bypass lists change. No release workflow or application file change is needed.

The six existing Safety conversation-resolution requirements and AI-Setup/help-centres classic conversation-resolution requirements remain. A requested-changes review may still need to be addressed or legitimately dismissed even with zero required approvals; this proposal is not a guarantee that every PR with passing CI can merge irrespective of review state. Substantive feedback should still be resolved with the reviewer. Non-blocking comments can be consciously accepted by the team.

## Disabled legacy Models rules

SAP Models' historical rules contain deletion and force-push protections already covered by Safety. CIP Models' disabled historical set also names `check_pr_title / check_pr_title`, which is absent from its current main workflows and active required checks. The proposal deliberately removes that obsolete disabled-only reference rather than reactivating an unreported check. Current enforced source checks, native Build/Run/Verify, and release-contract validation are retained exactly. This non-equivalence is recorded in the manifest for review.

## Read-only validation

From the repository root:

```sh
python3 scripts/ruleset_cleanup_review.py docs/repository-review-cleanup-plan.json
python3 scripts/ruleset_cleanup_review.py docs/repository-review-cleanup-plan.json --check-live
python3 -m unittest discover -s tests -p 'test_ruleset_cleanup_review.py'
```

The validator has no mutation or apply mode. Live comparison uses authenticated GitHub CLI GET requests only. Use an existing authorized account; do not change identity or scopes as part of checking the proposal.

## Activation boundary

After review, re-read every target and retained resource, abort on configuration drift, and present the exact plan and fingerprint for Harry's separate approval. Capture fresh exports before writing. Restore retained Safety and Android CI before deleting their review layer. Apply only the listed requests, read each resource back, and verify all remaining protections and required checks. Do not merge application PRs, enable their auto-merge, or trigger releases as part of settings cleanup.

Deleted rulesets cannot be undeleted under their original IDs; recovery recreates configuration from the exports with new IDs. Preserve the deletion snapshots and record any recreated IDs. Keep the original plan as a dated proposal and publish rollout receipts separately after an authorized activation.
