# Shared GitHub Repo Defaults

This repository now includes reusable GitHub Actions assets that other repos can call.

## Reusable Action: Select Xcode

Action path in this repo:

`/.github/actions/select-xcode`

Example usage from another repository:

```yaml
- name: Select Xcode
  uses: VeamStudios/.github/.github/actions/select-xcode@main
```

Optional inputs:

```yaml
- name: Select Xcode
  uses: VeamStudios/.github/.github/actions/select-xcode@main
  # with:
  #   xcode-version: "26.3"
  #   print-version: "true"
```

Recommended versioning:

1. Use `@main` if you want all repos to pick up updates automatically.
2. If you prefer a pinned major tag (like `@v1`), create and maintain that tag in this repo.
3. When a new Xcode version is needed, update only this action default in this repo.

Troubleshooting:

- If you see `Unable to resolve action ... unable to find version v1`, either switch to `@main` or create/push the `v1` tag in this repo.
- Use the full action path (`VeamStudios/.github/.github/actions/select-xcode@...`), not just `VeamStudios/.github@...`.
