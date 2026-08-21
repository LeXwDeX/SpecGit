# SpecGit Test Guidance

Applies to tests under `test/`.

## Running Tests

- Focused file: `pnpm exec vitest run test/path/to/file.test.ts`
- Focused case: `pnpm exec vitest run test/path/to/file.test.ts -t "case name"`
- Full suite: `pnpm test`
- Run `pnpm run build` before focused CLI tests when implementation changes may leave `dist/` stale.

## Test Layout

- `test/specgit/` — focused unit/integration tests for the domain ports and
  adapters (`record`, `gitfacts`, `github`, `acceptance`). Uses deterministic
  fakes (`helpers/temp-repo.ts`, `helpers/mock-forge.ts`, `helpers/fake-gh.ts`).
- `test/specgit-cli/` — focused tests for the `specgit` CLI command functions
  with injected ports.
- `test/specgit-e2e/` — end-to-end acceptance tests that run the real built CLI
  (`dist/cli/index.js`) against deterministic fake `git`/`gh` providers and
  both branch and worktree execution contexts. See `test/AGENTS.md` and the
  shared runner in `test/helpers/run-cli.ts`.

## Deterministic Providers

Acceptance must be derived from real git, PR, and check evidence, never from
spec/task artifacts. E2E tests prove this by supplying deterministic fake
providers and asserting that spec/task file contents cannot change the verdict.
Never introduce a test that reads a spec or task file to decide acceptance.

## Cross-Platform Paths

- Do not hard-code Unix path separators in CLI output expectations unless the implementation intentionally emits POSIX paths.
- For filesystem paths, build expected values with `path.join(...)` or `path.relative(...)`.
- For human-readable output, either assert a deliberately normalized display format or normalize both actual and expected strings before comparing.
- When touching path behavior, add coverage that would fail on Windows path separators.
