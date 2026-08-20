---
"specgit": patch
---

### Test tree under typecheck; pre-push upgrade keeps trailing user content

- `tsconfig.test.json` brings the test tree under `tsc` with the same
  strictness as `src/` (#79): `pnpm run typecheck:test` visits every test
  file, the CI "Lint & Type Check" job runs it alongside
  `tsc --noEmit`, and the pre-existing backlog (mock `Evidence` widening,
  a missing `getOpenIssueNumbers` fake, two e2e fixture signatures) is
  fixed in the same change — zero product-semantics changes.
- Fixing 88-3 of #88: `mergeGitPrePush` no longer deletes user content
  that follows `# <<< specgit:end <<<` when upgrading the marker-first
  pre-push layout to the spawnable layout — the rebuild keeps everything
  after the managed region and stays byte-stable on re-merge
  (adversarially reproduced on main by W0′; repro landed beside the
  existing coverage in `test/specgit-cli/harness-merge.test.ts`).
