---
"specgit": patch
---

### Explicit-port origin classification: default ports in, non-default declared (#78)

Closes #78 (absorbing facets 2 and 6 of #88 per the W1′ wave anchor).
Legitimate remotes such as `ssh://git@github.com:22/owner/repo.git` failed
with `origin_unresolvable`; explicit ports equal to the scheme default now
classify identically to the portless form, without reopening the spoofing
surface (userinfo, path, query, host-suffix).

- `src/gitfacts/origin.ts`: the port rule is one seam decision — a shape's
  effective port (explicit digits, else the scheme default: 443 https,
  22 ssh; scp is implicitly ssh:22) classifies when it equals the scheme
  default, or exactly the port a GitLab declaration names. github.com and
  the `*gitlab*` heuristic never accept non-default ports; a declaration
  may (`--gitlab-host host:port`, persisted as `gitlab.port`), and then
  only that exact host:port classifies. Leading-zero ports normalize with
  WHATWG URL semantics (`:022` is 22); ports 0/65536+/non-digit never
  classify. `extractOriginHost` mirrors the same normalization so the
  whole seam answers one port question one way.
- 88-6 (g5 folding): the evaluator's origin gate now reports
  `gitlab_unsupported` under its own code (factual, exit 1 — complete
  evidence saying the platform is GitLab) instead of folding every
  failure into `origin_unresolvable` with GitHub-pointing advice;
  `docs/troubleshooting.md`'s stale "(exit 3)" claim aligned to the
  implemented contract.
- 88-2 (init seam): `specgit init`'s regex host extractor is replaced by
  the structural `extractOriginHost` seam — the host never carries
  userinfo or port digits, the explicit port is captured separately — so
  `ssh://git@github.com:22/...` platform-resolves to github and
  `--gitlab-host` validates host and port against the origin endpoint
  (both directions, with the fix naming the `host:port` grammar). The
  TTY-question path persists the port for non-default-port origins.
- TDD: port truth table + spoof corpus in `test/specgit/origin.test.ts`
  (default ports in, `:8443` undeclared still rejected, declared
  host:port exact-match, malformed declarations fail closed), evaluator
  case `gitlab_unsupported` in `test/specgit/acceptance.test.ts`, init
  tests for the seam and declaration grammar; every slice red-first with
  a mutation revert-check recorded in the PR.
