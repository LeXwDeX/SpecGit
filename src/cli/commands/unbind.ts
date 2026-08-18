/**
 * `specgit unbind` — deletes `.specgit.yaml` from the repository root.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import { RECORD_FILENAME, type CommandContext } from '../types.js';

export interface UnbindOptions {
  yes?: boolean;
  json?: boolean;
}

async function promptForConfirmation(ctx: CommandContext): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message: `Delete ${RECORD_FILENAME}?`, default: false });
}

export async function runUnbind(
  options: UnbindOptions,
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

  const existing = await ctx.record.readRecord(root);
  if (!existing.ok) {
    if (existing.code === 'record_missing') {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(
            'record_missing',
            `Nothing to unbind: no ${RECORD_FILENAME} at the repository root.`,
            { target: 'record' }
          ),
        ],
      };
    }
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(existing.code, existing.message, existing.fix ? { fix: existing.fix } : {}),
      ],
    };
  }

  if (!options.yes) {
    if (!ctx.stdinIsTTY) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(
            'confirmation_required',
            'Unbind deletes the delivery binding record.',
            { fix: `Rerun with --yes to delete ${RECORD_FILENAME}.` }
          ),
        ],
      };
    }
    if (!(await promptForConfirmation(ctx))) {
      return { exit: EXIT_SUCCESS, human: ['Unbind aborted; record kept.'] };
    }
  }

  try {
    await ctx.record.deleteRecord(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('record_delete_failed', message)],
    };
  }

  return {
    exit: EXIT_SUCCESS,
    state: 'unbound',
    human: [`Removed ${RECORD_FILENAME}.`],
  };
}
