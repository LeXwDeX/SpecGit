Closes #222

## Why
v1.0.1 shipped without changesets for the audit delivery batches (#160–#187, #213–#220). The v1.1.0 release needs a changeset documenting every user-visible change since v1.0.1 so the changesets release workflow can bump the version and generate a correct changelog entry.

## What changed
- Added `.changeset/audit-delivery-v110.md`: a single `minor` changeset for `specgit` covering all changes since v1.0.1, grouped into Agent harness & delivery experience, JSON envelope, Behavioral changes, TypeScript API, and Internal quality, with issue references for every entry.
- No code changes; documentation/release metadata only.

## Evidence
- Changeset file parses under changesets front-matter format (`"specgit": minor`).
- Local quality gates: `pnpm exec tsc --noEmit`, `pnpm run typecheck:test`, `pnpm run lint`, `pnpm test` all pass (no source changes).
- `specgit finish` exit 0 will be recorded before merge.

## Checklist
- [x] Why, What changed, and Evidence are filled in.
- [ ] `specgit finish` exits 0.
