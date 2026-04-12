# hotfix-deploy -- Differences

Baseline: `cip-ios__hotfix-deploy.yml` (VeamStudios/ChecklistInspectorPro-iOS)

## Identical

- cip-ios (VeamStudios/ChecklistInspectorPro-iOS)

## Different

### sap-ios (VeamStudios/SiteAuditPro-iOS)
Snapshot: `sap-ios__hotfix-deploy.yml`

- `jobs.deploy-hotfix.with.archive_name_prefix`: SiteAuditPro -> ChecklistInspectorPro
- `jobs.deploy-hotfix.with.changelog_destination_folder`: ${{ inputs.sync_changelog_website && 'src/app/content/changelogs/ios' || '' }} -> ${{ inputs.sync_changelog_website && 'src/assets/changelog-ios' || '' }}
- `jobs.deploy-hotfix.with.changelog_destination_repo`: ${{ inputs.sync_changelog_website && 'VeamStudios/siteauditpro.com' || '' }} -> ${{ inputs.sync_changelog_website && 'VeamStudios/checklistinspectorpro.com' || '' }}
- `jobs.deploy-hotfix.with.ipa_path`: ./fastlane/builds/site-audit-pro-cloud.ipa -> ./fastlane/builds/com.veamstudios.checklistinspectorpro.ipa

