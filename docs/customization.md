# Customization

SpecGit keeps the surface deliberately small. There are exactly three authoritative files to configure, all committed; everything else is fixed by the model.

```text
  specgit init / setup      once per repository: policy + acceptance
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI on the PR head
        |                   (the SpecGit Acceptance job runs
        |                    specgit finish --json)
        v
  gh pr ready <n>           a draft PR always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> fix the environment first (specgit doctor)
```

## 1. Required checks and generated-text language — the policy

`spec_git/policy.yaml` is the project-level delivery policy:

```yaml
version: 1
required_checks:
  - "All checks passed"
```

- Any number of check names, matched exactly (byte-for-byte) against check runs reported to the PR head commit.
- Change it like code: a PR that updates the policy and the branch-protection settings together.
- The list may be empty — that is the no-CI policy: the generated SpecGit Acceptance job, enforced through branch protection, remains the gate. Empty does not disable acceptance; never invent a fallback check name to fill the list.
- Optional `language: en | zh` selects the language of generated text (scaffolds, the managed guidance block, success prose; default `en`) — the machine contract is never localized. See [Language configuration](cli.md#language-configuration).
- Optional `tags:` declares extra seedable label names for the pool-first tag selection — each entry is `name` (portable tag slug, ≤ 64 chars) plus optional six-hex `color` and `description` (≤ 300 chars). See [Delivery tags](cli.md#delivery-tags-330).

`specgit init` asks whether to enable automatic merge and closure of bound issues.
The answer defaults to **no**, including on `init --force`; a previous yes never
becomes the next prompt's default. Scripts pass the user's answer explicitly with
`--automation yes` or `--automation no`. Without an interactive terminal and
without that flag, init chooses no and explains the decision on stderr, including
in JSON mode. A no writes:

```yaml
automation:
  merge: false
  close_issues: false
```

A yes writes the selected target and enables both operations:

```yaml
automation:
  merge: true
  target_branch: main
  close_issues: true
```

Choose the target with `--merge-target <branch>`. When that option is absent,
init resolves the remote's default branch and refuses to enable automation if it
cannot establish one; it does not assume `main`. A target must be a branch name,
such as `main` or `release/stable`, rather than a revision expression, an option,
or a fully qualified `refs/...` name. Enabling issue closure while merge is
disabled is invalid. A policy without `automation` keeps automatic merge and
closure disabled.

The configuration authorizes `specgit pr --merge` to complete a delivery after
its checks pass and the target matches. Bound issues are closed only after the
forge confirms the merge. `specgit finish` remains the evidence verdict. To
change the choice later, run `specgit init --force` and answer again; required
checks, language, tags, and ordering settings are retained unless an option
explicitly replaces them.

Choosing names well is the real customization; the aggregator pattern in [GitHub Actions](actions.md) keeps names stable while CI evolves.

## 2. The platform declaration — `spec_git/providers.yaml`

Exists only when the origin's platform cannot be read off `github.com`:

```yaml
gitlab:
  host: git.example.com   # bare hostname — no scheme, no path
  # port: 8443            # only for non-default ports (:443 https / :22 ssh classify without it)
  insecure_ssl: false     # written by init; reserved for the glab roadmap
```

`specgit init --gitlab-host <hostname>` writes it (or the `gitlab.com` heuristic does); classification, origin grammar, and glab evidence routing all read it. One declared platform per delivery — a host absent from this file never resolves as GitLab (the substring heuristic is deliberately not a guess). Unknown keys make the file invalid; repair the bytes rather than hand-editing around them.

## 3. The delivery record, per delivery

`.specgit.yaml` is yours to shape per delivery within the schema:

- **Delivery ids** — any kebab-case id your team likes (`add-login-flow`, `fix-124-cache-race`). Set once at first bind.
- **Issues** — bind as many forge issue numbers as the delivery closes; merge more in later with repeated `--issue`.
- **Context** — branch or worktree. Worktree labels are the checkout basenames, so teams that standardize worktree naming (`<issue>-<slug>`) get portable, self-describing labels for free.
- **Extra keys** — the writer preserves unknown keys on rewrite, so you can co-locate your own metadata in the file without breaking SpecGit. Unknown keys are ignored at evaluation.

## 4. Everything is generated — and that's the setting

`specgit init` creates the policy and generates the delivery harness — the acceptance workflow and the managed prompt block in `AGENTS.md`/`CLAUDE.md` (rewritten between the `specgit:block` markers on re-init); `specgit setup` installs fixed agent entry points (commands for opencode, portable skills elsewhere). None of it takes configuration: no per-tool instruction variants, skill generators, schema registries, or plugin hooks — every generated asset converges to the running version when its writer re-runs. AI-agent integration is the [managed agent block](supported-tools.md) and the [agent contract](agent-contract.md): run the CLI, read the JSON, trust the verdict.

## Deliberately not customizable

| Fixed rule | Why |
| --- | --- |
| Record at repo root, policy under `spec_git/` | One discoverable location per repository; no stores, no ancestor walking. |
| Context resolved from live git | The verdict must reflect where you actually are; flags cannot override git. |
| Checks evaluated at the PR head commit | Acceptance is about what will merge, not your local tree. |
| One declared platform per delivery — `github.com`, or a self-managed GitLab declared with `init --gitlab-host` | Evidence must be machine-verifiable through one provider seam, routed per platform (`gh`/`glab`). |
| Fail-closed verdicts | `unknown` rather than `accepted` whenever evidence is missing. |

If a rule in the right column is in your way, that's a design conversation, not a configuration knob.
