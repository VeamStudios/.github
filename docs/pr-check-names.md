# Reusable PR check labels

The iOS build, PR Governance and changelog preview workflows accept optional
display-name and summary inputs. Existing callers retain their current labels
and behaviour when these inputs are omitted. SAP iOS opts in to the clearer names.

| Workflow | Optional inputs | Defaults |
| --- | --- | --- |
| pr-ios-build.yml | job-name, job-summary | Build iOS app; no extra summary |
| qa-pipeline.yml | work-item-check-name, work-item-helper-name, work-item-summary, qa-queue-check-name, qa-queue-summary | Work Item gate; Notion Work Item; qa-project-status; no extra summaries |
| check-release-note.yml | job-name, summary-title, job-summary | release-note; Release announcement preview; no extra summary |

Use hyphens inside labels. GitHub adds slash separators for reusable jobs and an
event suffix in its PR UI. Required-check rulesets store the emitted check-run
name rather than the complete UI row. Coordinate any job-name change with those
requirements after the replacement context has actually run on the PR head.

The Work Item gate's configurable helper name only changes its correction
instructions. Feature title detection and URL validation are unchanged. Pass the
helper name through the step environment rather than interpolating it into
JavaScript source.

The changelog preview remains advisory. Renaming it Changelogs is distinct from
implementing semantic coverage enforcement. The agreed future policy requires
meaningful product/fix/internal notes, accepts adequate related-PR coverage,
does not demand a new bullet for routine maintenance, and gives uncertain cases
to normal review. Authors only maintain CHANGELOG.md for release wording.

Package release guards in Models retain their reviewed version and nonempty
changelog requirements; this naming change does not alter those workflows.
