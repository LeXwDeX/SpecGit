/**
 * `specgit pr [<ref>]` — repair the PR binding of the current delivery.
 *
 * Without arguments: auto-discover the open pull request whose head is
 * the record's branch. Exactly one candidate binds it; zero fails with
 * a fix; several refuse and list. With an explicit number or URL the PR
 * binds directly without contacting GitHub.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import { deriveBindingState } from '../gates.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import { coercePrRef } from '../refs.js';
import type { CommandContext, DeliveryBinding } from '../types.js';

export interface PrOptions {
  ref?: string;
  json?: boolean;
}

function bindPr(record: DeliveryBinding, pr: number | string): DeliveryBinding {
  return { ...record, pr };
}

export async function runPr(options: PrOptions, ctx: CommandContext): Promise<CommandOutcome> {
  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {}),
      ],
    };
  }
  const root = rootEv.value;

  const existing = await ctx.record.readRecord(root);
  if (!existing.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(existing.code, existing.message, {
          fix: 'Run "specgit issue <title-or-number>..." to bootstrap the delivery first.',
        }),
      ],
    };
  }

  let record = existing.value;

  if (options.ref !== undefined) {
    record = bindPr(record, coercePrRef(options.ref));
  } else {
    const facts = await ctx.git.facts(root);
    if (!facts.originUrl) {
      return {
        exit: EXIT_UNKNOWN,
        errors: [
          errorDiagnostic('no_origin', 'No origin remote is configured.', {
            fix: 'Add a GitHub origin: git remote add origin <url>.',
          }),
        ],
      };
    }
    const repoEv = await ctx.parseRepoRef(facts.originUrl);
    if (!repoEv.ok) {
      return {
        exit: EXIT_UNKNOWN,
        errors: [
          errorDiagnostic(repoEv.code, repoEv.message, repoEv.fix ? { fix: repoEv.fix } : {}),
        ],
      };
    }

    const head = record.context.branch;
    const listEv = await ctx.gh.listOpenPrsByHead(repoEv.value, head);
    if (!listEv.ok) {
      return {
        exit: EXIT_UNKNOWN,
        errors: [
          errorDiagnostic(listEv.code, listEv.message, listEv.fix ? { fix: listEv.fix } : {}),
        ],
      };
    }

    const candidates = listEv.value;
    if (candidates.length === 0) {
      return {
        exit: EXIT_UNKNOWN,
        errors: [
          errorDiagnostic(
            'pr_not_found',
            `No open pull request has head branch '${head}'.`,
            {
              fix: 'Push the branch and open a draft PR (re-running "specgit issue" resumes the bootstrap), then rerun "specgit pr".',
            }
          ),
        ],
        human: [`No open pull request has head branch '${head}'.`],
      };
    }
    if (candidates.length > 1) {
      const listing = candidates.map((pr) => `  #${pr.number} ${pr.title}`).join('\n');
      return {
        exit: EXIT_UNKNOWN,
        errors: [
          errorDiagnostic(
            'pr_ambiguous',
            `Multiple open pull requests have head branch '${head}':\n${listing}`,
            { fix: 'Bind one explicitly: specgit pr <number>.' }
          ),
        ],
        human: [
          `Multiple open pull requests have head branch '${head}':`,
          listing,
          'Bind one explicitly: specgit pr <number>.',
        ],
      };
    }
    record = bindPr(record, candidates[0].number);
  }

  try {
    await ctx.record.writeRecord(root, record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('record_write_failed', message)],
    };
  }

  return {
    exit: EXIT_SUCCESS,
    state: deriveBindingState(record),
    record: {
      version: record.version,
      delivery: record.delivery,
      context: record.context,
      issues: record.issues,
      pr: record.pr,
    },
    human: [
      `Bound PR #${record.pr} to delivery '${record.delivery}':`,
      `  Issues: ${record.issues.map((n) => `#${n}`).join(', ')}`,
    ],
  };
}
