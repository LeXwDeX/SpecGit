# Migrating a SpecGit 1.x project to 2.0

Installing the native executable does not migrate a repository. Keep the known
working v1 package and an explicit backup until the project cutover is verified.
Old drafts, Issues, branches, foreign hooks and unrelated user files are retained.
The private TypeScript workspace in this repository remains available for its
current engineering gates; GitHub Release installation uses the standalone Rust executable.

## Changed responsibilities

| SpecGit 1.x | SpecGit 2.0 |
| --- | --- |
| Committed delivery record and dummy binding commits | Shared v2 declaration; local recovery state under Git; real changes create the request |
| `finish` / `accept`, merge and promotion controllers | Native observation with truthful unknowns; no SpecGit-owned eligibility engine |
| Core/controller merges and closes Issues | Authorized Agent registers native auto-merge; platform merges and normally closes Issues |
| Residual Issue closure policy | Default notification; optional authorized Agent closure after fresh native readback |
| Root TypeScript npm package | GitHub Release installer and standalone native binary |

The new `--schema` and [command reference](../runtime/REFERENCE.md) describe actual
flags. Machine exit zero means the requested operation/read succeeded, including
an observation of failed CI; it does not authorize merge. Hook framing is separate
from ordinary CLI JSON. Unknown/failed API reads never become green/no-CI results.

## Preview the specific project

Prepare a complete v2 declaration in a separate file. Do not mechanically translate
old automation fields into new Agent authorization. For an explicitly selected
manual-observation configuration:

```yaml
version: 2
remote: origin
language: en
agent:
  native_auto_merge: false
  close_issues_after_merge: false
```

From the exact project/worktree to migrate:

```sh
specgit migrate --config-file /absolute/v2.yaml --json
```

Inspect the returned inventory and preview digest. It includes local owned assets,
shared hooks, old configuration and native lifecycle writers. Unknown ownership,
concurrent edits and running old writers require investigation. SpecGit cannot
administer or deactivate remote workflows; use authorized native repository
changes to retire the identified old writers, and wait for in-flight runs to end.
Do not disable native protections or required checks as a shortcut.

After that specific change, obtain and review a fresh preview. Apply only its
exact digest:

```sh
specgit migrate --config-file /absolute/v2.yaml --apply --expect <fresh-preview-digest> --json
```

`--retire-only` supports a staged local retirement while retaining the old
declaration. Applying a migration records recoverable local asset preimages.
A changed inventory/digest requires a new preview. `--rollback <transaction>`
restores proven local assets only when later user changes remain protected; it
does not undo remote administrative changes. Preserve the returned transaction ID
and separately record any native change's recovery path.

## Verify the installed project flow

Inspect capabilities with `specgit init --check --json`; explicitly choose the
manual fallback if native capability is unsupported or unknown. Adopt exact Issue
IDs and the intended PR/MR, inspect their native associations, and confirm watch
and the correct host/session deliver meaningful changes. Check actual Issue state
after merge; a merged request alone is not completed delivery.

`setup` previews with `--dry-run`. Host registration, successful import, event
trigger, next-turn context and user-visible notifications are distinct outcomes.
Do not claim idle wake just because an integration file was written. Keep the old
executable and backups until this project's real installed flow is verified.

Publication and repository cutover are separate operations. Retiring one project's
old writer does not authorize deleting historical branches, closing unrelated
PRs, changing source visibility or migrating another project.
