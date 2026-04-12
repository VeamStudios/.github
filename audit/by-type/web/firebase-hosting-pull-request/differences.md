# firebase-hosting-pull-request -- Differences

Baseline: `cip-web__firebase-hosting-pull-request.yml` (VeamStudios/ChecklistInspectorPro-Web)

## Identical

- cip-web (VeamStudios/ChecklistInspectorPro-Web)

## Different

### sap-web (VeamStudios/SiteAuditPro-Web)
Snapshot: `sap-web__firebase-hosting-pull-request.yml`

- `jobs.build_and_preview.environment`: (missing) -> dev
- `jobs.build_and_preview.steps[4].run`: npm run build -- --configuration=dev -> npm run build-dev
- `jobs.build_and_preview.steps[6].id`: (missing) -> sa
- `jobs.build_and_preview.steps[6].name`: (missing) -> Decode service account
- `jobs.build_and_preview.steps[6].run`: (missing) -> EOF=$(dd if=/dev/urandom bs=15 count=1 status=none | base64)
echo "json<<$EOF" >> "$GITHUB_OUTPUT"
echo '${{ secrets.SERVICE_ACCOUNT_BASE...
- `jobs.build_and_preview.steps[6].uses`: FirebaseExtended/action-hosting-deploy@v0 -> (missing)
- `jobs.build_and_preview.steps[6].with`: {"firebaseServiceAccount":"${{ secrets.FIREBASE_SERVICE_ACCOUNT_SITE_AUDIT_PRO_DEV }}","projectId":"site-audit-pro-dev","repoToken":"${{ ... -> (missing)
- `jobs.build_and_preview.steps[7]`: (missing) -> {"uses":"FirebaseExtended/action-hosting-deploy@v0","with":{"firebaseServiceAccount":"${{ steps.sa.outputs.json }}","projectId":"checklis...

