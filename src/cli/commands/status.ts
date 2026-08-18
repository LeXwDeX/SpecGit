/**
 * `specgit status` — local evidence only (G1-G5), zero network.
 *
 * Reports the record, the derived binding state, the live execution
 * context, upstream drift, and origin. The GitHub provider is never
 * consulted; spec/task artifacts are not inputs — only the record, the
 * policy, and live git facts.
 *
 * Exit codes: 0 the status was computed; 2 usage; 3 fail-closed (not a git
 * repo, git unavailable, or the record is missing/invalid).
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import {
  completenessGate,
  contextGate,
  deriveBindingState,
  originGate,
  policyGate,
  recordGate,
} from '../gates.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import type { BindingState, CommandContext, GateResult } from '../types.js';

export interface StatusOptions {
  json?: boolean;
}

export async function runStatus(
  _options: StatusOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const [recordEv, policyEv, facts] = await Promise.all([
    ctx.record.readRecord(root),
    ctx.record.readPolicy(root),
    ctx.git.facts(root),
  ]);

  if (!recordEv.ok) {
    const state: BindingState = recordEv.code === 'record_missing' ? 'unbound' : 'unknown';
    return {
      exit: EXIT_UNKNOWN,
      state,
      gates: [recordGate(recordEv)],
      errors: [
        errorDiagnostic(recordEv.code, recordEv.message, recordEv.fix ? { fix: recordEv.fix } : {}),
      ],
    };
  }
  const record = recordEv.value;

  const gates: GateResult[] = [
    recordGate(recordEv),
    policyGate(policyEv),
    completenessGate(record),
    contextGate(record, facts),
  ];
  const origin = originGate(facts, ctx.parseRepoRef);
  gates.push(origin.gate);

  const state = deriveBindingState(record);
  const evidence: Record<string, unknown> = {
    root,
    repo: origin.repo,
    delivery: record.delivery,
    context: record.context,
    branch: facts.branch,
    issues: record.issues,
    pr: record.pr,
    dirty: facts.dirty,
    drift: facts.upstreamDrift,
  };

  const human = [
    `Delivery: ${record.delivery} (${state})`,
    `Context: ${
      record.context.kind === 'worktree'
        ? `worktree ${record.context.label} on ${record.context.branch}`
        : `branch ${record.context.branch}`
    }`,
    `Issues: ${record.issues.length > 0 ? record.issues.map((n) => `#${n}`).join(', ') : '(none)'}`,
    `PR: ${record.pr !== undefined ? record.pr : '(none)'}`,
    `Repository: ${origin.repo ?? '(unresolved)'}`,
    `Live branch: ${facts.branch ?? '(detached)'}`,
    ...gates.flatMap((gate) =>
      gate.failures.map(
        (failure) =>
          `Gate ${gate.id}: ${failure.code}${failure.fix ? ` — ${failure.fix}` : ''}`
      )
    ),
  ];

  return { exit: EXIT_SUCCESS, state, gates, evidence, human };
}
