# pr-build -- Differences

Baseline: `sap-ios__pr-build.yml` (VeamStudios/SiteAuditPro-iOS)

## Identical

- sap-ios (VeamStudios/SiteAuditPro-iOS)

## Different

### cip-ios (VeamStudios/ChecklistInspectorPro-iOS)
Snapshot: `cip-ios__pr-build.yml`

- `jobs.build.secrets`: {"BOT_RELEASE_PRIVATE_KEY":"${{ secrets.BOT_RELEASE_PRIVATE_KEY }}"} -> inherit
- `jobs.build.with.xcodebuild_args`: -project "Checklist Inspector Pro.xcodeproj" -scheme Dev CODE_SIGN_IDENTITY="" CODE_SIGN_ALLOWED=NO CODE_SIGN_ENTITLEMENTS="" CODE_SIGNIN... -> -project "Site Audit Pro.xcodeproj" -scheme Dev CODE_SIGN_IDENTITY="" CODE_SIGN_ALLOWED=NO CODE_SIGN_ENTITLEMENTS="" CODE_SIGNING_REQUIRE...

