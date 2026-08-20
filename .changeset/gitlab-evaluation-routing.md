"specgit": patch
---

### GitLab evaluation routing, e2e variant, and the nested-group dogfood (#117)

The Phase-2 routing slice: a declared GitLab origin is now SERVED, not
just recognized.

- New `PlatformRoutingProvider` (`src/providers/routing.ts`) at the
  production composition (`src/cli/wiring.ts`): one provider for the
  commands, dispatching every call on the ref's platform marker (#112)
  — GitLab-declared refs to `GlabProvider` (constructed lazily with the
  declared hostname and the policy's `required_checks`, per #116),
  everything else to the gh adapter. `preflight()` follows the delivery
  origin's resolved platform. The #112 invariant "no gh call ever sees
  a group/subgroup ref" moves from the retired `requireGithubRoute`
  guard into the dispatch (pinned by
  `test/specgit/routing-provider.test.ts` and the offline e2e's
  git-and-glab-only PATH).
- `specgit finish` on a declared GitLab origin evaluates all eleven
  gates through glab (the origin gate passes the platform-marked ref;
  the closing gate already parses the GitLab dialect since #115).
  Undeclared `gitlab`-looking hosts and too-deep paths still fail
  `gitlab_unsupported` at parse level.
- `specgit init` on gitlab mode writes every platform-neutral harness
  asset but NO GitHub Actions workflow (`gitlab_harness_pending`
  warning; `harness: { template: 'gitlab-pending' }`) — the repo
  carries its own `.gitlab-ci.yml`, whose top-level job keys init
  detects as required checks.
- `specgit doctor`'s provider probes follow the platform (envelope keys
  `gh_present`/`gh_authenticated` stay; `glab_missing` /
  `glab_unauthenticated` map onto them).
- e2e: `external-repo-fixture.ts` gains the GitLab variant
  (`makeGitlabExternalRepo` — nested-group origin, pushable bare
  remote, own `.gitlab-ci.yml`); `gitlab-delivery.e2e.test.ts` proves
  the full delivery story offline on recorded payload shapes from
  `test/specgit-e2e/fixtures/gitlab/` (init → issue/MR bootstrap with
  the `Draft: ` prefix and the deterministic scaffold → finish exit 0,
  all gates green, zero gh reachable).
- Dogfood evidence (GA gate 4): a real nested-group delivery on
  git.ycgame.com 19.2.4 CE with `specgit finish` exit 0 — archived in
  [docs/release-gates.md](../docs/release-gates.md) GA-4 and
  [docs/evidence/gitlab-19.2.md](../docs/evidence/gitlab-19.2.md);
  FU-5 (read-only project access token) applied as the CI-side glab
  credential.
- GitHub-side zero regression: the GitHub paths are byte-unaffected
  (router dispatch is a no-op for github refs; gh tests unchanged).
