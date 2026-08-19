/**
 * `specgit init` — creates `spec_git/policy.yaml` and generates the
 * delivery harness: the CI acceptance workflow, the opencode guard hooks,
 * and the managed prompt block in the agent instruction files. Harness
 * generation is idempotent; the policy itself is write-once and never
 * overwritten.
 *
 * With no arguments, required-check names are auto-detected from
 * `.github/workflows/*.{yml,yaml}` (job `name:`, falling back to the job
 * id; the generated SpecGit Acceptance job is excluded to avoid
 * self-reference). When no workflow exists, the policy falls back to the
 * GitHub aggregate check name "All checks passed".
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { writeHarnessAssets, type HarnessWriteResult } from '../harness-assets.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import { POLICY_FILENAME, SPEC_GIT_DIR, type CommandContext } from '../types.js';
import { detectRequiredChecks } from '../detect-checks.js';

export interface InitOptions {
  requiredCheck?: string[];
  json?: boolean;
}

const FALLBACK_CHECK = 'All checks passed';

export async function runInit(
  options: InitOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  let checks = (options.requiredCheck ?? []).map((value) => value.trim());

  if (checks.length === 0) {
    // No arguments: auto-detect from the repo's CI workflows; when none
    // exist, the GitHub aggregate check is the safe fail-closed fallback.
    const detected = await detectRequiredChecks(ctx.cwd);
    checks = detected.length > 0 ? detected : [FALLBACK_CHECK];
  }

  const invalid = checks.find((value) => value.length === 0);
  if (invalid !== undefined) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'required_check_invalid',
          'Required check names must be non-empty.',
          { fix: 'Pass the exact check name, e.g. --required-check "All checks passed".' }
        ),
      ],
    };
  }

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  let harness: HarnessWriteResult;
  try {
    harness = await writeHarnessAssets(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('harness_write_failed', message)],
    };
  }

  const existingPolicy = await ctx.record.readPolicy(root);
  if (existingPolicy.ok) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'policy_exists',
          `${SPEC_GIT_DIR}/${POLICY_FILENAME} already exists in this repository.`,
          { fix: `Edit ${SPEC_GIT_DIR}/${POLICY_FILENAME} directly to change required checks.` }
        ),
      ],
    };
  }
  if (existingPolicy.code !== 'policy_missing') {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(existingPolicy.code, existingPolicy.message, existingPolicy.fix ? { fix: existingPolicy.fix } : {}),
      ],
    };
  }

  const policy = { version: 1 as const, required_checks: checks };
  try {
    await ctx.record.writePolicy(root, policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('policy_write_failed', message)],
    };
  }

  return {
    exit: EXIT_SUCCESS,
    policy,
    human: [
      `Created ${SPEC_GIT_DIR}/${POLICY_FILENAME}`,
      `Required checks (${checks.length}):`,
      ...checks.map((name) => `  - ${name}`),
      `Created ${harness.workflow}`,
      ...harness.hooks.map((hookPath) => `Created ${hookPath}`),
      ...(harness.gitHook ? [`Installed git pre-push guard (${harness.gitHook})`] : []),
      ...harness.prompts.map((filename) => `Managed block refreshed in ${filename}`),
    ],
  };
}
