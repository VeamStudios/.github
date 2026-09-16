# Consumer Android release automation

This integration enables only `VeamStudios/SiteAuditPro-AndroidNew`, target
`android-consumer`, package `com.veamstudios.siteauditpro`, production track.
It does not build, upload, promote, commit Play edits, or enable Enterprise.

## Evidence and retry contract

`monitor-play.js` reads both Google's release lifecycle and a temporary edit's
track snapshot using a dedicated account. It deletes the edit even when track
inspection fails. It rereads lifecycle to reject a concurrent publication change.
The exact versionCode must resolve through one internal tag to a stable marketing
version and commit. Existing production tags/releases and Notion manifests must
agree. A new build cannot take over an existing marketing version.

`google-play` verification binds package, production track, versionCode, build,
repository, commit, lifecycle, rollout status, observation time and both evidence
endpoints. PUBLISHED alone is insufficient. Only PUBLISHED + completed is live;
inProgress is limited, halted is held, review/managed publishing is waiting.
Unknown, conflicting, restricted-country or inconsistent responses fail closed.
New announcements require an observation less than two hours old; saved past
availability remains evidence for historical dependency/baseline assessment.

The shared release lock serializes recording, supplementation, website receipts
and NotionWorkers. Frozen manifests are retained. Google Play observations can
move back from live to halted/review. Failed checks invalidate the observation
for affected records; no manual checkbox can establish consumer availability.
GitHub operations reconcile tags/releases after uncertain responses. Website
content updates use blob-SHA compare-and-swap and recover interrupted receipts
from source trailers. Failed website deployments require explicit retry; neither
website retries nor recording retries clear `Announcements`.

`Observation.website` stores source/section hashes, website revision, dispatch and
verified publication receipts. `Announcements` remains owned by NotionWorkers.
The website uses its existing Markdown generator, renderer and Firebase deployment.
The automated workflow validates the current production marker and every pending
commit before deployment. Only registered, verified release-bot note syncs pass;
other changes hold publication for a normal reviewed website release. After
deployment, both `release-info.json` and the rendered Android page are checked.

## Dependency rollout

1. Merge shared tooling and deploy NotionWorkers support, with tests passing.
2. Merge the Android canonical changelog/generator and exact-build caller workflows.
3. Merge website workflow wiring and deploy it through the normal website release
   process. Wiring is not a release-note-only update and must not pass the auto guard.
4. Configure a dedicated Play monitor account (not the uploader), and a separate
   Firebase Remote Config reader from `site-audit-pro`. Set the Android variables
   `PLAY_MONITOR_SERVICE_ACCOUNT_EMAIL` and `PLAY_UPLOADER_SERVICE_ACCOUNT_EMAIL`.
   Store the monitor JSON in `PLAY_MONITOR_SERVICE_ACCOUNT_JSON`; store the Firebase
   base64 JSON in `SERVICE_ACCOUNT_BASE64` in `launch-hub-sync-prod`. Grant only
   consumer-app Play access and the minimum permissions required for the reads;
   the monitor code has no Play commit/upload methods. Temporary edit creation
   still requires appropriate Play Console access.
5. Run Android's configuration preflight. The Firebase path reads Remote Config
   and previews Notion changes; it never writes Remote Config. Set
   `PLAY_MONITOR_MODE=shadow` and inspect hourly/manual observation artifacts.
6. Preview and apply the reviewed 4.0.0 snapshot below, verify actual production
   completion, then enable `PLAY_MONITOR_MODE=live` and
   `ANDROID_WEBSITE_PUBLICATION=true`. Retain holds if rollout is incomplete.
7. Verify the website revision/content and one NotionWorkers announcement. A
   subsequent identical check must reuse the same record, content and receipts.

## Recover the existing 4.0.0 record

Identity must remain:

- tag/version: `v4.0.0`
- versionCode: `211481388`
- commit: `da63fae9f5f9978bb3f4eadba3e39ed8cb593f06`
- Notion page: `3dd06908-3a03-81db-85df-fcd61492ea1c`

Use NotionWorkers' **Recheck release announcement evidence** workflow with
`repository=VeamStudios/SiteAuditPro-AndroidNew`, that `release_page`,
`initial_snapshot=true`, the merged, current-head human-reviewed Android migration
PR in `wording_pr`, and the current frozen `expected_manifest_hash`.
Start with `dry_run=true`. Review the returned original and supplemental hashes,
notes and unresolved provenance warning. Apply with `dry_run=false` only against
the same original hash and reviewed wording PR. The source asset at the shipped
commit must exactly match the migration's 4.0.0 customer section.

The supplement lives under `Announcements.source`. It preserves the original
manifest, empty historical baseline, original release identity and all prior
announcement receipts. It provides release wording, not historical feature/PR
delivery claims. Concurrent receipt/manifest edits and outstanding uncertain
Slack attempts abort recovery. Nothing rebuilds or retags the app.

After completed Play verification, this exact shipped commit becomes the baseline
for later Android releases. Future canonical manifests include only the selected
marketing-version section. The one-time snapshot exception cannot be used for
another version, build, commit or baseline.

## Workflow compatibility

Shared `actions/create-github-app-token@v3` steps use `client-id` with
`vars.BOT_RELEASE_CLIENT_ID`. The `app-id` input is deprecated in v3. Android's
existing v1 uploader/test workflows still require `app-id`; do not rename their
inputs without upgrading and validating the action and its callers together.

The new Firebase credential preflight is opt-in through
`validate_android_credentials: true`. Android's configuration preflight and
monitor enable it. Existing Remote Config callers retain their inputs, defaults
and behaviour until they opt in. New changelog/recovery inputs are optional, and
non-Android changelog sync retains the source basename by default.

The website publication caller grants `packages: read`, as required by the
existing reusable deploy workflow. The shared release recorder only requests
`contents: read` from `GITHUB_TOKEN`; its PR/API operations use the release-bot
token, so it does not elevate permissions in iOS callers.

Actionlint 1.7.12 has stale metadata for this v3 action: it incorrectly requires
`app-id` and rejects `client-id`. When using that version, filter only those two
specific diagnostics for `actions/create-github-app-token@v3` after checking the
upstream action metadata. Do not change valid workflows to satisfy stale lint
metadata. The shared Node suite also checks every v3 token step for this regression.

## Rollback controls

Set `PLAY_MONITOR_MODE=off` and `ANDROID_WEBSITE_PUBLICATION=false`; disable the
website automatic workflow if necessary. Preserve frozen records and receipts.
Do not remove tags, rebuild 4.0.0 or change the Play rollout. Resume in shadow mode
after resolving the cause; use exact versionCode and explicit website retry when
appropriate.

References: [Google release lifecycle](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases),
[track rollout status](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks),
[edit concurrency](https://developers.google.com/android-publisher/concurrency-considerations).
