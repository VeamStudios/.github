# generate-screenshots -- Differences

Baseline: `cip-ios__generate-screenshots.yml` (VeamStudios/ChecklistInspectorPro-iOS)

## Identical

- cip-ios (VeamStudios/ChecklistInspectorPro-iOS)

## Different

### sap-ios (VeamStudios/SiteAuditPro-iOS)
Snapshot: `sap-ios__generate-screenshots.yml`

- `jobs.screenshots.steps[1].with.xcode-version`: 26.2 -> 26.4
- `jobs.screenshots.steps[7].env.UI_TEST_EMAIL`: ${{ vars.SCREENSHOT_ACCOUNT_SAP_EMAIL }} -> ${{ vars.SCREENSHOT_ACCOUNT_CIP_EMAIL }}
- `jobs.screenshots.steps[7].env.UI_TEST_PASSWORD`: ${{ secrets.SCREENSHOT_ACCOUNT_SAP_PASSWORD }} -> ${{ secrets.SCREENSHOT_ACCOUNT_CIP_PASSWORD }}

