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
import { bindingContextMismatch } from '../record/context-match.js';
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
 * Membership in a tracked-file probe (`git ls-files`), degrading to false
 * when the probe itself failed — every #298/#351 caller treats the probe
 * as advisory, so a failed probe must read as "not tracked".
 */
export function trackedIncludes(paths: Evidence<string[]>, path: string): boolean {
  return paths.ok && paths.value.includes(path);
}

/**
 * #351: the status-level lifecycle state, layering the local
 * merged-history signal over record completeness. A record the index
 * tracks while the live branch differs from the recorded context is the
 * local signature of merged delivery history riding this trunk —
 * normally the binding commit reached this branch through the adoption
 * or delivery merge. Local git cannot PROVE it (a branch cut from a
 * still-open delivery branch carries the tracked record too, and
 * whether the PR merged is forge-side fact), so offline status reports a
 * CANDIDATE, never `bound` and never `completed`; `specgit finish`
 * (forge-backed) upgrades the candidate to a verdict.
 */
export function deriveLifecycleState(
  binding: DeliveryBinding,
  facts: GitFacts,
  recordTracked: boolean
): 'draft' | 'bound' | 'historical-candidate' {
  const completeness = deriveBindingState(binding);
  if (completeness !== 'bound') {
    return completeness;
  }
  // A detached HEAD (branch null) over a tracked record naming a branch
  // is the same historical signature — `null !== context.branch` holds.
  if (recordTracked && facts.branch !== binding.context.branch) {
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
      failure('issues_empty', 'No forge issues are bound.', {
        fix: 'Bind at least one issue from the current forge: specgit bind --issue <n>.',
      })
    );
  }
  if (binding.pr === undefined) {
    failures.push(
      failure('pr_missing', 'No pull or merge request is bound.', {
        fix: 'Bind the delivery request: specgit bind --pr <ref> (numeric PR/MR ID, or a full GitHub PR URL).',
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
  const mismatch = bindingContextMismatch(context, facts);
  if (mismatch === 'branch_mismatch') {
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
  if (mismatch === 'worktree_mismatch' && context.kind === 'worktree') {
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
            fix: 'Add an origin for a supported forge: git remote add origin <url>.',
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
