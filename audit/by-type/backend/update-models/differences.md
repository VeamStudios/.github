# update-models -- Differences

Baseline: `cip-backend__update-models.yml` (VeamStudios/ChecklistInspectorPro-Backend)

## Identical

- cip-backend (VeamStudios/ChecklistInspectorPro-Backend)

## Different

### sap-backend (VeamStudios/SiteAuditPro-Backend)
Snapshot: `sap-backend__update-models.yml`

- `jobs.update.steps[5].env.CIP_VERSION`: (missing) -> ${{ github.event.client_payload.version }}
- `jobs.update.steps[5].env.SAP_VERSION`: ${{ github.event.client_payload.version }} -> (missing)
- `jobs.update.steps[5].run`: yarn upgrade "@veamstudios/sap@${SAP_VERSION}" -> yarn upgrade "@veamstudios/cip@${CIP_VERSION}"
- `jobs.update.steps[7].env.CIP_VERSION`: (missing) -> ${{ github.event.client_payload.version }}
- `jobs.update.steps[7].env.SAP_VERSION`: ${{ github.event.client_payload.version }} -> (missing)
- `jobs.update.steps[7].with.script`: const version = process.env.SAP_VERSION;
const runId = process.env.RUN_ID;
const branch = `chore/update-sap-models-${version}-${runId}`;
... -> const version = process.env.CIP_VERSION;
const runId = process.env.RUN_ID;
const branch = `chore/update-cip-models-${version}-${runId}`;
...
- `on.repository_dispatch.types`: ["sap-models-update"] -> ["cip-models-update"]

