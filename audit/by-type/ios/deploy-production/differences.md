# deploy-production -- Differences

Baseline: `cip-ios__deploy-production.yml` (VeamStudios/ChecklistInspectorPro-iOS)

## Identical

- cip-ios (VeamStudios/ChecklistInspectorPro-iOS)

## Different

### sap-ios (VeamStudios/SiteAuditPro-iOS)
Snapshot: `sap-ios__deploy-production.yml`

- `jobs.build-cloud.with.ipa_path`: ./fastlane/builds/site-audit-pro-cloud.ipa -> ./fastlane/builds/com.veamstudios.checklistinspectorpro.ipa
- `jobs.create-release.steps[5].run`: ARCHIVE_NAME="SiteAuditPro-v${{ needs.resolve-beta.outputs.marketing_version }}-cloud.xcarchive.zip"
ZIP_PATH="./artifacts/$ARCHIVE_NAME"... -> ARCHIVE_NAME="ChecklistInspectorPro-v${{ needs.resolve-beta.outputs.marketing_version }}-cloud.xcarchive.zip"
ZIP_PATH="./artifacts/$ARCH...
- `jobs.create-release.steps[9].with.destination_folder`: src/app/content/changelogs/ios -> src/assets/changelog-ios
- `jobs.create-release.steps[9].with.destination_repo`: VeamStudios/siteauditpro.com -> VeamStudios/checklistinspectorpro.com
- `jobs.resolve-beta.steps[0].with.script`: const overrideRunId = process.env.OVERRIDE_BETA_RUN_ID?.trim();
const { owner, repo } = context.repo;

function parseManifestArtifact(art... -> const overrideRunId = process.env.OVERRIDE_BETA_RUN_ID?.trim();
const { owner, repo } = context.repo;

function parseManifestArtifact(art...

