---
name: veamstudios-github-org-actions-secrets-vars
description: >-
  Lists VeamStudios GitHub organization Actions secret names and org variable
  names (identifiers only) for CI and workflow work. Use when wiring workflows,
  caller repos, or checking which org secrets and vars exist without opening
  GitHub Settings.
---

# VeamStudios org Actions secrets and variables

Authoritative **names only** live in [reference.md](reference.md) so workflows use the correct `secrets.*` and `vars.*` keys.

To refresh (requires org admin or fine-grained Actions secrets / variables permission):

```bash
gh secret list --org VeamStudios
gh variable list --org VeamStudios
```
