---
"specgit": patch
---

### Nested-group origins on declared hosts resolve; platform routing reads providers.yaml (#112)

Closes #112. rc.1 correctly classified nested-group GitLab origins as
`gitlab_unsupported` (#95) — a diagnostic, not capability. The GA gate
needs `specgit finish` exit 0 on a real nested-group GitLab delivery,
which starts with the origin grammar accepting depth-2-plus paths on
declared hosts and platform selection routing through the committed
`spec_git/providers.yaml` declaration.

- `src/gitfacts/origin.ts`: on a **declared** host (and only there —
  the `*gitlab*` substring heuristic never resolves a ref, so no
  substring match grants capability), `parseRepoRef` now accepts
  `group[/subgroup…]/project` paths at depth 2–5, URL-encoded `%2F`
  separators included (both letter cases; any other percent-escape
  fails closed), on all three origin forms (https, ssh URL, scp-like).
  The resolved ref carries the full group path as its owner plus a
  `gitlab` platform marker — reachable solely through the declaration.
  A well-formed path deeper than 5 segments fails closed as
  `gitlab_unsupported` naming the bound; malformed paths, depth-1
  paths, and the scp port-intent shape keep `origin_unresolvable`.
  The GitHub three-form truth table is pinned unchanged (no nested
  paths, no `%2F` decoding on `github.com`).
- Platform routing (#100 selection rule, seam implemented): the new
  `requireGithubRoute` guard is the one seam decision — a ref marked
  `gitlab` fails closed `gitlab_unsupported` with declaration-aware
  text (factual, exit 1: the declaration and grammar are accepted, the
  glab provider is not implemented yet). The evaluator's origin gate
  (G5) and the production CLI wiring (every gh-backed command: `issue`,
  `pr`, `finish`, `status`, `doctor`, `init`) route through it, so no
  `gh` call ever sees a group/subgroup ref; `classifyPlatform` stays
  diagnostics-only.
- Docs: `docs/reference.md` G5 paragraph documents the accepted forms
  and the routing rule; `docs/gitlab-support.md` current-behavior and
  Phase-2 selection-rule sections updated; `docs/cli.md` platform-mode
  paragraph aligned; evidence ledger row 4 updated from live-cell-only
  to grammar-implemented (API-side `%2F` addressing stays with the
  glab adapter slice).
- TDD: origin grammar truth table (depth 2–5 × three forms, `%2F`
  decode, depth bound, escape rejection, heuristic/undeclared/github
  pins, spoof corpus) and evaluator routing pins (origin gate failure,
  provider never invoked) — red-first with mutation revert-checks
  recorded (decode removal and depth-bound removal re-redden the
  origin suite; routing removal re-reddens the evaluator suite).
