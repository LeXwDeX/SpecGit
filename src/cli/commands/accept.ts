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
  renderNextActionsHuman,
  verdictFailureLine,
  type AcceptOutcome,
  type NextAction,
} from '../output.js';
import { forgeMergeCommand } from '../forge-links.js';
import { catalogFor, resolveLanguage } from '../language.js';
import type { CommandContext, Evidence, RepoRef } from '../types.js';

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

  const evaluated = await ctx.evaluate({ root, record, policy, git: ctx.git, gh: ctx.gh });
  const automated = policy.ok && policy.value.automation?.merge === true;
  const verdict = automated && evaluated.state === 'completed'
    ? {
        ...evaluated,
        warnings: evaluated.warnings.map((warning) => warning.code === 'record_of_merged_delivery'
          ? { ...warning, fix: 'Complete the configured issue-closure step before starting the next delivery.' }
          : warning),
      }
    : evaluated;

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
    gate.failures.map((failure) => verdictFailureLine(gate.id, failure.code))
  );

  // #361: an accepted verdict hands off the next step — the merge for a
  // live delivery (auto-merge per policy), the next bootstrap for
  // completed history. Rejected/unknown say nothing: their repairs ride
  // the diagnostics, rendered exactly once (#362). The dialect must be
  // PROVEN, never guessed: a platform that cannot be resolved gets no
  // merge command (advisory hand-offs fail closed, like everything else).
  const reasonFor = text.finishHandoffReasons();
  let nextActions: NextAction[] | undefined;
  if (verdict.classification === 'accepted') {
    if (automated) {
      nextActions = [{
        code: 'delivery_merge', command: 'specgit pr --merge', reason: text.automationHandoffReason(),
      }];
    } else if (verdict.state === 'completed') {
      nextActions = [
        {
          code: 'next_delivery',
          command: 'specgit issue "<type>: <title>"',
          reason: reasonFor['next_delivery'] ?? '',
        },
      ];
    } else if (verdict.evidence.pr !== null) {
      const facts = await ctx.git.facts(root.value).catch(() => null);
      let platform: RepoRef['platform'] | null = null;
      if (facts?.originUrl) {
        const parsed = await Promise.resolve(ctx.parseRepoRef(facts.originUrl));
        if (parsed.ok) {
          platform = parsed.value.platform;
        }
      }
      if (platform !== null) {
        nextActions = [
          {
            code: 'delivery_merge',
            command: forgeMergeCommand(platform, verdict.evidence.pr),
            reason: reasonFor['delivery_merge'] ?? '',
          },
        ];
      }
    }
  }

  return {
    exit: verdict.exitCode,
    state: verdict.state,
    verdict,
    warnings: verdict.warnings.length > 0 ? verdict.warnings : undefined,
    ...(nextActions !== undefined ? { nextActions } : {}),
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
    human: humanBuilder()
      .line(headline)
      .append(failureLines)
      // Completed history: the record_of_merged_delivery warning's Next
      // line already hands off the next delivery — rendering the same
      // hand-off twice would break the exactly-once intent (#362); the
      // envelope keeps the structured action for machines.
      .append(
        verdict.state === 'completed' && !automated
          ? []
          : renderNextActionsHuman(text.nextHeadline(), nextActions ?? [])
      )
      .build(),
  };
}
