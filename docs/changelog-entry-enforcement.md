# Changelog entry enforcement

## Author workflow

Update `CHANGELOG.md` when a PR adds a meaningful feature, fixes user-visible
behaviour, or changes consequential internal behaviour such as migrations,
permissions, compatibility, data handling or rollout requirements. Use the
repository's existing headings and style. No additional PR field or label is
required by this check.

An adequate entry already present in the upcoming changelog at the PR head may
cover related work. Authors do not need duplicate bullets for every PR. A note
in a shipped release or promised in another unmerged PR does not provide coverage.
Routine tests, formatting, documentation and behaviour-preserving refactoring
need no entry unless they change material behaviour.

| Result | Check | Author action |
| --- | --- | --- |
| Covered or routine maintenance | Success | None |
| Identified meaningful change lacks coverage | Failure | Add or improve the indicated upcoming entry; push to rerun |
| Impact cannot be established | Success with review warning | Reviewer examines the stated uncertainty |
| Missing release proof, incomplete input, timeout or malformed assessment | Failure | Fix the check's input/configuration; this is not an accusation of a missing note |

The job summary names the uncovered effect, source lines and suggested heading.
It is available through the PR check's details link. The check keeps the existing
`Changelogs / Review / Coverage` naming. GitHub adds event text in its own UI.

## Execution

The opt-in `enforce` mode collects complete changed before/after Git blobs from
the exact base and head. It reads the verified Releases ledger for **every**
production target sharing the changelog, checks current PR base ancestry, and
separates upcoming entries from shipped content. A verified released source may
be outside main's ancestry when its PR was squash merged; its exact deployed
snapshot remains authoritative and is not replaced by the squash commit.
Sparse checkout plus an explicit fetch of the required blobs avoids downloading
all historical binary assets. The read-only GitHub credential is passed to Git
only through temporary process environment, never persisted or sent to Cursor.
Collection rejects unsupported or
incomplete inputs instead of silently truncating them. Initially this includes
binary changes, stale branches, permission-mode changes, missing historical
changelog paths and oversized evidence; these
limitations must be evaluated against representative PRs before activation.

The existing Cursor integration assesses effects and wording. This is a
probabilistic assessment, not a replacement for conventional tests or human
review. A strict validator binds the response to the repository, head, base and
evidence digest; checks referenced source lines and eligible entries; and requires
a specific correction for every missing-note finding. References and schema
validation do not prove the model's semantic judgement is correct.

The wrapper uses a checksum-pinned CLI archive, the existing `grok-4.6` model,
ask mode, sandbox, fresh configuration and an evidence-only directory. Shell,
writes, web and MCP tools are denied. The provider process receives no GitHub or
Notion token. Only the collector queries Notion, using read-only operations.
PR-supplied scripts, agent instructions, hooks and configuration are never run.
The assessment uses one invocation, no automatic retry and a three-minute limit.
These bound activity but do not impose a dollar cap; existing Cursor account
billing and privacy settings still apply. Context is sent to the existing Cursor
service and its model provider. No new provider is introduced.

## Activation requirements

This change supplies an implementation candidate. Existing callers stay in
`deterministic` advisory mode until all of the following are verified:

1. Every production target has a verified shipped baseline with an exact source
   commit, or a specifically approved and explicitly reported assumption. An
   uploaded App Store/Enterprise artifact alone is insufficient. The initial SAP
   Enterprise 10.7.3 policy assumes the verified consumer 10.7.3 source, as
   instructed by the owner; this does not independently verify its Enterprise
   artifact. It cannot override conflicting evidence or carry to another version.
2. The pinned CLI completes real restricted execution in CI using the existing
   credentials. Unit tests use fake executables and do not establish this.
3. Representative reviewed feature/fix/internal/maintenance examples, related
   upcoming coverage, shipped-note reuse and injection cases produce acceptable
   results. Measure false blocks and missed entries separately; repeat selected
   assessments to expose variability.
4. The caller forwards `NOTION_TOKEN` and `CURSOR_API_KEY` and selects
   `coverage-mode: enforce`. Repository targets, changelog paths and ledger ID
   come from the pinned shared policy, not PR-controlled caller inputs. Initially
   only SAP iOS has that policy; other callers explicitly reject enforcement.
5. Confirm the resulting check is required by the intended branch rules before
   claiming that a failed assessment blocks merging. Preserve Build/Run/Verify,
   Work Items, Models version guards and Changesets guards.

Do not activate all repositories from a single successful synthetic example.
Package release history needs a verified baseline adapter before opting in;
missing ledger records must not be replaced with guessed tags or version numbers.

References: [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters),
[permissions](https://cursor.com/docs/cli/reference/permissions),
[configuration](https://cursor.com/docs/cli/reference/configuration),
[privacy](https://cursor.com/help/security-and-privacy/privacy),
[spend limits](https://cursor.com/help/account-and-billing/spend-limits).
