---
name: release-npm-packages
description: Release npm workspace packages with a deterministic git-based flow: run quality gates, infer semantic version bump from conventional commits since the last version tag, update all publishable package versions, update root CHANGELOG.md, commit release changes, and create a git tag. Use when preparing a new package release in this repository.
---

# Release Npm Packages

## Overview

Run this workflow to create a release commit and tag for all publishable packages in this workspace.
Use the bundled script for deterministic behavior.

## Workflow

1. Confirm prerequisites.
- Run from repository root.
- Ensure git working tree is clean before release.
- Ensure npm auth is configured if publishing after tagging.

2. Run release script.

```bash
node skills/release-npm-packages/scripts/release-packages.mjs
```

3. Verify output.
- Check version updates in `packages/*/package.json`.
- Review top entry in `CHANGELOG.md`.
- Confirm new commit message: `chore(release): vX.Y.Z`.
- Confirm new git tag: `vX.Y.Z`.

4. Publish packages if requested.

```bash
npm publish -w @frenchfryai/core
npm publish -w @frenchfryai/react
npm publish -w @frenchfryai/runtime
```

## Script Behavior

- Run quality gates in this order:
  - `npm run lint`
  - `npm run format:check`
  - `npm run typecheck`
  - `npm run test -- --coverage`
  - `npm run build`
- Find last release tag matching `v*` (semver sorted).
- Parse conventional commits since last tag (or full history if no tag).
- Select bump type:
  - `major` if any commit has `BREAKING CHANGE` or `type(scope)!:`
  - `minor` if any `feat(...)`/`feat:`
  - `patch` for any other conventional commit type
- Update all `packages/*/package.json` versions to the new version.
- Update internal workspace dependencies pinned to old version.
- Create or update root `CHANGELOG.md`.
- Create commit and tag.

## Failure Handling

- If quality gates fail, stop and fix before retry.
- If no conventional commits are found, stop and ask user whether to proceed manually.
- If git working tree is dirty, stop and ask user to clean/stash unrelated changes first.
