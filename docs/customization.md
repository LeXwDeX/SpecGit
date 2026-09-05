# Customization

SpecGit keeps the surface deliberately small. It has up to three authoritative
files: the project policy, the per-delivery record, and an optional GitLab
declaration. Init shields them from routine staging by default; the binding
commit force-carries the approved bytes into the delivery branch where CI reads
them. Everything else is generated or derived from live evidence.

```text
  specgit init / setup      initialize once; rerun after upgrades
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI/CD on the request head
        |                   (the platform acceptance job runs
        |                    specgit finish --json)
        v
  mark PR/MR ready          a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

## 1. Project rules and automation — the policy

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

The first interactive `specgit init` asks whether to enable automatic merge and
closure of bound issues. The default is **no**, and an agent cannot answer yes
for the user. First non-interactive init without an explicit answer chooses no
and explains the decision on stderr, including in JSON mode. Ordinary
`init --force` preserves the saved choice, target, closure, and repair labels;
scripts use `--automation yes|no` only when the user deliberately changes it. A
no writes:

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
change the choice later, run `specgit init --force --automation yes|no` and
provide a target when enabling. Required checks, language, tags, templates,
validation, ordering, automation, and repair mappings are retained unless the
corresponding option explicitly replaces them.

Choosing names well is the real customization; the aggregator pattern in [GitHub Actions](actions.md) keeps names stable while CI evolves.

### Selected templates and body validation

The policy may select one issue template and one PR/MR template:

```yaml
validation:
  titles: true
  labels: kind
  bodies: true
templates:
  issue:
    title: "fix: {{summary}}"
    body: |-
      ## Why
      {{body}}
    required_sections: [Why]
  pr:
    body: |-
      ## Evidence
      {{body}}
    required_sections: [Evidence]
```

Supported variables are `title`, `summary`, `body`, `delivery`, and `issues`.
When body validation or required sections are enabled, repeat
`--body-file <path>` for each new issue title and use `--pr-body-file <path>` for
the new PR/MR. Empty required H2 sections and known TODO/TBD/scaffold
placeholders are rejected. Numeric reuse and resume preserve existing remote
bodies; unselected repository template files are never loaded implicitly.

### Repair issue labels

Terminal failures on a ready PR/MR create or reuse repair issues without closing
the original business issues. `automation.repair_labels` selects their labels:

```yaml
automation:
  merge: true
  target_branch: main
  close_issues: true
  repair_labels: [kind::fix, module::delivery]
```

Set the list with repeatable `--repair-label <slug>`. It must obey the selected
label rules and cannot expand the project vocabulary. Ordinary refresh preserves
the mapping.

## 2. The platform declaration — `spec_git/providers.yaml`

Exists only when a GitLab origin is explicitly declared:

```yaml
gitlab:
  host: git.example.com   # bare hostname — no scheme, no path
  # port: 8443            # only for non-default ports (:443 https / :22 ssh classify without it)
  insecure_ssl: false     # declared and currently inert; TLS bypass is not implemented
```

`specgit init --gitlab-host <hostname>` writes it; the interactive platform
choice can confirm a non-GitHub endpoint only as GitLab. It never offers GitHub
Enterprise because that route is unsupported. Classification, origin grammar,
and glab evidence routing all read the declaration. A hostname substring never selects a platform.
Declared GitLab.com uses capability probing; self-managed GitLab uses the
verified version window. The glab adapter is shipped, but `insecure_ssl` does not
enable a TLS bypass and remains inert. Unknown keys make the file invalid. Init
rejects invalid or undecided platform evidence before mutation. A declaration
write failure restores the exact previous provider state and exits `3`; it does
not continue into policy or harness generation.

## 3. The delivery record, per delivery

`.specgit.yaml` is yours to shape per delivery within the schema:

- **Delivery ids** — any kebab-case id your team likes (`add-login-flow`, `fix-124-cache-race`). Set once at first bind.
- **Issues** — bind as many forge issue numbers as the delivery closes; merge more in later with repeated `--issue`.
- **Context** — branch or worktree. Worktree labels are the checkout basenames, so teams that standardize worktree naming (`<issue>-<slug>`) get portable, self-describing labels for free.
- **Extra keys** — the writer preserves unknown keys on rewrite, so you can co-locate your own metadata in the file without breaking SpecGit. Unknown keys are ignored at evaluation.

## 4. Everything is generated — and that's the setting

`specgit init` creates the policy and generates the delivery harness — the GitHub acceptance workflow or optional GitLab completion plumbing, plus the managed prompt block in `AGENTS.md`/`CLAUDE.md` (rewritten between the `specgit:block` markers on re-init). The GitLab business acceptance job remains project-owned. `specgit setup` installs fixed agent entry points (commands for opencode, portable skills elsewhere). The generated bytes are fixed for a given policy and CLI version; configuration belongs in the policy rather than hand edits to generated assets. Every generated asset converges to the running version when its writer re-runs. AI-agent integration is the [managed agent block](supported-tools.md) and the [agent contract](agent-contract.md): run the CLI, parse JSON when automating, and trust the evidence verdict.

Generation requires the remote default branch proved from `origin/HEAD`; init
never writes a workflow or configures protection against a guessed `main`.
During reconciliation, whole-file writes and removals revalidate ownership from
current bytes at commit time, so a user edit after planning is preserved.

## Deliberately not customizable

| Fixed rule | Why |
| --- | --- |
| Record at repo root, policy under `spec_git/` | One discoverable location per repository; no stores, no ancestor walking. |
| Context resolved from live git | The verdict must reflect where you actually are; flags cannot override git. |
| Checks evaluated at the PR/MR head commit | Acceptance is about what will merge, not your local tree. |
| One declared platform per delivery — `github.com`, or an explicitly declared GitLab origin including GitLab.com | Evidence must be machine-verifiable through one provider seam, routed per platform (`gh`/`glab`). |
| Fail-closed verdicts | `unknown` rather than `accepted` whenever evidence is missing. |

If a rule in the right column is in your way, that's a design conversation, not a configuration knob.
