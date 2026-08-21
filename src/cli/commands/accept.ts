/**
 * `specgit accept` — full eleven-gate evaluation via the acceptance evaluator
 * (`src/acceptance/**`). States are derived per invocation and never
 * persisted. Spec/task artifacts are not inputs anywhere on this path —
 * only the record, the policy, live git facts, and GitHub provider facts.
 *
 * Exit codes come from the evaluator verdict: 0 accepted · 1 rejected with
 * complete evidence · 3 cannot determine (fail-closed). Usage errors exit
 * 2 before evaluation.
 */

import { EXIT_UNKNOWN } from '../exit-codes.js';
import {
  errorDiagnostic,
  humanBuilder,
  verdictFailureLine,
  type AcceptOutcome,
} from '../output.js';
import { catalogFor, resolveLanguage } from '../language.js';
import type { CommandContext, Evidence } from '../types.js';

export interface AcceptOptions {
  json?: boolean;
}

export async function runAccept(
  _options: AcceptOptions,
  ctx: CommandContext
): Promise<AcceptOutcome> {
  const root: Evidence<string> = await ctx.discoverRoot(ctx.cwd);
  if (!root.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(root.code, root.message, root.fix ? { fix: root.fix } : {})],
    };
  }

  const [record, policy] = await Promise.all([
    ctx.record.readRecord(root.value),
    ctx.record.readPolicy(root.value),
  ]);

  const verdict = await ctx.evaluate({ root, record, policy, git: ctx.git, gh: ctx.gh });

  // Success-path headline follows the policy language (#118); the
  // per-gate failure lines are diagnostic evidence and stay English.
  const { human: text } = catalogFor(resolveLanguage(policy.ok ? policy.value : null));
  const headline =
    verdict.classification === 'accepted'
      ? text.finishAccepted(verdict.evidence.delivery ?? '(unknown)', verdict.evidence.pr)
      : verdict.classification === 'rejected'
        ? text.finishRejected(verdict.evidence.delivery ?? '(unknown)')
        : text.finishUnknown(verdict.evidence.delivery ?? null);

  const failureLines = verdict.gates.flatMap((gate) =>
    gate.failures.map((failure) => verdictFailureLine(gate.id, failure.code, failure.fix))
  );

  return {
    exit: verdict.exitCode,
    state: verdict.state,
    verdict,
    warnings: verdict.warnings.length > 0 ? verdict.warnings : undefined,
    errors:
      verdict.exitCode === 0
        ? undefined
        : verdict.gates
            .filter((gate) => gate.status === 'fail')
            .flatMap((gate) =>
              gate.failures.map((failure) =>
                errorDiagnostic(failure.code, failure.message, failure.fix ? { fix: failure.fix } : {})
              )
            ),
    human: humanBuilder().line(headline).append(failureLines).build(),
  };
}
