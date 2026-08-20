---
"specgit": patch
---

### Provider adapter home: src/providers/github (zero-behavior move)

Translates the GitHub adapter to the neutral per-platform home (#113,
Phase-2 entry of the GitLab roadmap). `src/github/gh-cli.ts` and
`src/github/protection-merge.ts` move verbatim to
`src/providers/github/` (the only edit inside the moved files is three
relative import specifiers); `src/github/port.ts` — the `GitHubProvider`
port and its fact types — stays where the #80 compatibility policy pins
it.

- **Zero regression by construction:** the legacy `src/github/gh-cli.ts`
  and `src/github/protection-merge.ts` paths remain as stable alias
  modules (`export *` from the canonical home), so the existing GitHub
  suite passes **without editing a single test file** — verified as
  identical counts before and after (651 passed | 1 skipped).
- **Production imports repointed:** `src/index.ts` and `src/cli/wiring.ts`
  now import `GhCliGitHubProvider` from the canonical home; the public
  API surface is unchanged (same exported names, same types).
- **Contract tests extended (#80):** the provider-port contract test now
  pins the canonical home — `GhCliGitHubProvider` implements
  `GITHUB_PROVIDER_MEMBERS` from `src/providers/github/gh-cli.ts`, the
  legacy alias modules re-export the *same* class and functions (identity,
  never copies), and the public API re-exports the canonical
  implementation.
