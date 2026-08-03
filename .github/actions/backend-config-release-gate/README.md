# Backend Config Release Gate

This action prevents Web and iOS deployments from getting ahead of required Firebase backend configuration.

Backend deployments use `mode: record` after deploying indexes and rules. The action checks the live Firebase project, waits for Firestore indexes to become ready, records a `Backend Config Ready / <environment>` commit status, and advances a `backend-config-ready/<environment>` branch to the verified commit. A JSON manifest is also uploaded by the backend workflow for troubleshooting.

Client deployments use `mode: require`. The action reads that marker, hashes the current backend Firebase config, and fails unless the intended project and environment have the same proven-ready config.

The config contract is discovered from `firebase.json` and covers:

- Firestore composite indexes and single-field overrides
- Firestore rules
- Storage rules
- Realtime Database rules when configured

Remote Config values are intentionally outside this blocking gate.
