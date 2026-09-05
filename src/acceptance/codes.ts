import { RECORD_MISSING_FIX } from '../kernel/diagnostics.js';

export type SpecGitCode =
  | 'record_missing'
  | 'record_invalid'
  | 'policy_missing'
  | 'policy_invalid'
  | 'issues_empty'
  | 'pr_missing'
  | 'not_a_git_repo'
  | 'git_unavailable'
  | 'no_commits'
  | 'detached_head'
  | 'branch_mismatch'
  | 'worktree_mismatch'
  | 'merged_delivery_not_contained'
  | 'merged_lineage_unavailable'
  | 'no_origin'
  | 'origin_unresolvable'
  | 'gitlab_unsupported'
  | 'gitlab_version_unverified'
  | 'gh_missing'
  | 'gh_unauthenticated'
  | 'gh_transport'
  | 'glab_missing'
  | 'glab_unauthenticated'
  | 'glab_transport'
  | 'evidence_truncated'
  | 'issue_not_found'
  | 'issue_is_pull_request'
  | 'issue_already_claimed'
  | 'issue_occupancy_unknown'
  | 'title_language_mismatch'
  | 'title_evidence_missing'
  | 'issue_labels_invalid'
  | 'issue_labels_unavailable'
  | 'body_evidence_missing'
  | 'body_content_incomplete'
  | 'pr_not_found'
  | 'pr_closed_unmerged'
  | 'pr_draft'
  | 'pr_head_mismatch'
  | 'pr_repo_mismatch'
  | 'closing_refs_incomplete'
  | 'issue_out_of_order'
  | 'checks_missing'
  | 'checks_pending'
  | 'checks_failed'
  | 'local_head_stale';

export type CodeKind = 'factual' | 'evidence';

export interface CodeInfo {
  kind: CodeKind;
  message: string;
  fix?: string;
}

/**
 * The one registry of SpecGit diagnostic codes. `factual` codes are decisive
 * findings with complete evidence (verdict: rejected, exit 1); `evidence`
 * codes mean evaluation could not complete and the verdict fails closed
 * (unknown, exit 3).
 */
export const CODE_INFO: Record<SpecGitCode, CodeInfo> = {
  issue_already_claimed: {
    kind: 'factual', message: 'A bound issue is already claimed by another active pull or merge request.',
    fix: 'Continue the existing delivery or resolve its binding before accepting another request for the same issue.',
  },
  issue_occupancy_unknown: {
    kind: 'evidence', message: 'Complete current issue occupancy could not be verified.',
    fix: 'Restore the forge evidence and retry; do not infer that the issue is unclaimed.',
  },
  body_evidence_missing: {
    kind: 'evidence', message: 'The forge did not provide the complete body required by project rules.',
    fix: 'Retry after the remote issue or PR/MR body is available.',
  },
  body_content_incomplete: {
    kind: 'factual', message: 'The body has empty required sections or unfilled placeholders.',
    fix: 'Fill the selected project template with the actual delivery content.',
  },
  title_language_mismatch: {
    kind: 'factual',
    message: 'The title violates the explicitly selected project language rule.',
    fix: 'Edit the issue or pull/merge request title to match the project language, then re-run specgit finish.',
  },
  title_evidence_missing: {
    kind: 'evidence',
    message: 'The forge did not provide the title required for validation.',
    fix: 'Retry when the issue and pull/merge request titles are available from the forge.',
  },
  issue_labels_invalid: {
    kind: 'factual',
    message: 'The issue labels violate the selected project vocabulary or axis rule.',
    fix: 'Choose labels from the policy and remove conflicting labels, then re-run specgit finish.',
  },
  issue_labels_unavailable: {
    kind: 'evidence',
    message: 'The forge did not provide the issue labels required for validation.',
    fix: 'Retry when the complete issue label set is available from the forge.',
  },
  record_missing: {
    kind: 'evidence',
    message: 'No .specgit.yaml delivery binding found.',
    fix: RECORD_MISSING_FIX,
  },
  record_invalid: {
    kind: 'evidence',
    message: 'The .specgit.yaml delivery binding is invalid.',
    fix: 'Fix or recreate .specgit.yaml, then run "specgit finish" again.',
  },
  policy_missing: {
    kind: 'evidence',
    message: 'No spec_git/policy.yaml found.',
    fix: 'Run "specgit init" to create the policy and generate the harness.',
  },
  policy_invalid: {
    kind: 'evidence',
    message: 'spec_git/policy.yaml is invalid.',
    fix: 'Repair or recreate spec_git/policy.yaml according to the reported schema error, then re-run; required_checks may be an empty list for the no-CI policy, but every listed name must be a non-empty string.',
  },
  issues_empty: {
    kind: 'factual',
    message: 'The delivery binding lists no issues.',
    fix: 'Bind at least one issue number from the current forge.',
  },
  pr_missing: {
    kind: 'factual',
    message: 'The delivery binding has no pull or merge request.',
    fix: 'Bind the pull or merge request that delivers this work.',
  },
  not_a_git_repo: {
    kind: 'evidence',
    message: 'Not inside a git repository.',
    fix: 'Run specgit from inside a git checkout.',
  },
  git_unavailable: {
    kind: 'evidence',
    message: 'The git executable could not be found.',
    fix: 'Install git or add it to PATH.',
  },
  no_commits: {
    kind: 'evidence',
    message: 'The repository has no commits yet.',
    fix: 'Create at least one commit on the delivery branch.',
  },
  detached_head: {
    kind: 'factual',
    message: 'HEAD is detached; the execution context is a branch.',
    fix: 'Check out the delivery branch.',
  },
  branch_mismatch: {
    kind: 'factual',
    message: 'The current branch does not match the branch in the delivery binding.',
    fix: 'Check out the branch named in .specgit.yaml, or update the binding.',
  },
  worktree_mismatch: {
    kind: 'factual',
    message: 'The current checkout does not match the worktree in the delivery binding.',
    fix: 'Run from the bound worktree whose label resolves to the bound branch.',
  },
  merged_delivery_not_contained: {
    kind: 'factual',
    message: "The merged request's provider-reported merge commit is not contained by local HEAD.",
    fix: 'Fetch and check out the base branch that received the merge (e.g. git pull), then re-run. A rewritten local history cannot prove lineage.',
  },
  merged_lineage_unavailable: {
    kind: 'evidence',
    message: 'Merged-delivery lineage could not be established from provider and local git evidence.',
    fix: 'git fetch the remote and pull the base branch that received the merge, then re-run so the merge commit can be verified against local HEAD.',
  },
  no_origin: {
    kind: 'factual',
    message: 'The repository has no origin remote.',
    fix: 'Add an origin remote pointing at the supported forge repository.',
  },
  origin_unresolvable: {
    kind: 'factual',
    message: 'The origin remote does not resolve to a supported forge repository.',
    fix: 'First correct origin so its host, port, and repository path resolve to a supported forge repository. For a syntactically valid GitLab origin that is not declared yet, run "specgit init --force --gitlab-host <hostname> --no-protect" (omit --force before first init; append --no-ignore for the intentionally tracked authoritative model).',
  },
  gitlab_unsupported: {
    kind: 'factual',
    message: 'The origin looks like GitLab but lacks a matching declaration or falls outside the supported GitLab origin grammar.',
    fix: 'For an initialized repository declare the exact host with "specgit init --force --gitlab-host <hostname> --no-protect" (omit --force before first init; append --no-ignore for the intentionally tracked authoritative model); if already declared, use a matching port and a group[/subgroup…]/project path with 2–5 segments.',
  },
  gitlab_version_unverified: {
    kind: 'evidence',
    message: 'The self-managed GitLab version is outside the verified window (>= 19.2.4 < 19.4.0); acceptance proceeded against the live APIs.',
    fix: 'If any gate behaves unexpectedly, land a rebaseline delivery that moves the verified window — see docs/gitlab-support.md.',
  },
  gh_missing: {
    kind: 'evidence',
    message: 'GitHub CLI (gh) is not installed or not on PATH.',
    fix: 'Install gh from https://cli.github.com/ and run "gh auth login".',
  },
  gh_unauthenticated: {
    kind: 'evidence',
    message: 'GitHub CLI is not authenticated.',
    fix: 'Run "gh auth login" to authenticate.',
  },
  gh_transport: {
    kind: 'evidence',
    message: 'GitHub evidence could not be gathered.',
    fix: 'Check your network connection and gh permissions, then retry.',
  },
  glab_missing: {
    kind: 'evidence',
    message: 'GitLab CLI (glab) is not installed or not on PATH.',
    fix: 'Install glab from https://gitlab.com/gitlab-org/cli and run "glab auth login --hostname <host>".',
  },
  glab_unauthenticated: {
    kind: 'evidence',
    message: 'GitLab CLI is not authenticated for the declared host.',
    fix: 'Run "glab auth login --hostname <host>" to authenticate.',
  },
  glab_transport: {
    kind: 'evidence',
    message: 'GitLab evidence could not be gathered.',
    fix: 'Check your network connection to the GitLab host and glab permissions (SPECGIT_GLAB_TIMEOUT_MS raises the per-call budget), then retry.',
  },
  evidence_truncated: {
    kind: 'evidence',
    message: 'A list-shaped evidence input may be incomplete or truncated; the verdict cannot be complete.',
    fix: 'Complete or reduce the evidence collection named by the failure, then re-run. Issues, checks, timelines, labels, comments, workflows, and pipelines must never be judged from a partial list.',
  },
  issue_not_found: {
    kind: 'factual',
    message: 'A bound issue does not exist on the configured forge.',
    fix: 'Recreate the binding with "specgit unbind --yes", then run "specgit bind --delivery <id> --issue <n>... --pr <ref>" using only valid issue numbers.',
  },
  issue_is_pull_request: {
    kind: 'factual',
    message: 'A bound issue lookup resolved to a pull request, not an issue.',
    fix: 'Bind the tracking issue, not the pull request number.',
  },
  pr_not_found: {
    kind: 'factual',
    message: 'The bound pull or merge request does not exist on the configured forge.',
    fix: 'If the request already exists, bind it with "specgit pr <number>". Otherwise create a draft PR/MR from the bound branch with the forge CLI, preserving the required body and every closing reference, then run "specgit pr" to discover and bind it.',
  },
  pr_closed_unmerged: {
    kind: 'factual',
    message: 'The bound pull or merge request is closed without being merged.',
    fix: 'Bind a request that is open or merged.',
  },
  pr_draft: {
    kind: 'factual',
    message: 'The bound pull or merge request is still a draft.',
    fix: 'Mark it ready for review, then run "specgit finish" again: GitHub "gh pr ready <number>", GitLab "glab mr update <number> --ready". A draft is not accepted.',
  },
  pr_head_mismatch: {
    kind: 'factual',
    message: 'The pull or merge request head branch does not match the delivery branch.',
    fix: 'First close the obsolete open request or remove its closing references so it no longer claims the bound issues. Then bind an existing PR/MR whose head matches the delivery with "specgit pr <number>", or create one from the bound branch and bind its number, then re-run.',
  },
  pr_repo_mismatch: {
    kind: 'factual',
    message: 'The bound request URL belongs to a different repository than origin.',
    fix: 'Bind a pull or merge request from the origin repository.',
  },
  closing_refs_incomplete: {
    kind: 'factual',
    message: 'The pull or merge request body does not close every bound issue.',
    fix: 'Add closing keywords (e.g. "Closes #N") for each listed issue to the request body.',
  },
  issue_out_of_order: {
    kind: 'factual',
    message: 'policy ordered_issues is on and an open issue precedes this delivery.',
    fix: 'Deliver or close the earlier issue first, or turn off ordered_issues in spec_git/policy.yaml (a reviewed policy change).',
  },
  checks_missing: {
    kind: 'factual',
    message: 'A required check did not run at the request head.',
    fix: 'Ensure the configured GitHub workflow or GitLab pipeline job runs on the current PR/MR head commit, then run "specgit finish" again.',
  },
  checks_pending: {
    kind: 'factual',
    message:
      'A required check has not completed at the request head (transient: queued or in progress).',
    fix: 'Pending is not failure — nothing needs repair. Wait for the check to finish, then run "specgit finish" again; re-running is safe and idempotent.',
  },
  checks_failed: {
    kind: 'factual',
    message: 'A required check failed at the request head.',
    fix: 'Fix the failing check, then run "specgit finish" again. On GitHub, action_required means the run never started and needs maintainer approval in Actions or a re-push by an actor with write access.',
  },
  local_head_stale: {
    kind: 'evidence',
    message: 'The local HEAD is not the request head; acceptance is about the remote request.',
    fix: "Run git fetch origin, check out the bound request's head branch, update it to the remote head (for a tracking branch, git pull --ff-only), then re-run.",
  },
};
