/**
 * Existing-repository upgrade preflight for `specgit init` (#457).
 *
 * The decision is read-only until a human explicitly answers yes. Drift is
 * derived from the same desired-state inspector used by `status`; optional
 * setup surfaces that were never installed remain absent and do not trigger
 * a question. Unknown inspection evidence likewise never authorizes writes.
 */

import { inspectGeneratedAssets } from '../asset-drift.js';
import { EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type InitOutcome, type SetupOutcome } from '../output.js';
import type { Evidence } from '../../kernel/evidence.js';
import type { CommandContext, Policy } from '../types.js';
import type { InitInteraction, InitOptions } from './init-validation.js';
import { terminalYesNoPrompt } from './init-validation.js';

export type GuidedUpgradeDecision =
  | { upgrade: false }
  | { upgrade: true; preserveIgnoreOptOut: boolean }
  | { outcome: InitOutcome };

const UPGRADEABLE_STATES = new Set(['stale', 'missing']);

/**
 * The convenience prompt is deliberately limited to option-free init. An
 * upgrade question authorizes only the two commands it names; configuration
 * flags must continue through the explicit --force path where their effects
 * are visible in the invocation itself. Commander supplies an empty default
 * array for --required-check, so that one default still counts as plain.
 */
function isPlainInit(options: InitOptions): boolean {
  return (
    (options.requiredCheck?.length ?? 0) === 0 &&
    options.detect !== false &&
    options.protect === undefined &&
    options.gitlabHost === undefined &&
    options.language === undefined &&
    options.configureRules !== true &&
    options.titleCheck === undefined &&
    options.labelCheck === undefined &&
    options.allowedLabel === undefined &&
    options.repairLabel === undefined &&
    options.ignore !== false &&
    options.automation === undefined &&
    options.mergeTarget === undefined
  );
}

export async function guidedUpgradeDecision(args: {
  root: string;
  ctx: CommandContext;
  options: InitOptions;
  policy: Evidence<Policy>;
  interaction: InitInteraction;
}): Promise<GuidedUpgradeDecision> {
  const { root, ctx, options, policy, interaction } = args;
  if (!policy.ok || options.force || !isPlainInit(options)) return { upgrade: false };
  // Machine use retains the original cheap, deterministic policy_exists
  // path: no drift probes, no prompt, and certainly no writes.
  if (!ctx.stdinIsTTY || options.json) return { upgrade: false };

  let report;
  try {
    const facts = await ctx.git.facts(root);
    report = await inspectGeneratedAssets({ root, ctx, policy, facts });
  } catch {
    // A prompt may authorize writes only from a complete positive drift
    // claim. The ordinary policy_exists result carries the explicit repair.
    return { upgrade: false };
  }
  const conflicts = report.surfaces.flatMap((surface) =>
    surface.assets.filter((asset) => asset.state === 'conflict')
  );
  if (conflicts.length > 0) {
    return {
      outcome: {
        exit: EXIT_UNKNOWN,
        errors: conflicts.map((asset) =>
          errorDiagnostic(
            'asset_conflict',
            `${asset.path} is not provably SpecGit-owned, so the guided upgrade cannot safely replace or remove it.`,
            {
              target: asset.path,
              fix: `If this is user content, move it outside the managed path; if it is a reviewed leftover SpecGit artifact, remove it, then re-run "specgit init".`,
            }
          )
        ),
      },
    };
  }
  const outdated = report.complete && report.surfaces.some(
    (surface) => surface.state !== 'absent' && UPGRADEABLE_STATES.has(surface.state)
  );
  if (!outdated) return { upgrade: false };

  const language = policy.value.language ?? 'en';
  const preserveIgnoreOptOut = report.skipped.includes('ignore_committed_authoritative');
  const forceCommand = `specgit init --force --no-protect${preserveIgnoreOptOut ? ' --no-ignore' : ''}`;
  const question = language === 'zh'
    ? `检测到旧版或漂移的 SpecGit 托管文件。是否立即升级？这将依次执行 ${forceCommand} 和 specgit setup --tool all。[yes/no]（默认 no）： `
    : `Outdated or drifted SpecGit-managed files were found. Upgrade now? This runs ${forceCommand}, then specgit setup --tool all. [yes/no] (default no): `;
  const response = (await (interaction.promptUpgrade ?? terminalYesNoPrompt)(question))
    ?.trim()
    .toLowerCase();
  const answer = response || 'no';
  if (answer === 'yes' || answer === 'y') {
    return {
      upgrade: true,
      preserveIgnoreOptOut,
    };
  }
  if (answer === 'no' || answer === 'n') return { upgrade: false };
  return {
    outcome: {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic('upgrade_answer_invalid', 'The managed-asset upgrade must be answered yes or no.', {
          fix: `Re-run init and answer yes or no (default no), or run "${forceCommand}" followed by "specgit setup --tool all".`,
        }),
      ],
    },
  };
}

/** Compose the two explicitly ordered writers into one truthful init result. */
export function finishGuidedUpgrade(
  initialized: InitOutcome,
  setup: SetupOutcome
): InitOutcome {
  const warnings = [...(initialized.warnings ?? []), ...(setup.warnings ?? [])];
  const human = [...(initialized.human ?? []), ...(setup.human ?? [])];
  if (setup.exit !== 0) {
    const errors = (setup.errors ?? [
      errorDiagnostic('setup_write_failed', 'The setup phase did not complete.'),
    ]).map((diagnostic) => ({
      ...diagnostic,
      fix: diagnostic.fix === undefined
        ? 'The init --force phase completed. Resolve the reported setup conflict, then run "specgit setup --tool all".'
        : `The init --force phase completed. ${diagnostic.fix}`,
    }));
    return {
      ...initialized,
      exit: setup.exit === EXIT_USAGE ? EXIT_USAGE : EXIT_UNKNOWN,
      errors,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(human.length > 0 ? { human } : {}),
    };
  }
  return {
    ...initialized,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(human.length > 0 ? { human } : {}),
  };
}
