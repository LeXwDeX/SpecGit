/**
 * `specgit init` — creates `spec_git/policy.yaml` and nothing else. The
 * generation surface of the retired product (skills/commands/instructions)
 * does not exist here.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import { POLICY_FILENAME, SPEC_GIT_DIR, type CommandContext } from '../types.js';

export interface InitOptions {
  requiredCheck?: string[];
  json?: boolean;
}

async function promptForCheckName(ctx: CommandContext): Promise<string> {
  const { input } = await import('@inquirer/prompts');
  return input({ message: 'Required check name (exact GitHub Actions check name):' });
}

export async function runInit(
  options: InitOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  let checks = (options.requiredCheck ?? []).map((value) => value.trim());

  if (checks.length === 0) {
    if (!ctx.stdinIsTTY) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(
            'required_check_required',
            'init requires at least one required check name.',
            { fix: 'Pass --required-check <name> (repeatable).' }
          ),
        ],
      };
    }
    checks = [(await promptForCheckName(ctx)).trim()];
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
    ],
  };
}
