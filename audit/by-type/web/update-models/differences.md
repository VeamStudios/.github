# update-models -- Differences

Baseline: `cip-web__update-models.yml` (VeamStudios/ChecklistInspectorPro-Web)

## Identical

- cip-web (VeamStudios/ChecklistInspectorPro-Web)

## Different

### sap-web (VeamStudios/SiteAuditPro-Web)
Snapshot: `sap-web__update-models.yml`

- `jobs.update.steps[5].env.CIP_VERSION`: (missing) -> ${{ github.event.client_payload.version }}
- `jobs.update.steps[5].env.SAP_VERSION`: ${{ github.event.client_payload.version }} -> (missing)
- `jobs.update.steps[5].run`: npm install "@veamstudios/sap@${SAP_VERSION}" -> npm install "@veamstudios/cip@${CIP_VERSION}"
- `jobs.update.steps[6].env.CIP_VERSION`: (missing) -> ${{ github.event.client_payload.version }}
- `jobs.update.steps[6].env.SAP_VERSION`: ${{ github.event.client_payload.version }} -> (missing)
- `jobs.update.steps[6].with.script`: const version = process.env.SAP_VERSION;
const branch = `chore/update-sap-models-${version}`;
await exec.exec('git', ['checkout', '-b', b... -> const version = process.env.CIP_VERSION;
const branch = `chore/update-cip-models-${version}`;
await exec.exec('git', ['checkout', '-b', b...
- `on.repository_dispatch.types`: ["sap-models-update"] -> ["cip-models-update"]

