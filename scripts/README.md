# Repository verification

`ci-change-scope.mjs` classifies complete committed diffs for native CI.
`ci-metadata-check.mjs` checks metadata, retired entry points and all repository Markdown through
`documentation-check.mjs`: local/main-branch links, heading anchors, Wiki navigation,
current version references and complete specification templates. Immutable external
historical links are retained as citations; this offline check does not claim their
remote availability.
`tests/` covers repository workflow security and fail-closed scope selection.

Run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm test` and
`node scripts/ci-metadata-check.mjs`. Native product scripts live in
`runtime/scripts/` and release tooling in `runtime/distribution/`.
