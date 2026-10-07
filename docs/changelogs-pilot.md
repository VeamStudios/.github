# SAP iOS Changelogs format and links

This draft checks `CHANGELOG.md` structure and link syntax in SAP iOS's existing **Changelogs / Coverage** check. Diagnostics appear in the job summary and as warnings with repair instructions. This phase adds no blocking gate: a successful job means the diagnostic action ran, and the summary says whether the supported format/link checks passed.

## For PR authors

Edit only `CHANGELOG.md` when your change needs a release note. Put meaningful features under **New**, user-affecting fixes under **Fixed**, and consequential migrations, permissions, compatibility or rollout changes under **Internal** in the upcoming release section. Ordinary tests, formatting, behaviour-preserving refactors and CI/docs maintenance need no entry unless they have a material effect. No new bullet is required for every PR; an adequate existing entry can cover related work in the same upcoming release.

The check reads the exact PR head's changelog as data and reports malformed structure or Work Item/source-PR links. Follow its correction in `CHANGELOG.md`, then push to rerun. A missing or unreadable changelog is reported as an input problem. Reviewers review wording in the ordinary changelog diff and decide whether it covers the actual change. Existing feature Work Item checks remain separate. No changelog-specific labels, declarations or author-managed JSON files are needed.

## What this phase verifies

The deterministic check validates the supported release headings, categories, bullet structure and link syntax. It does not decide whether code needs a release note, whether wording is adequate, whether an entry has already shipped, or whether a linked remote page exists. It does not verify public availability or distinguish consumer and Enterprise release history. Keep published history intact through normal review and the existing release process.

No model, provider call, credential or release-baseline artifact is used. Repository code is not executed or uploaded. A future automated shipped-history guard would need a current trusted release baseline and separate approval; it is outside this phase.

## Workflow integration and tests

The shared workflow retains `coverage-mode: preview` as its advisory default for existing callers. SAP iOS opts into `coverage-mode: deterministic`, which runs the new format/link diagnostics instead of the legacy new-entry preview. The approved **Changelogs / Coverage** names remain unchanged. Existing package release guards and release-ledger availability checks remain separate.

The SAP caller and new shared action temporarily reference `ci/sap-changelogs-pilot-20261007` so the two draft PRs can be reviewed together. Restore those references to `@main` only after the shared dependency has merged. SAP remains the first pilot; merging, required-gate activation, deployment and rollout to additional repositories are separate decisions.

The agreed semantic coverage cases remain policy expectations for a later phase. They do not demonstrate that this format/link checker can assess meaningful effects or changelog coverage.

Run the shared regression suite locally:

```sh
node --test .github/actions/release-ledger/*.test.js .github/actions/remote-config-notion-sync/*.test.js
```
