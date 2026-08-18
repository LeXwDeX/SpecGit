# Agent Support

SpecGit is built to be driven by AI coding agents as much as by humans. There is no per-tool configuration to generate — the entire integration is a strict CLI contract plus a managed prompt block in your instruction files.

## The integration surface

Every AI agent works through the same three facts:

1. **Commands are stable.** The human story is `issue` → `finish`, with `pr`, `init`, `status`, `doctor` for repair and diagnostics, and `bind`/`unbind`/`accept` as machine aliases — see the [CLI reference](cli.md).
2. **`--json` is machine-first.** One JSON document per invocation on stdout, human text on stderr. Parse the envelope; never scrape human output.
3. **Exit codes are contractual.** `0` accepted · `1` rejected with evidence · `2` usage error · `3` fail-closed unknown. Branch on them, don't guess.

Requirements are the same as for a human: `git`, plus `gh` installed and authenticated for any command that needs GitHub evidence (`issue`, `pr`, `finish`/`accept`, parts of `doctor`).

## Behavioral source: the managed block

`specgit init` injects a managed block (between `<!-- specgit:block:start/end -->` markers) into `AGENTS.md` — created if missing — and into `CLAUDE.md` when that file exists. Re-init rewrites only the block. The block carries the delivery story (`specgit issue` bootstrap, `specgit finish` verdict), repair and diagnostics usage, the granularity principle (one issue = one independently verifiable WHY), and the iron rules. There are no skills or command plugins to install; the [Agent Contract](agent-contract.md) is the normative version of the same rules.

## What agents should never do

- Assert completion without an exit-0 `specgit finish`.
- Edit `.specgit.yaml` or `spec_git/policy.yaml` to make a failing verdict pass.
- Treat missing evidence (`unknown`) as success, or retry blindly instead of fixing the named cause.

Full rules: [Agent Contract](agent-contract.md).
