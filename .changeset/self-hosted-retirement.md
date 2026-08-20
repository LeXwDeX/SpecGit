---
"specgit": patch
---

### CI: retire the never-green self-hosted-linux test leg (#105)

Removes the experimental `test_selfhosted` shadow job
(`continue-on-error: true`) from `.github/workflows/ci.yml`. The leg was
never green: every execution since introduction crashed at job
initialization with zero steps run — the runner container cannot create
its tool-cache directory (`/home/runner/work/_tool`, permission denied) —
an infrastructure-side failure no repository change can influence
([W1 diagnosis](https://github.com/LeXwDeX/SpecGit/issues/105#issuecomment-5356816362)).
The GA-1 retirement line (end of W2, user ruling 2026-08-20) was reached
with the last five consecutive `main` runs red on the leg (through
`15ce8ef`), so self-hosted coverage leaves the release matrix with the
rationale recorded on the issue and referenced from
[docs/release-gates.md](../docs/release-gates.md) §3. Required checks are
untouched — hosted `linux-bash`/`macos-bash`/`windows-pwsh` legs stay,
`spec_git/policy.yaml` unchanged.

`test/specgit-cli/workflow-security.test.ts` pins the retirement
red-first: no job may run on the self-hosted pool and no matrix entry may
carry the self-hosted label or runner (the pin failed on the pre-change
tree).
