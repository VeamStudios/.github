# Changelogs: deterministic diagnostics

The **Changelogs** workflow runs one **Review / Coverage** check per repository. Its summary validates configured changelog structure and explicit Work Item/source-PR link syntax, with exact-file/line repair instructions. It explicitly states **Code-to-wording coverage: not assessed**. A green job means the diagnostic ran; findings remain advisory and no new required gate is enabled.

## Author instructions

Edit the repository's maintained changelog when the actual change needs release wording. An unchanged, valid changelog is accepted. No new entry or source link is required merely because a PR exists; an adequate upcoming entry can cover related work. Reviewers decide whether wording covers meaningful features, user-facing fixes or consequential internal changes under the repository's release policy. Existing Work Item checks remain separate.

Models retain their own next-minor/nonempty-note guards for consumer changes and skip releases for narrowly defined maintenance-only changes. TS-Core and Annotator Web retain their reviewed Changesets metadata requirements. These diagnostics replace neither guard, and do not create new version bumps or publish versions.

## Supported inputs

The shared workflow defaults to the existing `preview` mode. Maintained callers explicitly select `coverage-mode: deterministic`, `changelog-path` and `changelog-format`.

`changelog-path` defaults to `CHANGELOG.md` and accepts 1–64 unique newline-separated relative paths ending in `CHANGELOG.md`, without traversal or globs. Only complete regular UTF-8 Git blobs at the exact PR head are read. PR code is not run. Limits are 2 MiB and 50,000 lines per file; incomplete input is an explicit error, never a silent pass.

| Format | Established convention |
| --- | --- |
| `categorized` (default) | Version or deployment sections, category headings and bullets; existing preambles and launch subgroups are preserved. |
| `flat` | Models version sections with direct bullets and existing introductions. |
| `components` | CloudServices component/category headings and initial-release prose. |

Explicit links are checked for supported HTTPS URL syntax and identifiers. They are not checked for remote existence, database membership, semantic relevance, merging or shipping. No note requirement, wording assessment, published-history guard, AI provider, API credential, upload or release-baseline feed is included. Shipped-history enforcement would require separately verified release evidence.

## Coordinated coverage

The maintained set is SAP iOS, CIP iOS, SAP AndroidNew, SAP Backend, SAP Web, CIP Web, SAP Console, CloudServices, SAP Models, CIP Models, TS-Core and Annotator Web. CloudServices uses `docs/CHANGELOG.md`; TS-Core selects ten package files; Annotator selects `projects/annotator/CHANGELOG.md`; the rest use their root file.

CIP Backend has no maintained changelog. Marketing sites publish copied product notes; they do not own those notes. StaffManager Models has no release/changelog workflow. Blank ImageCaching files and repositories without an established changelog policy are excluded. Their existing workflows and publishing processes remain unchanged.

Existing SAP Web and Android historical syntax findings are advisory; this rollout does not rewrite published wording. Protected status contexts, review rules, triggers and release jobs remain unchanged.

## Review and sequencing

The existing shared PR #110 and SAP PR #2602 are reused as part of one coordinated set, not a SAP-only pilot. Draft references to `ci/sap-changelogs-pilot-20261007` permit dependency validation before merge. Merge the separately approved shared dependency first, then restore callers and the shared action reference to `@main`, recheck their exact final commits and obtain any approvals dismissed by that final push. No required status context is renamed or removed. Repository merges and any future gate activation need their applicable authorization/reviews.

Run the shared suite with `node --test .github/actions/release-ledger/*.test.js .github/actions/remote-config-notion-sync/*.test.js`.
