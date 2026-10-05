# PR flow

- Mark ready; enable GitHub **Auto-merge** once when opening the PR.
- Existing CODEOWNERS review, with `@harrygt` as backup. Authors cannot approve their own PRs.
- One independent owner approval + green required checks + current main → GitHub merges.
- New code dismisses approval. Review runtime behavior, dependencies and deploy effects.
- Aim for same-day review. Keep each developer to two ready PRs; use draft for unfinished work.

## Checks

| Required name | Details |
| --- | --- |
| Build | App Store, Enterprise, Cloud, Backend, Web or Package |
| Run | Tests, with the actual coverage stated |
| Verify | Work Item Linked, Lint Rules Pass, Formatting Matches, and other exact conditions |

The shared reporter reads existing workflow runs for the **current PR commit**. It
runs no product builds/tests again. Each check links to the original job. Missing,
cancelled, skipped or failed required evidence blocks. Work Item Linked checks the
PR URL format; it does not contact Notion. No NotionWorkers change is needed.

`profiles.json` is the single mapping of repo → required evidence. Caller workflows
only subscribe to their existing CI completion events. A shared update changes all
callers after review in `.github`; no downstream version-pin PR chain.

## Rollout

1. Review and merge the shared PR, then the caller PRs. Existing check names stay.
2. Run **PR Flow → Run workflow** in each adopting repo. Inspect Build/Run/Verify
   on a current green PR and a failing PR; exercise a rerun and a changed commit.
3. Run `python3 .github/actions/pr-flow/preflight.py REPO` for current ownership,
   authorship and rule evidence. Confirm CODEOWNERS has no GitHub errors and includes an independent reviewer.
   Harry-only repos need a different author or an additional real owner for Harry's PRs.
4. Generate the additive ruleset with `node .github/actions/pr-flow/policy.js REPO`.
   Apply that output to each proven repo; enable repository auto-merge. The generator
   requires all three summaries **and their native source checks**, bound to Actions.
   Retain stronger existing rules. `ruleset.json` is a template, not an activation file.
5. Replace the old three-label merge habit with native Auto-merge. Disable the old
   label merge job for opted-in repos only after proving the native path.
6. Keep native source checks required: summaries can briefly lag behind reruns.
   The shared config generates them, so there is no second manually maintained list.

Several existing team slugs are invalid in GitHub; replacement leads require
confirmation. Keep Harry as backup, not a substitute for an unknown lead.

Activation is a separate reviewed settings change. This PR does not enable
unattended merges, change branch rules, merge work, or deploy products. GitHub Team
supports native auto-merge; private-repo merge queues require Enterprise. Same-repo
stacks can help related PRs; cross-repo releases still need dependency order.

## Initial callers and coverage

- SAP/CIP Backend: existing build, source tests, Firebase rule tests and verification.
- SAP/CIP Models: generation/schema checks; tests cover the release workflow.
- SAP/CIP iOS: existing unsigned schemes; tests cover changelog tooling, **not app runtime**.
- CloudServices, TS-Core, Annotator-Web, ImageCaching-SAP: existing build/test CI.

Models caller PRs also need release coordination: their existing pipeline publishes
a new package and dispatches consumer updates after **every** merge, including CI-only
changes. Do not waive their changelog check; combine with a planned release or agree
a narrowly scoped release-trigger change first.

The inventory also records **blocked profiles**, without adding misleading green
checks or enabling auto-merge: SAP/CIP Web (tests absent from PR CI), SAP/CIP websites
(build/tests absent), Android (delivery build absent), Annotator-iOS and ImageCaching-CIP (tests absent),
NotionWorkers, AdminPortal, StaffManager repos and SAP Console (no PR build/test CI).
Agree the existing relevant command with the owner before adding their caller.
Archived/legacy repos, themes, prototypes and non-product planning/support repos are
outside this rollout. AI-Setup/help-centres retain their existing specialist gates.

Green CI is evidence of the listed checks, not proof of launch readiness. Leads
still approve behavior, breaking changes, app/runtime coverage and deploy side effects.

## Implementation constraints

- `pull_request_target` only runs trusted shared code. No PR checkout, artifact
  download, PR-controlled scripts, installation or app/private-key secrets.
- Source runs must be `pull_request` runs for the current SHA, branch and head repo.
- Pagination is exhausted. Latest runs/attempts win. Old success is invalidated first.
- Updates are scoped to this reporter's check IDs, never another app's checks.
- Checks are tied to GitHub Actions app ID 15368 in the proposed ruleset.
- Existing author/bot identities are unchanged; the separate identity audit owns that decision.

Sources: [native auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request),
[branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).
