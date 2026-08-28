/**
 * Execution-context resolution and local gate evaluation for the CLI layer.
 *
 * Context comes from live git only — `specgit bind` has no `--branch` or
 * `--worktree` flags. These builders produce the domain `GateResult` shape
 * (id/status/failures) for the local-evidence surface of `specgit status`;
 * `specgit accept` delegates all gates to the evaluator in
 * `src/acceptance/**`.
 */

import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { GateFailure, GateResult } from '../acceptance/evaluate.js';
import type { DeliveryBinding, ExecutionContext } from '../record/schema.js';
import type { Policy } from '../record/policy.js';
import type { GitFacts } from '../gitfacts/port.js';
import type { RepoRef } from '../gitfacts/origin.js';

export function resolveExecutionContext(facts: GitFacts): Evidence<ExecutionContext> {
  if (!facts.gitAvailable) {
    return fail(
      'git_unavailable',
      'The git executable could not be spawned.',
      'Install git and ensure it is on PATH.'
    );
  }
  if (facts.branch === null) {
    if (facts.headSha === null) {
      return fail(
        'no_commits',
        'This repository has no commits yet.',
        'Create an initial commit on the delivery branch, then bind.'
      );
    }
    return fail(
      'detached_head',
      'HEAD is detached; the execution context must be a branch.',
      'Check out the delivery branch, then rerun the command.'
    );
  }

  if (facts.isLinkedWorktree === null) {
    return fail(
      'git_unavailable',
      'Could not determine whether this checkout is a linked worktree.',
      'Verify git is functional in this checkout and rerun.'
    );
  }

  if (facts.isLinkedWorktree) {
    if (!facts.worktreeLabel) {
      return fail(
        'git_unavailable',
        "Could not determine this worktree's label.",
        'Verify git is functional in this checkout and rerun.'
      );
    }
    return ok({ kind: 'worktree', label: facts.worktreeLabel, branch: facts.branch });
  }

  return ok({ kind: 'branch', branch: facts.branch });
}

export function deriveBindingState(binding: DeliveryBinding): 'draft' | 'bound' {
  return binding.issues.length > 0 && binding.pr !== undefined ? 'bound' : 'draft';
}

/**
 * #351: the status-level lifecycle state, layering the local
 * merged-history signal over record completeness. A record the index
 * tracks while the live branch differs from the recorded context is the
 * local signature of a merged delivery riding this trunk — the binding
 * commit only reaches a branch through a merge. Offline status reports
 * it as a candidate for completed history, never `bound`; `specgit
 * finish` (forge-backed) upgrades the candidate to a verdict.
 */
export function deriveLifecycleState(
  binding: DeliveryBinding,
  facts: GitFacts,
  recordTracked: boolean
): 'draft' | 'bound' | 'historical-candidate' {
  if (deriveBindingState(binding) !== 'bound') {
    return deriveBindingState(binding);
  }
  if (recordTracked && facts.branch !== null && facts.branch !== binding.context.branch) {
    return 'historical-candidate';
  }
  return 'bound';
}

function failure(code: string, message: string, extra: { detail?: unknown; fix?: string } = {}): GateFailure {
  return {
    code: code as GateFailure['code'],
    message,
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.fix !== undefined ? { fix: extra.fix } : {}),
  };
}

export function recordGate(record: Evidence<DeliveryBinding>): GateResult {
  if (record.ok) {
    return { id: 'record', status: 'pass', failures: [] };
  }
  return {
    id: 'record',
    status: 'fail',
    failures: [
      failure(record.code, record.message, record.fix !== undefined ? { fix: record.fix } : {}),
    ],
  };
}

export function policyGate(policy: Evidence<Policy>): GateResult {
  if (policy.ok) {
    return { id: 'policy', status: 'pass', failures: [] };
  }
  return {
    id: 'policy',
    status: 'fail',
    failures: [
      failure(policy.code, policy.message, policy.fix !== undefined ? { fix: policy.fix } : {}),
    ],
  };
}

export function completenessGate(binding: DeliveryBinding): GateResult {
  const failures: GateFailure[] = [];
  if (binding.issues.length === 0) {
    failures.push(
      failure('issues_empty', 'No GitHub issues are bound.', {
        fix: 'Bind at least one GitHub issue: specgit bind --issue <n>.',
      })
    );
  }
  if (binding.pr === undefined) {
    failures.push(
      failure('pr_missing', 'No pull request is bound.', {
        fix: 'Bind the pull request: specgit bind --pr <number-or-url>.',
      })
    );
  }
  return {
    id: 'completeness',
    status: failures.length > 0 ? 'fail' : 'pass',
    failures,
  };
}

export function contextGate(binding: DeliveryBinding, facts: GitFacts): GateResult {
  if (!facts.gitAvailable) {
    return {
      id: 'context',
      status: 'fail',
      failures: [
        failure('git_unavailable', 'The git executable could not be spawned.', {
          fix: 'Install git and ensure it is on PATH.',
        }),
      ],
    };
  }
  if (facts.branch === null) {
    return {
      id: 'context',
      status: 'fail',
      failures: [
        failure(
          facts.headSha === null ? 'no_commits' : 'detached_head',
          facts.headSha === null
            ? 'This repository has no commits yet.'
            : 'HEAD is detached; the execution context must be a branch.'
        ),
      ],
    };
  }
  const { context } = binding;
  if (context.branch !== facts.branch) {
    return {
      id: 'context',
      status: 'fail',
      failures: [
        failure('branch_mismatch', `Live branch '${facts.branch}' does not match the record.`, {
          detail: { expected: context.branch, actual: facts.branch },
          fix: `Check out '${context.branch}' or rebind from the current branch.`,
        }),
      ],
    };
  }
  if (context.kind === 'worktree') {
    const entry = facts.worktrees.find((candidate) => candidate.label === context.label);
    const inWorktree =
      facts.isLinkedWorktree === true &&
      facts.worktreeLabel === context.label &&
      entry !== undefined &&
      entry.branch === context.branch;
    if (!inWorktree) {
      return {
        id: 'context',
        status: 'fail',
        failures: [
          failure('worktree_mismatch', 'The live checkout does not match the recorded worktree.', {
            detail: { label: context.label, branch: context.branch },
            fix: 'Run this command from the worktree checkout named in the record.',
          }),
        ],
      };
    }
  }
  return { id: 'context', status: 'pass', failures: [] };
}

export async function originGate(
  facts: GitFacts,
  parseRepoRef: (originUrl: string) => Evidence<RepoRef> | Promise<Evidence<RepoRef>>
): Promise<{ gate: GateResult; repo: string | null }> {
  if (!facts.originUrl) {
    return {
      gate: {
        id: 'origin',
        status: 'fail',
        failures: [
          failure('no_origin', 'No origin remote is configured.', {
            fix: 'Add a GitHub origin: git remote add origin <url>.',
          }),
        ],
      },
      repo: null,
    };
  }
  const parsed = await parseRepoRef(facts.originUrl);
  if (!parsed.ok) {
    return {
      gate: {
        id: 'origin',
        status: 'fail',
        failures: [
          failure(parsed.code, parsed.message, {
            detail: { origin: facts.originUrl },
            ...(parsed.fix !== undefined ? { fix: parsed.fix } : {}),
          }),
        ],
      },
      repo: null,
    };
  }
  return {
    gate: { id: 'origin', status: 'pass', failures: [] },
    repo: `${parsed.value.owner}/${parsed.value.repo}`,
  };
}
