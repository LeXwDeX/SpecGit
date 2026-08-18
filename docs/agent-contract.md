# SpecGit Agent Contract

Normative rules for AI agents operating on a SpecGit project. Everything here is binding; the [skills](../skills/README.md) implement the same discipline in guided form.

## 1. General conventions

- All commands run inside the git repository of the delivery. SpecGit resolves the root via `git rev-parse --show-toplevel`.
- Always pass `--json` when acting programmatically. stdout is exactly one JSON document; anything human-readable was sent to stderr. Parse the envelope, never scrape text.
- Branch on exit codes, not on output phrasing: `0` accepted/success · `1` rejected with complete evidence · `2` usage error · `3` fail-closed unknown.
- Never invent environment configuration: there are no product environment variables and no telemetry to disable.

## 2. The one rule

**A delivery is done if and only if `specgit accept` exits `0`.**

Corollaries:

- Never declare completion from task lists, file states, test runs you performed yourself, or the record alone. Only the verdict counts.
- Never edit `.specgit.yaml` or `spec_git/policy.yaml` to flip a failing verdict. Those files describe the delivery; the gates verify it against git and GitHub.
- Treat exit `1` and exit `3` differently. Exit `1`: the evidence is complete — fix what the gates named. Exit `3`: evidence is missing — fix record, policy, git, or `gh` first (run `specgit doctor --json`).
- A verdict is a fact about the moment it was computed. If the PR, checks, or branch change afterwards, re-run `accept` before relying on it.

## 3. Command discipline

| Command | When you run it | Hard rules |
| --- | --- | --- |
| `init` | Policy absent (`spec_git/policy.yaml` missing) | Ask which check names are required; pass every `--required-check` explicitly. Never overwrite an existing policy. |
| `bind` | Attaching issues/PR to the delivery | Ensure the checkout is on the delivery branch first — context comes from live git, there are no context flags. `--delivery` only on first bind. `--issue` takes GitHub numbers only. Re-run `bind` to merge more issues or set `--pr`. |
| `unbind` | The delivery is abandoned, or already merged and the record lingers | Requires `--yes`; confirm intent with the user before deleting a record. |
| `status` | Anytime — it is local-only and network-free | Use it for the record/state/context snapshot; never present its output as acceptance. |
| `accept` | The delivery claims to be done | Run it; report gates, codes, and fixes verbatim. On exit 3, run `doctor` and fix the environment; on exit 1, fix the delivery. |
| `doctor` | Diagnose exit-3 results or first-time setup | Its probe order is the debugging order: git → repo → origin → gh → auth → policy. |

## 4. Working with the PR and checks

- When opening the delivery's PR, write the body so every bound issue is closed: one closing reference per issue (`Closes #123`, `Fixes #124`). Keywords: `close(s|d)`, `fix(es|ed)`, `resolve(s|d)`; forms: `#N`, `owner/repo#N`, full issue URL.
- After changing the PR body, head branch, or CI, re-run `specgit accept`; do not assume.
- When a check fails, fix the cause and push; checks are re-read from the new PR head. Never bypass, rename-around, or reconfig a required check to make acceptance pass without the user's explicit decision.

## 5. Hard prohibitions

- Do not run `accept` and present exit `3` (`unknown`) as success or as "probably fine."
- Do not modify git state to satisfy context gates while on the wrong branch without the user's explicit instruction (the fix is to check out the delivery branch).
- Do not read, log, or pass around tokens. GitHub evidence flows through the user's existing `gh` session only.
- Do not add `--required-check` entries unilaterally; the policy is the team's contract.
