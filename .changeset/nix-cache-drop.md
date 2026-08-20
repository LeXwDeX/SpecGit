---
"specgit": patch
---

### CI: drop the deprecated magic-nix-cache step from Nix Flake Validation

Removes the pinned `DeterminateSystems/magic-nix-cache-action@…# v14` step
from the `nix-flake-validate` job in `.github/workflows/ci.yml` (#85, W0′
decision: repair option). magic-nix-cache is deprecated upstream and its
FlakeHub registration path fails intermittently from external decay,
red-noising Nix-touching runs without any product regression (observed on
main run [32313535281](https://github.com/LeXwDeX/SpecGit/actions/runs/32313535281);
green again by luck on run 32349155015). The job now builds cold on the
ephemeral runner store — `nix build`'s sandboxed pnpm fetch needs no cache
backend, and `spec_git/policy.yaml` is untouched.

`test/ci-workflows.test.ts` pins the repair: no workflow may reference
magic-nix-cache again (red-first: the pin failed on the pre-change tree).
