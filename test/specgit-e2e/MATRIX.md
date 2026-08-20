# External adoption & install matrix (#67)

Reproducible evidence map for "the npm package and generated harness
work in repositories with different branches, package managers, CI
layouts, and worktrees". Everything below runs from the packed
candidate artifact (`npm pack` of this repo) installed into throwaway,
unrelated npm repositories — no workspace, no pnpm, no SpecGit-repo
paths, no `main` assumption.

## Layers and how to run them

| Layer | What it proves | Command | When it runs |
|---|---|---|---|
| file:// adoption (fixtures below) | install/init/issue/resume/pr/finish/doctor + 0/1/2/3 exits from the installed bin | `pnpm run build && pnpm vitest run test/specgit-e2e/external-matrix.e2e.test.ts` | every CI `test_matrix` entry (required) |
| clean pack | the tarball ships the package surface only | `pnpm vitest run test/specgit-e2e/install-smoke.e2e.test.ts -t "clean"` | every CI `test_matrix` entry (required) |
| npx (local) | `npx --no-install specgit` resolves the adopted install | `pnpm vitest run test/specgit-e2e/install-smoke.e2e.test.ts -t "npx"` | every CI `test_matrix` entry (required) |
| global install | `npm i -g` into an isolated prefix; PATH shim runs the CLI anywhere | `pnpm vitest run test/specgit-e2e/install-smoke.e2e.test.ts -t "global"` | every CI `test_matrix` entry (required) |
| registry-published | the published package itself via `npx --yes specgit@<version>` | `SPECGIT_E2E_PUBLISHED=1 pnpm vitest run test/specgit-e2e/install-smoke.e2e.test.ts -t "registry-published"` | opt-in (offline dev loops skip it); the always-on live layer is the post-publish external Actions run tracked on the issue |

Environment knobs: `SPECGIT_E2E_PUBLISHED=1` enables the registry
smoke; `SPECGIT_E2E_PUBLISHED_VERSION` overrides the pinned version
(default `0.7.2`, the version already immutable on the registry).

## Fixture × command × verdict matrix (external-matrix.e2e.test.ts)

| Fixture | Default branch | Own CI | Commands exercised from the installed bin | Verdicts |
|---|---|---|---|---|
| unrelated npm repo (pushable) | `master` | none | doctor → init → doctor → issue (broken bootstrap, exit 3) → `pr` repair → issue resume (idempotent) → finish | doctor 3→0 · bootstrap 3 · pr 0 · resume 0 · finish **0 accepted** |
| unrelated npm repo (pushable) | `main` | App CI (`Build`) | init (auto-detect `Build`) → bind → finish on red CI → finish on merged/green | finish **1 rejected** (`checks_failed`) → finish **0 accepted** |
| linked worktree | `master` | none | init → issue (branch, record `kind: worktree`, push) → finish | issue 0 · finish **0 accepted** (worktree context) |
| installed bin, non-git cwd | — | — | `status --json` outside any repository | **3** `not_a_git_repo`, one JSON doc, clean stderr |
| installed bin, git-only PATH | `master` | none | init → bind → finish with gh absent | **3** `gh_missing` (fail-closed) |
| installed bin, unknown command | — | — | `definitely-not-a-command --json` | **2** usage error, one JSON doc |

## Dimension coverage

- **Node**: exercises the declared floor in CI (`20.19.0` on every
  `test_matrix` entry); `engines: >=20.19.0` in every fixture manifest.
- **OS/shell**: the two files are picked up by vitest unconditionally,
  so they run on the required `linux-bash`, `macos-bash`, and
  `windows-pwsh` legs (the experimental `self-hosted-linux` shadow leg
  was retired in #105 before this matrix ran there). No CI workflow
  edits were needed or made.
- **Package manager**: adopting repos are plain npm with no lockfile;
  installs use isolated `npm_config_cache` temp dirs.

## Results

- Local (darwin, Node 26): `Tests 502 passed | 1 skipped` across the
  full suite; both new files green (`9 passed | 1 skipped`).
- CI: populated by the delivery PR's `Test (<label>)` checks — see the
  pull request's Checks tab for linux-bash / macos-bash / windows-pwsh
  runs of this exact matrix.
- Post-publish handover: enable `SPECGIT_E2E_PUBLISHED=1` on the
  registry layer and record a real external repository's green Actions
  run against the released tarball (tracked on issue #67).
