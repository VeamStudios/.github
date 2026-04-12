# deploy-production -- Differences

Baseline: `cip-web__deploy-production.yml` (VeamStudios/ChecklistInspectorPro-Web)

## Identical

- cip-web (VeamStudios/ChecklistInspectorPro-Web)

## Different

### sap-web (VeamStudios/SiteAuditPro-Web)
Snapshot: `sap-web__deploy-production.yml`

- `jobs.create-release.steps[2].with.repositories`: siteauditpro.com
 -> checklistinspectorpro.com

- `jobs.create-release.steps[4].with.commit_message`: Update Site Audit Pro web changelog for v${{ inputs.version }} -> Update Web changelog for v${{ inputs.version }}
- `jobs.create-release.steps[4].with.destination_folder`: src/app/content/changelogs/web -> src/assets/changelog-web
- `jobs.create-release.steps[4].with.destination_repo`: VeamStudios/siteauditpro.com -> VeamStudios/checklistinspectorpro.com
- `jobs.deploy.secrets.BOT_RELEASE_PRIVATE_KEY`: ${{ secrets.BOT_RELEASE_PRIVATE_KEY }} -> (missing)
- `jobs.deploy.with.firebase_project`: site-audit-pro -> checklistinspectorpro

