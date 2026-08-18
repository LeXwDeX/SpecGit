# Customization

SpecGit keeps the surface deliberately small. There are exactly three things to configure, all in committed files; everything else is fixed by the model.

## 1. Required checks — the policy

`spec_git/policy.yaml` is the only project-level setting:

```yaml
version: 1
required_checks:
  - "All checks passed"
```

- Any number of check names, matched exactly (byte-for-byte) against check runs reported to the PR head commit.
- Change it like code: a PR that updates the policy and the branch-protection settings together.
- An empty list is invalid — there is no "no required checks" mode. Fail-closed is not configurable.

Choosing names well is the real customization; the aggregator pattern in [GitHub Actions](actions.md) keeps names stable while CI evolves.

## 2. The delivery record, per delivery

`.specgit.yaml` is yours to shape per delivery within the schema:

- **Delivery ids** — any kebab-case id your team likes (`add-login-flow`, `fix-124-cache-race`). Set once at first bind.
- **Issues** — bind as many GitHub issue numbers as the delivery closes; merge more in later with repeated `--issue`.
- **Context** — branch or worktree. Worktree labels are the checkout basenames, so teams that standardize worktree naming (`<issue>-<slug>`) get portable, self-describing labels for free.
- **Extra keys** — the writer preserves unknown keys on rewrite, so you can co-locate your own metadata in the file without breaking SpecGit. Unknown keys are ignored at evaluation.

## 3. Nothing is generated — and that's the setting

`specgit init` creates the policy and generates the delivery harness — the acceptance workflow and the managed prompt block in `AGENTS.md`/`CLAUDE.md` (rewritten between the `specgit:block` markers on re-init). There are no per-tool instruction variants, slash commands, skill generators, schema registries, or plugin hooks to configure. AI-agent integration is the [managed agent block](supported-tools.md) and the [agent contract](agent-contract.md): run the CLI, read the JSON, trust the verdict.

## Deliberately not customizable

| Fixed rule | Why |
| --- | --- |
| Record at repo root, policy under `spec_git/` | One discoverable location per repository; no stores, no ancestor walking. |
| Context resolved from live git | The verdict must reflect where you actually are; flags cannot override git. |
| Checks evaluated at the PR head commit | Acceptance is about what will merge, not your local tree. |
| GitHub issues only, `github.com` origins only | Evidence must be machine-verifiable through one provider seam. |
| Fail-closed verdicts | `unknown` rather than `accepted` whenever evidence is missing. |

If a rule in the right column is in your way, that's a design conversation, not a configuration knob.
