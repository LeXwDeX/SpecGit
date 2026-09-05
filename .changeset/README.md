# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).

## Quick Start

```bash
pnpm changeset
```

Follow the prompts to select version bump type and describe your changes.

## Workflow

1. **Choose publication intent**: A delivery that is intended to change the npm
   package includes a changeset. Maintenance with no publication intent omits it.
2. **Describe the released behavior**: Run `pnpm exec changeset` on the delivery
   branch and commit the generated `.changeset/*.md` with the change.
3. **Version PR**: After the delivery merges, CI creates or updates
   `changeset-release/main`, titled `chore(release): v<version>`.
4. **Release**: Merging that version PR publishes the package through npm OIDC,
   then reconciles the matching tag and GitHub Release from registry evidence.

Versioning (`changeset version`) and publishing happen in CI. A delivery with no
changeset does not enter the npm release queue.

## Template

Use this structure for your changeset content:

```markdown
---
"specgit": patch
---

### New Features

- **Feature name** — What users can now do

### Bug Fixes

- Fixed issue where X happened when Y

### Breaking Changes

- `oldMethod()` has been removed, use `newMethod()` instead

### Deprecations

- `legacyOption` is deprecated and will be removed in v2.0

### Other

- Internal refactoring of X for better performance
```

Include only the sections relevant to your change.

## Version Bump Guide

| Type | When to use | Example |
|------|-------------|---------|
| `patch` | Release-tracked bug fixes, small improvements | Fixed crash when config missing |
| `minor` | New features, non-breaking additions | Added `--verbose` flag |
| `major` | Breaking changes, removed features | Renamed `init` to `setup` |

## When to Create a Changeset

Create a changeset when the delivery is intended for npm publication, including:

- New package behavior or commands
- Released bug fixes and performance improvements
- Breaking changes or deprecations
- Documentation that is deliberately being published as a package update

Omit a changeset when no npm publication is intended, including local
installation or init/setup refreshes, tests, internal refactors, CI/tooling, and
documentation maintenance. If one of those changes must ship in the npm package,
publication intent makes the changeset required.

## Writing Good Descriptions

**Do:** Write for users, not developers
```markdown
- **Shell completions** — Tab completion now available for Bash, Fish, and PowerShell
```

**Don't:** Write implementation details
```markdown
- Added ShellCompletionGenerator class with Bash/Fish/PowerShell subclasses
```

**Do:** Explain the impact
```markdown
- Fixed config loading to respect `XDG_CONFIG_HOME` on Linux
```

**Don't:** Just reference the fix
```markdown
- Fixed #123
```
