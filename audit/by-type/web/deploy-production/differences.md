# deploy-production -- Differences

Baseline: `cip-web__deploy-production.yml` (VeamStudios/ChecklistInspectorPro-Web)

## Identical

- cip-web (VeamStudios/ChecklistInspectorPro-Web)

## Different

### sap-web (VeamStudios/SiteAuditPro-Web)
Snapshot: `sap-web__deploy-production.yml`

- `jobs.deploy.secrets.BOT_RELEASE_PRIVATE_KEY`: ${{ secrets.BOT_RELEASE_PRIVATE_KEY }} -> (missing)
- `jobs.deploy.with.firebase_project`: site-audit-pro -> checklistinspectorpro
- `jobs.update-changelog.with.destination_folder`: src/app/content/changelogs/web -> src/assets/changelog-web
- `jobs.update-changelog.with.destination_repo`: VeamStudios/siteauditpro.com -> VeamStudios/checklistinspectorpro.com
