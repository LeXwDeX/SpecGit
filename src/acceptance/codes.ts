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
  record_missing: {
    kind: 'evidence',
    message: 'No .specgit.yaml delivery binding found.',
    fix: 'Run "specgit bind" to create the delivery binding.',
  },
  record_invalid: {
    kind: 'evidence',
    message: 'The .specgit.yaml delivery binding is invalid.',
    fix: 'Fix or recreate .specgit.yaml, then run "specgit accept" again.',
  },
  policy_missing: {
    kind: 'evidence',
    message: 'No spec_git/policy.yaml found.',    fix: 'Run "specgit init --required-check <name>" to declare required checks.',
  },
  policy_invalid: {
    kind: 'evidence',
    message: 'spec_git/policy.yaml is invalid.',
    fix: 'Declare at least one required check name in spec_git/policy.yaml.',
  },
  issues_empty: {
    kind: 'factual',
    message: 'The delivery binding lists no issues.',
    fix: 'Bind at least one GitHub issue number.',
  },
  pr_missing: {
    kind: 'factual',
    message: 'The delivery binding has no pull request.',
    fix: 'Bind the pull request that delivers this work.',
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
    message: "The merged pull request's merge commit is not contained by local HEAD.",
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
    fix: 'Add an origin remote pointing at the github.com repository.',
  },
  origin_unresolvable: {
    kind: 'factual',
    message: 'The origin remote does not resolve to a github.com repository.',
    fix: 'Point origin at a github.com repository (https or ssh).',
  },
  gitlab_unsupported: {
    kind: 'factual',
    message: 'The origin remote points at a GitLab repository; GitLab evidence requires glab support, which is not implemented yet.',
    fix: 'Declare the platform with "specgit init --gitlab-host <hostname>" and see docs/gitlab-support.md for the glab roadmap.',
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
    message: 'A list-shaped evidence input was silently truncated; the verdict cannot be complete.',
    fix: 'This is a completeness guard, not a delivery defect: the repository exceeds a provider list window (e.g. more than 1000 open issues via GitHub search). Narrow the list — deliver or close issues — and re-run.',
  },
  issue_not_found: {
    kind: 'factual',
    message: 'A bound issue does not exist on GitHub.',
    fix: 'Remove or correct the issue number in .specgit.yaml.',
  },
  issue_is_pull_request: {
    kind: 'factual',
    message: 'A bound issue number refers to a pull request, not an issue.',
    fix: 'Bind the underlying issue, not the pull request number.',
  },
  pr_not_found: {
    kind: 'factual',
    message: 'The bound pull request does not exist on GitHub.',
    fix: 'Bind the correct pull request explicitly with "specgit pr <number>", or run "specgit issue" to open a pull request if none exists yet.',
  },
  pr_closed_unmerged: {
    kind: 'factual',
    message: 'The bound pull request is closed without being merged.',
    fix: 'Bind a pull request that is open or merged.',
  },
  pr_draft: {
    kind: 'factual',
    message: 'The bound pull request is still a draft.',
    fix: 'Mark the pull request ready for review, then run "specgit accept" again: GitHub "gh pr ready <number>", GitLab "glab mr update <number> --ready". A draft is not done.',
  },
  pr_head_mismatch: {
    kind: 'factual',
    message: 'The pull request head branch does not match the delivery branch.',
    fix: 'Update the PR head to the bound branch, or update the binding.',
  },
  pr_repo_mismatch: {
    kind: 'factual',
    message: 'The bound pull request URL belongs to a different repository than origin.',
    fix: 'Bind a pull request from the origin repository.',
  },
  closing_refs_incomplete: {
    kind: 'factual',
    message: 'The PR body does not close every bound issue.',
    fix: 'Add closing keywords (e.g. "Closes #N") for each listed issue to the PR body.',
  },
  issue_out_of_order: {
    kind: 'factual',
    message: 'policy ordered_issues is on and an open issue precedes this delivery.',
    fix: 'Deliver or close the earlier issue first, or turn off ordered_issues in spec_git/policy.yaml (a reviewed policy change).',
  },
  checks_missing: {
    kind: 'factual',
    message: 'A required check did not run at the PR head.',
    fix: 'Ensure the required GitHub Actions workflow runs on the PR head commit.',
  },
  checks_pending: {
    kind: 'factual',
    message:
      'A required check has not completed at the PR head (transient: queued or in progress).',
    fix: 'Pending is not failure — nothing needs repair. Wait for the check to finish, then run "specgit accept" again; re-running is safe and idempotent.',
  },
  checks_failed: {
    kind: 'factual',
    message: 'A required check failed at the PR head.',
    fix: 'Fix the failing check, then run "specgit accept" again. A conclusion of action_required means the run never started: it is waiting for maintainer approval (typical for a bot-pushed PR head) — approve the run in the Actions tab or re-push the head from an actor with write access.',
  },
  local_head_stale: {
    kind: 'evidence',
    message: 'The local HEAD is not the PR head; acceptance is about the PR.',
    fix: 'Pull the PR head if you want local parity.',
  },
};
