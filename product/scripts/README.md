# SpecGit maintenance scripts

This directory contains the small entry points used by package scripts and
GitHub Actions. The workflows and `package.json` are the authority for when
they run; this page is an operator index, not a second scheduling policy.

## Operator commands

| Script | Purpose | Normal invocation |
| --- | --- | --- |
| `build-skills.mjs` | Regenerate the tracked portable-skill mirror from the built CLI | `pnpm run build && pnpm run build:skills` after changing the agent-surface generator |
| `pack-version-check.mjs` | Pack the candidate, install it in isolation, and require its CLI version to match `package.json` | `pnpm run check:pack-version` before publication |
| `update-flake.sh` | Recalculate the pnpm dependency hash in `flake.nix` and verify the Nix build | `./scripts/update-flake.sh` after an intentional lockfile change |

Run these inside the already bound delivery that owns the source or dependency
change. Review the resulting tracked diff and use the verification class in
[docs/ci-scope.md](../docs/ci-scope.md).

## CI and release internals

| Script | Responsibility |
| --- | --- |
| `ci-change-scope.mjs` | Classify the complete changed-file set and emit CI scheduling outputs; classification is based on committed paths, never `.gitignore` |
| `ci-changesets.mjs` | Parse release notes with the locked Changesets parser and validate the `specgit` bump declaration |
| `ci-metadata-check.mjs` | Run the lightweight metadata contract suite without building the product |
| `ci-metadata-content.ts` | Fail-closed validation for every content input admitted to metadata-only CI: policy/record/provider schemas, workflow, mandatory generated guidance and all setup entry points, issue forms and legacy Markdown templates, `.gitignore`, `CODEOWNERS`, Changesets, Dependabot, and review configuration |
| `vitest.metadata.config.mjs` | Restrict the metadata suite to the applicable contract tests |
| `merge-version-pr.mjs` | Apply configured, current-head merge automation to the generated version PR |
| `release-state.mjs` | Decide release eligibility and reconcile npm publication, tag, and GitHub Release state |
| `npm-pack-output.mjs` | Parse the supported npm pack JSON shapes without guessing an artifact |

The release sequence and recovery rules are documented in
[docs/baseline-v1.md](../docs/baseline-v1.md#release-process). Direct script
invocation does not replace the delivery, acceptance, merge, or publication
gates.

Classification recognizes paths; it does not certify their bytes. The metadata
suite must still read every required candidate-tree file and validate or
regenerate its expected form. A deleted mandatory file, malformed template or
configuration, damaged managed block, or missing generated entry point fails
the job and cannot receive a lightweight pass.
