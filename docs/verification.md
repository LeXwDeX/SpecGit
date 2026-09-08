# Applicable verification

SpecGit can select business checks from the changes in a delivery. The selection
is shared by CI planning, the generated waiter, acceptance and historical
completion. The project still owns its build, test and deployment commands.

Configure the rules in `spec_git/policy.yaml` through a reviewed delivery:

```yaml
version: 1
required_checks: [Verification]
verification:
  product_checks: [Build, Test]
  rules:
    - paths: [README.md, 'docs/**']
      checks: [Docs]
```

`required_checks` remain unconditional and retain their previous meaning.
`product_checks` are the nonempty fallback for unmatched inputs. Every matching
rule contributes its check names; mixed changes take their union. A rule may
declare `checks: []` when the approved project policy requires no business
check for those paths. Omitting `verification` retains the fixed-check behavior.
Plain `init --force` preserves this configuration.

For GitLab, `verification.gitlab_entry` optionally declares a custom local CI
entry such as `ci/pipeline.config`; omission means `.gitlab-ci.yml`. Open MR
planning and acceptance verify the current project setting against this approved
declaration, and completion checks it again before merging. Mismatch or unavailable
settings fail closed. URL and cross-project entries are unsupported by path
selection. The declared entry always requires product checks, regardless of
matching path rules. Historical assessment protects the original approved entry;
that declaration does not prove historical platform settings.

The decision is explicit and read-only:

```sh
specgit finish --plan-checks --json
```

Exit 0 means the plan is available. Read `verification.requiredChecks`, the
per-path `kind` and `reason`, and the pinned `policySha`, `policyHash`, `baseSha`,
`mergeBaseSha` and `headSha`. A fixed policy has `kind: fixed` and does not need
Git diff evidence. A configured policy has `kind: applicable`. Neither result
is an acceptance verdict. Run ordinary `specgit finish --json` after the
applicable checks. `--plan-checks` and `--scope` cannot be combined.

## Selection boundaries

- Valid recognized `.specgit.yaml` data gets an intrinsic `record` classification.
  Unknown fields, malformed content and changes to executable modes receive no
  exemption. This only avoids business checks; normal binding, issue, request,
  policy and CI evidence still undergo acceptance.
- Patterns are case-sensitive Git paths. `*` matches within one component;
  `**` is a whole component and cannot lead the pattern. There are no negations,
  parent traversal, brace expressions or implicit ignore-file exemptions.
- Unmatched files require product checks. Explicit rules are the project's
  declaration of affected checks, so include documentation in product checks
  when the product consumes that documentation. File size is irrelevant.
- CI configuration under `.github/`, `.gitlab/` and `.ci/`, the GitLab entry
  file, the declared custom GitLab entry, policy/provider configuration and recognized build/toolchain manifests
  always require product checks. Deletions, executable files and mode/type
  changes also require product checks. A rename retains both its old and new
  paths; renaming code into a documentation directory cannot conceal deletion.
- The reader uses full commit identities and one merge base. Shallow history,
  missing objects, multiple merge bases, truncated output and unsupported path
  evidence return exit 3. Unknown evidence never becomes an empty change set.
- An open PR uses approved target policy, so its proposed weaker rules cannot
  authorize it. A merged PR uses the original target policy and revision,
  including when current policy later removes verification rules. First-policy
  adoption retains the existing adoption boundary; it cannot authorize its own
  automated merge.

The plan does not reuse older green runs. Required checks still need current-head
truth and freshness. An executed failed check still blocks guarded completion
even when it was not selected. A skipped non-applicable business check may be
omitted; at least one executed successful check must still prove completion.

## Wiring project CI

Install the pinned SpecGit CLI in an isolated location, check out the event's
request head with complete target history, and use the authenticated `gh` or
`glab` session. Planning does not install the adopting project's dependencies or
run its lifecycle scripts. The generated acceptance workflow already prepares
its waiter from this shared decision; agents can wire project-specific business
jobs to the machine output.

Always schedule the classification and final acceptance statuses. Do not put
whole-workflow path filters on a required status: an absent workflow can leave
protection waiting forever. Do not list a conditionally skipped business check
in unconditional `required_checks`. Existing platform protection is not removed
by SpecGit; update the reviewed CI/protection configuration together when moving
a formerly unconditional name into conditional selection.

For GitHub, a lightweight `plan` job can publish the JSON check-name array:

```yaml
outputs:
  required: ${{ steps.select.outputs.required }}
steps:
  # After complete event-head checkout and isolated pinned CLI installation:
  - id: select
    shell: bash
    run: |
      specgit finish --plan-checks --json > "$RUNNER_TEMP/verification.json"
      node --input-type=module <<'JS'
      import fs from 'node:fs';
      const result = JSON.parse(fs.readFileSync(`${process.env.RUNNER_TEMP}/verification.json`, 'utf8'));
      if (result.exit !== 0 || !result.verification) process.exit(3);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `required=${JSON.stringify(result.verification.requiredChecks)}\n`);
      JS
```

A business job then uses `needs: plan` and, for example,
`if: contains(fromJSON(needs.plan.outputs.required), 'Build')`. Its expensive
toolchain installation belongs inside that selected job. A stable `Verification`
job with `if: always()` must depend on planning and all business jobs, fail when
planning fails, require success from each selected job and allow only
non-selected jobs to be skipped. The generated `SpecGit Acceptance` check waits
for this stable result and all selected names. Keep it out of `required_checks`
to avoid making it wait for itself.

For GitLab, a lightweight planning job can publish `verification.json` as an
artifact. Project jobs consume it before installing their own dependencies or
calling their business commands. For example, a Node-based guard within the
job's existing `script` can choose the project's Build command:

```js
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const plan = JSON.parse(fs.readFileSync('verification.json', 'utf8'));
if (plan.exit !== 0 || !plan.verification) process.exit(3);
if (!plan.verification.requiredChecks.includes('Build')) {
  console.log('Build: non-applicable under the recorded verification decision');
  process.exit(0);
}
const result = spawnSync('sh', ['-eu', '.ci/build.sh'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
```

The project can instead generate a child pipeline from the same decision when
it wants to avoid scheduling unused business jobs. Keep a stable final status
and ensure the selected jobs and child pipeline settle before acceptance.
Record-only pipelines run lightweight planning/validation; product pipelines run
the selected business commands. Logs and the decision distinguish intentional
non-applicability, a project with no sibling CI, and unavailable evidence.

## Evidence

`test/specgit-e2e/verification.e2e.test.ts` uses unrelated real Git repositories,
local bare remotes and the built CLI with deterministic GitHub/GitLab adapters.
It executes project-owned conditional business wiring, proves zero business
calls and no adopter dependencies for a binding-only change, and requires all
business checks after a mixed product edit. It measures planning plus acceptance
against a 30-second local test budget; runner provisioning and CLI installation
are outside that measurement. These are integration tests, not claims about a
live hosted adopter's pipeline duration.
