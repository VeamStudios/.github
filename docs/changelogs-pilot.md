# SAP iOS Changelogs pilot

This draft adds diagnostic coverage preparation to SAP iOS's existing **Changelogs / Coverage** check. Other repositories keep the current advisory preview. The pilot does not enable a required semantic gate.

## For PR authors

Edit only `CHANGELOG.md` when your change needs a release note. Describe a meaningful feature under **New**, a user-affecting fix under **Fixed**, or a consequential migration, permission, compatibility or rollout change under **Internal** in the upcoming release section. Ordinary tests, formatting, behaviour-preserving refactors and CI/docs maintenance need no entry unless they have a material effect.

An existing entry in this PR's exact head can cover related changes in the same upcoming release when its wording and existing Work Item/source-PR links actually cover the change. A shipped entry or a promised entry in another unmerged PR cannot supply coverage. Keep published history intact. No changelog-specific labels, PR declarations or author-managed JSON files are needed. Existing feature Work Item requirements remain separate.

Open the **Changelogs / Coverage** job summary to read the preview and diagnostics. Reviewers review wording in the ordinary `CHANGELOG.md` diff. This pilot reports input problems and uncertainty explicitly; a green job does not certify semantic coverage or public availability.

## Draft implementation

The shared workflow accepts `coverage-mode: preview` (the unchanged default) or `coverage-mode: pilot` (SAP iOS only). Pilot diagnostics run after the existing entry/Work Item preview. The collector reads exact head/base Git objects and complete changed-file evidence without running PR code. Results must match those SHAs and the collected input digest. Findings must cite supplied changed lines; coverage can refer only to eligible upcoming entries.

The internal result contract distinguishes four outcomes:

| Outcome | Meaning | Pilot behaviour |
| --- | --- | --- |
| `pass` | Evidence supports coverage, or a specific reason no note is needed | Show the reason |
| `missing_note` | A supported effect is not covered | Show the source, suggested heading and precise `CHANGELOG.md` correction |
| `review` | Evidence cannot support a definite judgment | Explain what needs human review |
| `error` | Required input, baseline or result could not be verified | Explain the check-execution problem and repair/rerun instruction |

All four are diagnostic in this pilot and leave the job successful if the action runs correctly. No enforcing mode is exposed by this workflow. Existing package release guards and release-ledger availability verification remain unchanged.

The new action has optional baseline/assessment paths for **trusted runner-generated inputs**. They are intentionally unset in the SAP caller. They are not files an author should add to a PR. Do not read these inputs from the checked-out PR or accept an author-supplied result as trusted evidence. The action makes no provider calls, requests no keys/grants and uploads no private source. CI logs and summaries should contain concise findings rather than collected source dumps.

## Remaining decisions before enforcement

A current, verified shipped-release baseline still needs an approved CI transport. A local historical snapshot is useful for offline tests, but cannot be a permanent production baseline. Missing, stale, incomplete or unverifiable baseline input is an execution problem. Consumer release evidence does not establish Enterprise release history.

No semantic assessor has been selected or evaluated. The existing Jev/TypeSafe Work Item classification does not assess PR-code coverage. Without an approved result, the pilot must report uncertainty rather than infer semantic coverage from titles, paths, keywords or a changelog file touch. Connecting an assessor, transmitting private source, paying for runs or adding credentials requires the relevant approval first.

The [agreed 16 acceptance cases](changelogs-acceptance-cases.json) are policy expectations, not evidence of assessment accuracy. The local tests validate collection, shipped/upcoming boundaries, result references and feedback. Before requiring a gate, use a human-labelled SAP PR sample covering missing/complete notes, maintenance, important internal changes, related PR coverage and ambiguity. Measure false blocking and missed required notes separately, repeat judgments to expose instability, and evaluate latency, cost, retry behaviour and data handling.

## Draft dependencies and review

The SAP caller and new shared action temporarily reference `ci/sap-changelogs-pilot-20261007` so the two draft PRs can be reviewed together. Restore those references to `@main` only after the shared dependency has merged. Keep SAP as the first pilot. Merging, gate activation, deployment, additional repositories and Cursor/reminder changes are separate decisions.

Run the shared regression suite locally:

```sh
node --test .github/actions/release-ledger/*.test.js .github/actions/remote-config-notion-sync/*.test.js
```
