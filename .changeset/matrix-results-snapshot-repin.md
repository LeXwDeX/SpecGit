"specgit": patch
---

### Matrix results snapshot re-pinned to an actual run (#88 finding 1, 88-1)

`test/specgit-e2e/MATRIX.md` 'Results' is now the snapshot of record:
every count is an actual suite run pinned to one platform and one
commit — Local (darwin arm64, Node v26.7.0) at `0eff38c`: `Tests 797
passed | 1 skipped (798)` across `43` files, matrix-layer files
`external-matrix` 3 passed and `install-smoke` 6 passed | 1 opt-in
skip. This retires the drifted 502/599/600 counts that coexisted in
docs and delivery prose since Wave 4A; the refresh rule is re-run and
re-pin all three facts (count, platform, commit). The CI note now
records the workflow facts since `4df0ae0`: 20-minute test-job timeout
(was 15) and windows-pwsh `VITEST_MAX_WORKERS=1` (was 2; linux/macos
run 4). Findings 4 and 6 of #88 shipped earlier (#137, #134).
