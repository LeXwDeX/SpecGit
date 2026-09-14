# Repository verification

`ci-change-scope.mjs` classifies complete committed diffs for native CI.
`ci-metadata-check.mjs` checks active documentation and retired v1 entry points.
`tests/` covers repository workflow security and fail-closed scope selection.

Run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm test` and
`node scripts/ci-metadata-check.mjs`. Native product scripts live in
`runtime/scripts/` and release tooling in `runtime/distribution/`.
