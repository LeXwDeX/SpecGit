import type { CompletionObservation } from '../completion/types.js';
import { EXIT_REJECTED, EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from './exit-codes.js';
import { catalogFor } from './language.js';
import { humanBuilder, renderNextActionsHuman, type NextAction, type PrOutcome } from './output.js';

/** Preserve the public command envelope independently of completion decisions. */
export function presentCompletion(observation: CompletionObservation): PrOutcome {
  const { progress, classification } = observation;
  const exits = { completed: EXIT_SUCCESS, idle: EXIT_SUCCESS, rejected: EXIT_REJECTED, unknown: EXIT_UNKNOWN, disabled: EXIT_USAGE };
  const outcome: PrOutcome = {
    exit: exits[classification],
    ...(classification === 'completed' ? { state: 'completed' } : classification === 'idle' ? { state: 'bound' } :
      progress?.pr !== undefined ? { state: progress.merged ? 'closure_pending' : 'bound' } : {}),
    ...(progress ? { automation: progress } : {}),
    ...(observation.repairIssues ? { repairIssues: observation.repairIssues } : {}),
    ...(classification === 'completed' ? {} : { errors: observation.diagnostics }),
  };
  const { human } = catalogFor(observation.language);
  if (observation.recovery?.kind === 'fetch-target') {
    const nextActions: NextAction[] = [{
      code: 'merge_lineage', command: 'git fetch origin',
      reason: `Fetch and check out '${progress?.targetBranch}' containing the merge, then retry specgit pr ${observation.recovery.operation === 'close-only' ? '--close-issues' : '--merge'}.`,
    }];
    return { ...outcome, nextActions, human: renderNextActionsHuman(human.nextHeadline(), nextActions) };
  }
  if (classification !== 'completed' && !progress?.merged && observation.repairIssues?.length) {
    const nextActions: NextAction[] = [{
      code: 'bind_repairs',
      command: `specgit bind ${observation.repairIssues.map((number) => `--issue ${number}`).join(' ')} --json`,
      reason: `On this delivery's branch, preserve the PR/MR body and add ${observation.repairIssues.map((number) => `Closes #${number}`).join(', ')} before binding these repairs. Implement and verify their fixes before completion.`,
    }];
    return { ...outcome, nextActions, human: renderNextActionsHuman(human.nextHeadline(), nextActions) };
  }
  if (classification === 'completed' && progress?.pr !== undefined && progress.targetBranch !== undefined) {
    const nextActions: NextAction[] = [{
      code: 'next_delivery', command: 'specgit issue "<type>: <title>"',
      reason: human.finishHandoffReasons()['next_delivery'] ?? '',
    }];
    return { ...outcome, nextActions, human: humanBuilder()
      .line(human.automationCompleted(progress.pr, progress.targetBranch))
      .append(renderNextActionsHuman(human.nextHeadline(), nextActions)).build() };
  }
  return outcome;
}
