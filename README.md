# Shared GitHub Repo Defaults

This repository now includes reusable GitHub Actions assets that other repos can call.

## Reusable Action: Select Xcode

Action path in this repo:

`/.github/actions/select-xcode`

Example usage from another repository:

```yaml
- name: Select Xcode
  uses: your-org/github/.github/actions/select-xcode@v1
```

Optional inputs:

```yaml
- name: Select Xcode
  uses: your-org/github/.github/actions/select-xcode@v1
  with:
    xcode-version: "16.0"
    # or use xcode-path to override directly:
    # xcode-path: "/Applications/Xcode_16.0.app/Contents/Developer"
```

Recommended versioning:

1. Create and use a major tag like `v1` in caller repos.
2. When a new Xcode version is needed, update only this action default in this repo.
3. Move `v1` to the latest commit so all caller repos pick up the change.
