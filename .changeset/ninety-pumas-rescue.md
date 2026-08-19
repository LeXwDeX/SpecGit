---
"specgit": minor
---

### Strict issue input spec for `specgit issue`

- Issue titles must match `<type>: <english title>`; the type is validated
  against a fixed 14-entry whitelist (`feat`, `fix`, `refactor`, `perf`,
  `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`,
  `deprecate`, `dogfood`), and the title body must be printable ASCII.
  Missing/unknown types and non-English titles are usage errors (exit 2)
  that list the valid types; every title is validated before any issue is
  created.
- Created issue bodies follow a required/optional section template
  (`## Why (required)`, `## Scope (optional)`, `## Acceptance (required)`).

### Acceptance-bypass guard at `specgit init`

- After writing the policy and harness, `init` probes the default branch:
  when the `SpecGit Acceptance` check is not a required status check there,
  it warns that the acceptance gate can be bypassed, asks for confirmation
  on an interactive terminal, and (when confirmed, or with `--protect`)
  enables branch protection and repository auto-merge. `--no-protect` skips
  the probe. Provider or permission failures never fail `init`
  (fail-open); the `--json` envelope gains a `protection` section.

### GitLab origins recognized with a dedicated diagnostic

- `gitlab.com` and self-hosted `*gitlab*` origins now fail with
  `gitlab_unsupported` (instead of the generic `origin_unresolvable`),
  naming the actual gap and pointing at the published GitLab/glab support
  roadmap (`docs/gitlab-support.md`). `specgit doctor` surfaces the same
  code on its `origin` probe.
