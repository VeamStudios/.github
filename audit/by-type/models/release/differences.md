# release -- Differences

Baseline: `cip-models__release.yml` (VeamStudios/ChecklistInspectorPro-Models)

## Identical

- cip-models (VeamStudios/ChecklistInspectorPro-Models)

## Different

### sap-models (VeamStudios/SiteAuditPro-Models)
Snapshot: `sap-models__release.yml`

- `jobs.bump_minor_and_release.steps[7].name`: Publish the '@veamstudios/sap' package -> Publish the '@veamstudios/cip' package
- `jobs.bump_minor_and_release.steps[10].with.script`: const repos = ['SiteAuditPro-Backend', 'SiteAuditPro-Web', 'SiteAuditPro-iOS'];

const results = await Promise.allSettled(
  repos.map((r... -> const repos = ['ChecklistInspectorPro-Backend', 'ChecklistInspectorPro-Web', 'ChecklistInspectorPro-iOS'];

const results = await Promise...

