# CLI Reference

## Ten public commands

| Command | Purpose |
| --- | --- |
| `specgit init` | Initialize policy and integration assets; refresh with `--force` |
| `specgit setup` | Install or refresh agent entry points |
| `specgit issue` | Create/reuse issues and bootstrap or resume the delivery |
| `specgit pr` | Repair the request binding; recover enabled completion with `--merge` |
| `specgit finish` | Read acceptance and completion evidence |
| `specgit bind` | Script-level binding operation |
| `specgit unbind` | Remove the local delivery record through the explicit reset flow |
| `specgit status` | Inspect local record, context, and generated-asset state |
| `specgit accept` | Script alias for the acceptance evaluator |
| `specgit doctor` | Probe Git, repository, origin, forge CLI/authentication, and policy |

Humans may omit `--json`. Scripts must branch on exit codes and JSON fields,
not scrape human prose. JSON mode writes one document to stdout; diagnostics
carry stable codes and fix directions.

| Exit code | Meaning |
| --- | --- |
| `0` | Success or accepted; inspect lifecycle state separately |
| `1` | Evidence-backed rejection; pending checks may be retryable |
| `2` | Usage error |
| `3` | Required evidence is unavailable; follow `errors[].fix` |
| `130` | Interrupted; stderr reports `Interrupted.`, with no JSON envelope |

## Common options

- `init`: `--required-check`, `--gitlab-host`, `--language`, `--force`, `--no-protect`.
- Automation: `--automation yes|no` and `--merge-target`; enabling requires the user's decision.
- `setup`: `--tool generic|opencode|all`; portable skills live in `.agents/skills/`.
- `issue`: `--delivery`, `--body-file`, `--pr-body-file`, and `--tags`.
- Project rules: `validation.titles`, `validation.labels`, `validation.bodies`, selected templates, and required sections.

Use `specgit <command> --help` for the installed version. Detailed flags and
result shapes are in the [canonical CLI reference](https://github.com/LeXwDeX/SpecGit/blob/main/docs/cli.md).

## Environment

| Variable | Purpose |
| --- | --- |
| `SPECGIT_GH` / `SPECGIT_GLAB` | Forge CLI executable override |
| `SPECGIT_GH_TIMEOUT_MS` / `SPECGIT_GLAB_TIMEOUT_MS` | Per-call timeout |
| `SPECGIT_GUARD_BUDGET_S` | Merge-guard hook budget; not a general CLI setting |

Authentication uses the existing `gh`/`glab` session. `status` is local-only;
`finish` needs live platform evidence. `doctor` is a prerequisite probe, not an
all-purpose repair command for every record, PR/MR, or CI failure.

[Getting Started](Getting-Started) · [中文](CLI-Reference-zh)
