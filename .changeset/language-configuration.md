---
"specgit": minor
---

### Language configuration for generated text (#118)

`spec_git/policy.yaml` gains an optional `language` key (`en` default, `zh`
supported; set with `specgit init --language zh`) that selects the language of
generated text: the issue-body and draft-PR body scaffolds written by
`specgit issue`, the managed guidance block injected by `specgit init`, and
success-path human prose on stderr. `init --force` inherits the existing
policy's language unless `--language` overrides; unsupported values fail
closed (`policy_invalid` / `language_invalid`) with the supported set named.

Branch-slug derivation is now defined for non-ASCII titles under every
language: any title containing non-ASCII characters derives the numeric
fallback — issue #123 bootstraps branch `feat/123-issue123` (delivery
`issue123`); the former `issue_title_not_english` rejection is gone. ASCII
titles keep the first-three-words kebab slug.

The machine contract is never localized, pinned by tests: exit codes,
`--json` envelope field names, and diagnostic `code` values stay
English/ASCII in every configuration (and, in 1.0.0, so does diagnostic
prose — message/fix/warnings, gate and doctor probe lines); closing-reference
keywords (`Closes #n`), the acceptance workflow YAML, and the guard scripts
are untouched by the language key. Documented in README, docs/cli.md,
docs/reference.md, and docs/baseline-v1.md.

Rides along (docs): release-gates §2 evidence backfill for #119/#120/#122
and the §1 I3b status cell (E-1), and the §5 defer ruling for the bootstrap
chain-order hardening (E-3, post-1.0.0 evergreen probe).
