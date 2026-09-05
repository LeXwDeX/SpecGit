# GitLab Support

## Declare the host

Use `glab >=1.113.0`, authenticated for the exact GitLab host:

```bash
glab auth status --hostname gitlab.example.com
specgit init --gitlab-host gitlab.example.com
```

The host declaration lives in `spec_git/providers.yaml`. GitLab.com also needs
an explicit declaration: use `--gitlab-host gitlab.com`. It is probed for
capabilities; the version window below describes qualified self-managed servers.

## Compatibility

The verified self-managed window is **GitLab CE/Free >= 19.2.4 < 19.4.0**.
Outside it, `gitlab_version_unverified` warns and live evidence remains subject
to fail-closed verification. The warning does not manufacture a passing result.
GitHub Enterprise has no v1 provider route.

## Pipeline ownership

GitLab business CI stays project-owned. Establish a reviewed job that runs
`specgit finish --json`; basic init does not generate a GitHub Actions workflow
for GitLab. The `gitlab_harness_pending` warning identifies the acceptance
integration the project must supply.

When the user enables completion automation and the existing layout can be
safely reconciled, SpecGit installs a completion route while preserving the
business configuration. Consult the canonical guide for supported include layouts
and prerequisites before opting in. An unprovable layout cannot be rewritten
as if it were supported.

`finish` reads MR and pipeline/job facts through the authenticated `glab` session.
Checks must belong to the expected head; absent, canceled, or non-final work
cannot silently become successful. `specgit pr --merge` needs approved automation,
the configured target, fresh acceptance, and the current pipeline evidence.
Issue closure follows a confirmed merge.

[Detailed support and evidence](https://github.com/LeXwDeX/SpecGit/blob/main/docs/gitlab-support.md) · [中文](GitLab-Support-zh)
