/**
 * `specgit unbind` — deletes `.specgit.yaml` from the repository root.
 *
 * The abandon/reset/uninstall tool (#351): abandoning a delivery,
 * resetting a checkout, or removing SpecGit. It is NOT the post-merge
 * step — after a merge the record is completed history and the next
 * `specgit issue` replaces it atomically.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, humanBuilder, type UnbindOutcome } from '../output.js';
import { RECORD_FILENAME, type CommandContext } from '../types.js';
import { catalogFor, commandLanguage } from '../language.js';

export interface UnbindOptions {
  yes?: boolean;
  json?: boolean;
}

export async function runUnbind(
  options: UnbindOptions,
  ctx: CommandContext
): Promise<UnbindOutcome> {
  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const language = await commandLanguage(ctx, root);
  const { human } = catalogFor(language);

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

  // #298 merged-delivery lifecycle: after a delivery merges, the binding
  // commit has made the record a TRACKED file — deleting the working-tree
  // copy leaves a deletion residue in every later commit's view. Probe
  // before deleting (the file is gone afterwards) and warn; the probe is
  // advisory, never a block.
  const trackedEv = await ctx.git.trackedFiles(root, [RECORD_FILENAME]);
  const wasTracked =
    trackedEv.ok && trackedEv.value.includes(RECORD_FILENAME);

  try {
    await ctx.record.deleteRecord(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('record_delete_failed', message)],
    };
  }

  const warnings: UnbindOutcome['warnings'] = wasTracked
    ? [
        {
          severity: 'warning',
          code: 'record_deletion_tracked',
          message: `${RECORD_FILENAME} is tracked by git — deleting the working-tree copy leaves an uncommitted deletion behind.`,
          fix: 'Commit the deletion (e.g. "chore: unbind delivery") through a PR/MR to return the tree to clean; the next delivery\'s binding commit force-carries the rewritten record anyway.',
        },
      ]
    : undefined;

  return {
    exit: EXIT_SUCCESS,
    state: 'unbound',
    ...(warnings !== undefined ? { warnings } : {}),
    human: humanBuilder().line(human.unbindRemoved(RECORD_FILENAME)).build(),
  };
}
