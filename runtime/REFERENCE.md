# SpecGit 2 native command reference

This reference describes the SpecGit 2.0 native CLI. Installing it does not
migrate a project or authorize native mutations. Public npm packages contain the
native launcher and exact-version platform packages; the private root TypeScript
workspace is retained only for engineering gates and historical regressions.

## Responsibility and configuration

SpecGit manages specification Issues, aggregates multiple Issues into one native
PR/MR, and observes native changes. The Agent supervises development and fixes.
GitHub/GitLab decides CI, reviews, protection, actual merge and ordinary closure.
The core, watch and hooks have no merge, Issue-close, branch-delete or settings
administration capability. An authorized Agent uses gh/glab outside SpecGit for
native auto-merge registration or optional supplementary Issue closure.

`.specgit.yaml` is the only shared declaration. Local selection, uncertain-write
intents and subscriptions live under the Git directory; they are not remote
completion evidence. A minimal declaration is:

```yaml
version: 2
remote: origin
language: en
agent:
  native_auto_merge: false
  close_issues_after_merge: false
```

Both Agent preferences default to false. Setting them records a preference, not
new authorization. `provider: github|gitlab` is optional where the host is
unambiguous. `target` defaults to the successfully read native default branch.
`language` accepts `en` or `zh`.

Optional `validation` contains `titles`, `bodies` and `labels: off|kind|project`.
Booleans default to false; labels default to `off`. Project labels require a
`tags` catalog of name, six-digit color and optional description. The `templates`
object selects `issue` and `pr` templates: `source: builtin`, `repository` with a
safe relative `path`, or `inline` with nonempty `body`. Optional `title` and
`required_sections` describe selected content. Final body files override template
body selection. Unselected repository templates are only discovery candidates.

Observation defaults are a 15-second poll, a 1,800-second maximum and
attention/completed notices. Configuration fields are `observation.poll_seconds`,
`max_wait_seconds` and `notify`. Runtime validation enforces relational timing
bounds, unique lists, Git branch syntax, UTF-8 limits and safe paths. Unknown or
duplicate YAML keys fail. Retired rule-engine configuration must be removed in an
explicitly reviewed migration; platform protection rules remain on the forge.

## Discovery, input and output

`specgit --help`, `specgit --version` and `specgit --schema` work offline, without
Git, forge executables or credentials. `specgit <command> --schema` narrows the
contract. `-h` and `-V` are short help/version forms. The schema comes from the
same command definitions as argv and includes types, choices, bounds, defaults,
conflicts and side-effect classification. Packaged `schemas/` are generated from
the staged executable's contract and checked against the installed launcher.

Global options are `--cwd <path>`, `--json`, `--human`, `--schema` and
`--input-file <path>`. Ordinary non-TTY stdout defaults to a single JSON report;
`--human` forces text. `--json` and `--human` conflict. `hook` uses host-specific
framing regardless of ordinary output selection.

Explicit JSON input is one object with `command`, `options` and optional `args`:

```json
{
  "command": "issue",
  "options": {"dry-run": true, "json": true},
  "args": ["21", "22"]
}
```

Save this as a local file and run `specgit --input-file /absolute/request.json`.
`--input-file -` explicitly reads stdin. Ordinary argv never consumes implicit
stdin. `command` can also be an array of command names; option keys are long
names without `--`, booleans are JSON booleans, and positional values belong in
`args`. Input is capped at 1 MiB with a five-second read deadline. Duplicate or
unknown keys, incompatible types and conflicting selectors are errors. Business
argv cannot accompany JSON input; only the explicit global `--cwd`, `--json` or
`--human` selectors can accompany it. Duplicate selectors are rejected.

Ordinary reports contain `schema_version`, `version`, `operation`, `ok`, `status`,
`exit`, `evidence`, `diagnostics` and `next_actions`. `ok` describes operation
success; it is not merge authorization. Diagnostics provide stable `code`,
operation, message and remedy. Raw provider stderr is classified locally rather
than copied into the report. Business code consumes typed library values, not
its own serialized reports.

| Exit | Meaning |
| --- | --- |
| 0 | The operation or observation succeeded. Inspect native state separately. |
| 1 | The operation failed; use the diagnostic and current evidence. |
| 2 | Invalid input/configuration, or an explicit operating choice is required. |
| 3 | External result or required facts remain unknown/unavailable. |
| 130 | Cancelled; inspect any pending intent before explicitly resuming. |

Collections are bounded. Pagination exhaustion, missing fields and ambiguous
responses do not prove absence. Use object IDs and reported source/identity;
inspect partial or unavailable results before a further action. A preview is not
a reservation or authorization, so real application rechecks current state.

## Commands

Run `specgit <command> --help` for complete argument combinations. All ordinary
commands use the global input/output contract above.

| Command | Purpose and options |
| --- | --- |
| `setup` | Install/update versioned global assets; select `--root`, `--provider`, `--api-host`. `--register-claude` and optional `--claude-settings` register Claude hooks. `--register-codex` / `--register-opencode` install each host's native skill and managed global instructions; `--codex-root` / `--opencode-root` select explicit host configuration directories. Existing registered roots persist during refresh. `--dry-run` previews install/update or `--uninstall` without writes or a lock. Uninstall removes all registrations owned by the selected setup root, preserving unrelated instructions. `--rollback <transaction>` restores owned local assets and conflicts with dry-run/uninstall; repeat explicit host roots if rolling back a removed receipt. Written registration is not verified host import or event delivery. |
| `init` | Inspect native capabilities and write the shared declaration/guidance. Select `--remote`, `--provider`, `--api-host`, `--target`, `--language`, `--config-file`, `--mirror-claude`. `--check` (alias of `--inspect`) is read-only; `--dry-run` also previews asset paths. `--native-auto-merge true\|false` records an explicit preference; `--manual-observe` selects the manual fallback. `--rollback <transaction>` restores a local transaction. |
| `issue` | Adopt positive Issue IDs or create complete specification titles. Repeat `--body-file` in new-title order; optional `--tags` and `--branch`. `--inspect` or `--dry-run` reports preparation and duplicate candidates without local/native writes. After comparing different WHYs, repeat `--reviewed-candidates <review_digest>` for the exact reviewed candidate sets. `--create-labels` explicitly permits missing selected catalog labels to be created. |
| `pr` | Create/resume/discover a PR/MR or adopt `--request <id>` after real pushed changes. Optional `--title`, `--body-file`, `--tags`; explicit `--ready`, `--update-body` or `--update-references` preserves deliberate associations. `--inspect` reads preparation; `--dry-run` previews a mutation. `--create-labels` permits missing catalog labels. `--status` reads native lifecycle facts and conflicts with mutation options. |
| `watch` | Bounded native observation. Requires `--request`, `--session`, `--goal checks\|lifecycle`; optional `--state-root`, `--once`, `--timeout-seconds` (1–3,600; default 1,800), `--poll-seconds` (1–300; default 15). |
| `hook` | Host event adapter with `--event`; optional `--state-root` and asynchronous PostToolUse `--observe`. Bounded informational framing; no write permission is granted. |
| `inbox` | Read/refresh pending events with `--request`, `--session`, `--goal`, optional `--state-root`. `--no-refresh` lists unverified IDs only. `--ack <event-id>` records explicit transport receipt and conflicts with no-refresh. |
| `status` | Offline Git identity and local selection. Optional `--remote`, `--provider`; no forge child is invoked. |
| `doctor` | Read tool/account/project capability. Select `--provider`; optional `--remote`, `--api-host`, `--account-only`. Help success does not prove API access or mutation permission. |
| `migrate` | Preview owned v1 retirement using `--config-file <v2.yaml>` and optional `--api-host`. `--apply --expect <digest>` applies the exact reviewed preview. `--retire-only` retains the old declaration for staged cutover. `--rollback <transaction>` restores proven local assets. |

`inbox`, `status`, `doctor` and `migrate` remain auxiliary entrypoints in this
native CLI. Core project operations are setup, init, issue, pr, watch
and hook. No separate server is required for ordinary Agent use.

## Initialization choices and native limits

`init` reads the actual project/default branch and current request target. Custom
hosts can require an explicit provider. `--api-host` is private worktree routing,
not a shared credential field; SSH and API ports are distinct.

Capability records use `supported`, `unsupported` or `unknown` with source and
reason. Unsupported/unknown native flow returns `confirmation_required` before
project writes unless an explicit manual fallback was selected. The report remains
available with `--check` or dry-run. Configure the platform using an authorized
native administrator action, recheck, or choose `--manual-observe`. That manual
choice persists for subsequent refreshes. No default branch is guessed, and init
never changes native settings, protection or CI.

GitHub `allow_auto_merge` reports a repository setting, not a request guarantee.
Readable branch protection is not an exhaustive ruleset/queue/approval assessment.
GitLab project metadata currently does not prove native auto-merge support; its
status remains unknown without a guessed version threshold. A non-default target,
disabled closing or unknown instance rules can leave Issues open after merge.
The actual native request and Issue states must be read back.

## Ordinary work and uncertain writes

Search for duplicate Issues and read their WHY before creating new ones. Select
complete specifications, then preserve their closing references in one request:

For the same WHY, adopt the native Issue ID. If similar candidates cover different
work, `issue --inspect` supplies a `review_digest` for each proposed specification.
After comparing their contents, repeat the creation command with
`--reviewed-candidates <review_digest>` for each reviewed set. The digest binds
the proposed content, project, source/target and current native candidate contents;
changed evidence requires another review. It does not override uncertain prior
writes, which still require exact native adoption.

GitLab description readback permits its CRLF-to-LF conversion and removal of
trailing ASCII spaces, tabs and line endings after a write. Leading indentation,
Unicode whitespace and other content changes are not treated as equivalent.
Comparisons between two native snapshots remain exact.

```sh
specgit init --provider github --manual-observe --json
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json
```

After committing and pushing actual implementation through Git:

```sh
specgit pr --title 'feat: implement selected specs' --body-file /absolute/request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file /absolute/request.md --json
specgit pr --ready --json
specgit pr --status --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
```

SpecGit does not create binding-only commits or silently push source changes.
Native auto-merge registration belongs to an already authorized Agent gh/glab
action outside these commands. The preference does not authorize a new session.

Issue/request writes retain intent before submission. On an uncertain response,
resume the same selection/request to reconcile native state; inspect ambiguous
matches rather than submitting again. Request body updates preserve user content
and deliberately associated Issues. Cross-project or conflicting identities are
rejected rather than guessed. A read-only probe never establishes write permission.
The user's authenticated gh/glab session provides forge access; SpecGit does not
store credentials. Forbidden or ambiguous 404 responses do not establish absence.

## Observation and host delivery

`pr --status` reports lifecycle facts such as `open`, `closed_unmerged`, `merged`,
`completed`, `merged_issues_open` or `unknown`. Check outcomes describe observed
checks only; the runtime does not reconstruct native merge eligibility. A merged
request with open linked Issues produces attention. Agent supplementary closure
is optional, defaults off, and requires existing authorization plus native
readback of merge, intended associations and resulting Issue closure.

Issue associations retain per-Issue sources: `native_closing`, `body_reference`
and `local_selection`. The native source comes from the platform's closing-Issue
query; unavailable queries remain diagnostic evidence, never an empty successful
result. Local selections apply only to their exact request ID. Explicitly observing
a different request does not inherit the previous request's selected Issues.
Association changes participate in watch event revisions, including source changes
that leave the set of Issue IDs unchanged.

Watch subscriptions and stable event IDs are session/worktree scoped. Pending
notices are refreshed before delivery and superseded by changed evidence.
`--goal checks` observes checks without claiming lifecycle completion. `--once`
performs one read and retains pending intent. Explicit inbox acknowledgment is a
transport receipt, not human reading, approval or permission to mutate.

Claude registration includes SessionStart, PreToolUse, PostToolUse and Stop.
Relevant PostToolUse may launch a bounded asynchronous observer. Registration is
`written_not_verified`; import, context injection, visible messages and later-turn
delivery require separate host evidence. Immediate idle wake is not supported.
Stop does not request another model turn, and hooks never acknowledge themselves.
Use explicit watch/inbox when automatic delivery is unavailable.

## Assets, migration and installation

Setup uses exact asset hashes and recorded host groups. Foreign content, hook
ordering and file permissions survive refresh/uninstall. Dry-run performs no
mkdir, asset lock or write. Real apply rechecks content/permissions after locking,
uses atomic replacement and saves restorable private preimages. Edited ownership
or interrupted transactions require explicit recovery. Rollback refuses later
conflicting edits; uninstall retains backups and unrelated directories.
Installation can succeed while account readiness is unknown: inspect `readiness`
and exit 3 separately from written assets and unverified host registration.

Migration defaults to a preview. Supply the complete new declaration explicitly;
no old automation or orchestration policy is silently reinterpreted. Exact owned
local assets and native retirement evidence bound activation. Unknown writers,
dynamic includes, shared hooks or unfinished native runs can prevent activation.
Native workflow retirement is a separately authorized repository operation.
Private backups, foreign content and old drafts remain recoverable.

The npm wrapper selects an exact-version precompiled platform package, verifies
its binary digest and forwards argv/I/O to Rust. Declared package targets are
Linux glibc x64/arm64, macOS x64/arm64 and Windows x64 MSVC. Node.js 20.19 or newer
is required; end-user installation needs no Rust toolchain or private source.
Linux requires the glibc floor recorded in its manifest. Unsupported targets fail
explicitly. Every target needs its own installed/runtime qualification.

Staging, local installation and public registry publication are separate outcomes.
See [distribution](distribution/README.md) for qualification and publishing paths.
Neither this reference nor installation authorizes publication, source visibility
changes, native administration or a new credential flow.
