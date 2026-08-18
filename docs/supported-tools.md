# Agent Support

SpecGit is built to be driven by AI coding agents as much as by humans. There is no per-tool configuration to generate — the entire integration is a strict CLI contract plus optional skills.

## The integration surface

Every AI agent works through the same three facts:

1. **Commands are stable.** `init`, `bind`, `unbind`, `status`, `accept`, `doctor` — see the [CLI reference](cli.md).
2. **`--json` is machine-first.** One JSON document per invocation on stdout, human text on stderr. Parse the envelope; never scrape human output.
3. **Exit codes are contractual.** `0` accepted · `1` rejected with evidence · `2` usage error · `3` fail-closed unknown. Branch on them, don't guess.

Requirements are the same as for a human: `git`, plus `gh` installed and authenticated for any command that needs GitHub evidence (`accept`, parts of `doctor`).

## Supported agents

Any agent that can run shell commands qualifies — there is no adapter layer. Agents with a skills mechanism can install the SpecGit skills for guided workflows:

| Skills | Where |
| --- | --- |
| `specgit-setup-policy`, `specgit-bind-delivery`, `specgit-accept-delivery` | [`skills/`](../skills/README.md) in this repository |

The skills encode the operating discipline (bind from live git, close every issue from the PR body, trust the verdict); the [Agent Contract](agent-contract.md) is the normative version of the same rules.

## What agents should never do

- Assert completion without an exit-0 `specgit accept`.
- Edit `.specgit.yaml` or `spec_git/policy.yaml` to make a failing verdict pass.
- Treat missing evidence (`unknown`) as success, or retry blindly instead of fixing the named cause.

Full rules: [Agent Contract](agent-contract.md).
