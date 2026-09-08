# Verified-input reuse

A project can avoid repeating expensive verification when its business inputs
are unchanged. This is an optional part of `verification` policy; leaving out
`verification.reuse` keeps ordinary current-run execution.

Reuse applies to declared verification commands. Current delivery checks and
`specgit finish` still run, and configured merge and issue closure still require
their own evidence. An applicability decision is never an accepted delivery.

## What authorizes reuse

The approved target-branch policy defines a profile: one public check name,
exact Node.js and pnpm versions, an installed SpecGit runtime with an npm
lockfile, commands, fresh commands, and a fixed provider integration. Candidate
policy cannot authorize itself. Review the policy and generated harness together
before relying on reuse.

`commands` run from a normalized copy of the complete committed business tree.
Only the strictly recognized root `.specgit.yaml` binding is excluded. The copy
has no Git metadata or CI event variables. Declare commands as executable and
argument arrays; declare nonsecret literal environment values explicitly.
`fresh_commands` run on every applicable or non-applicable decision, including a
reuse hit, and must cover checks that depend on current delivery state.

A successful original is reusable only when all of these facts are proved:

- The current repository, profile, approved policy/base, complete tracked input
  fingerprint, toolchain and observed execution environment match.
- Native platform records identify the original job and its successful original
  execution. Generated producer files match the approved bytes at that commit.
- Its original completion time remains inside `max_age_seconds` (60–86400).
  Reusing a result does not restart the clock and never creates a new original.
- The bounded native inventory is complete. An unprovable or failed newer
  original cannot be hidden by an older green result.

GitLab runs current delivery acceptance in a separate authenticated job after
all public verification checks. A draft can fail that acceptance while its
business verification succeeds. Only a proved independent acceptance failure
may coexist with reusable original evidence; a failed original, preparation,
bridge or another business check still prevents reuse.

At selection, unknown, missing, erased, changed or expired original evidence
causes actual verification to execute. A changed input or invalid plan discovered
after preparation rejects that attempt and requires a fresh run. A failed current command remains a failure. This is evidence-based
reuse, not a filesystem cache or a general isolation boundary for arbitrary code.

## Configure a profile

Add profiles under `verification.reuse` using the fields described in the
[policy schema](../schemas/specgit/schema.yaml). Keep ordinary `required_checks`
and the applicability rules consistent with each profile's public `check`.
Each profile has distinct `id`, `check`, and GitHub workflow entry values.
Public check names cannot collide with SpecGit evidence jobs. A GitLab check
must be an executable job name; hidden jobs and global CI configuration keys
are rejected before generating a workflow.

Pin a SpecGit runtime that contains this feature. Use either an exact published
package version or a reviewed local tarball with its SHA256. Both require a
committed npm lockfile matching the runtime dependency; generated jobs use
`npm ci --ignore-scripts`. An older published package without the verification
entry point cannot execute these jobs. Local tarballs allow verification before
a feature release is published.

Pin GitHub profiles to a supported hosted runner (`ubuntu-24.04`, `windows-2025`,
or `macos-15`) and a local `.github/workflows/*.yml` entry. The workflow grants
only contents, actions and pull-request read access. It separates original and
reuse jobs and always emits a fresh stable public check.

GitLab profiles use an image digest, runner tags, and the configured local
`verification.gitlab_entry` (default `.gitlab-ci.yml`). All profiles share that
entry. Optional bootstrap commands install the exact declared tools. The image
and observed package inventory are part of the environment evidence. Ensure
the installed glab supports native CI job authentication and the required
read-only API capabilities; missing capability cannot grant reuse.

GitLab provenance links the original child job to its native parent bridge and
signed preparation identity. The parent assertion remains a native artifact;
the child's downloaded copy is removed before business commands run. No custom
signing service or user token distribution is required.
The same signed native configuration proves the current pipeline's entry; a
mutable project-settings response is not substituted for that execution proof.

The generated `SpecGit Acceptance` job invokes `.gitlab/specgit-accept.mjs`
with the first GitLab profile's pinned runtime and bootstrap tools. It runs with
the project's authenticated glab session, outside the isolated business runner,
whether completion automation is off, close-only or merge-enabled. Its runtime
is moved outside the checkout before the ordinary dirty/context gates run.
No preparation artifacts are downloaded into this job. Read-only job-token
capability sufficient for reuse is not a substitute for the forge capabilities
required by `finish`; unavailable acceptance evidence still exits 3.

GitLab's `/job` endpoint identifies the executing job through its native CI
session. SpecGit queries that endpoint through glab in temporary empty
configuration, excluding user-token overrides for that call only. Other forge
evidence and `finish` retain the project's authenticated session. This keeps
configured acceptance credentials from overriding native job identity; SpecGit
does not extract credentials or write them into the temporary configuration.

Run `specgit init --force --no-protect` to regenerate the declared workflows,
then inspect `specgit status --json` and review the diff before committing.
Generated verification files and their retirement manifest are derived harness
assets. Existing user files and authoritative declarations are protected by the
managed asset transaction. With GitLab completion enabled, the existing router
keeps business verification separate from trusted completion.

## Acceptance evidence

Validate the full sequence on each configured platform: original execution,
binding-only change with a reuse hit, changed business input that executes
again, expired or unavailable original that executes again, and a failing fresh
check that prevents acceptance. A successful uncached CI run proves execution;
it does not prove that reuse occurred. Keep those outcomes distinct in evidence.
