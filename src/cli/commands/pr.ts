/**
 * `specgit pr [<ref>]` — repair the PR binding of the current delivery.
 *
 * Without arguments: auto-discover the open pull request whose head is
 * the record's branch. Exactly one candidate binds it; zero fails with
 * a fix; several refuse and list. With an explicit number or URL the PR
 * binds directly without contacting GitHub.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import { CODE_INFO } from '../../acceptance/codes.js';
import { deriveBindingState } from '../gates.js';
import { errorDiagnostic, humanBuilder, issueList, type PrOutcome } from '../output.js';
import { coercePrRef } from '../refs.js';
import { catalogFor, commandLanguage } from '../language.js';
import { carryRecordToBranch } from './bootstrap.js';
import type { CommandContext, DeliveryBinding } from '../types.js';

export interface PrOptions {
  ref?: string;
  json?: boolean;
}

function bindPr(record: DeliveryBinding, pr: number | string): DeliveryBinding {
  return { ...record, pr };
}

export async function runPr(options: PrOptions, ctx: CommandContext): Promise<PrOutcome> {
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

  const language = await commandLanguage(ctx, root);
  const { human } = catalogFor(language);

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
  const facts = await ctx.git.facts(root);

  if (options.ref !== undefined) {
    record = bindPr(record, coercePrRef(options.ref));
  } else {
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
            { fix: CODE_INFO.pr_not_found.fix }
          ),
        ],
        human: humanBuilder().line(`No open pull request has head branch '${head}'.`).build(),
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
        human: humanBuilder()
          .line(`Multiple open pull requests have head branch '${head}':`)
          .line(listing)
          .line('Bind one explicitly: specgit pr <number>.')
          .build(),
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

  // #299 carrying commit: a local-only repair forks the local and CI
  // verdicts — the PR head still reads the stale record. On the delivery
  // branch, force-carry the repaired record (commit + push, idempotent,
  // resumable on failure). Off-branch, say so instead of silently
  // skipping.
  const warnings: PrOutcome['warnings'] = [];
  if (facts.branch === record.context.branch) {
    const carry = await carryRecordToBranch(ctx, root, record);
    if (!carry.ok) {
      return {
        exit: EXIT_UNKNOWN,
        state: deriveBindingState(record),
        record: {
          version: record.version,
          delivery: record.delivery,
          context: record.context,
          issues: record.issues,
          pr: record.pr,
        },
        errors: [
          errorDiagnostic(carry.code, carry.message, carry.fix ? { fix: carry.fix } : {}),
        ],
        human: humanBuilder()
          .line(human.prBound(record.pr as number | string, record.delivery))
          .line(human.prIssues(issueList(record.issues)))
          .build(),
      };
    }
    if ('pushFailed' in carry) {
      warnings.push({
        severity: 'warning',
        code: 'record_carry_push_failed',
        message: `The repaired record was committed locally but not pushed: ${carry.pushMessage}`,
        fix: 'Push the delivery branch (git push) so the CI verdict on the PR head reads the same record; until then the local and CI verdicts can disagree.',
      });
    }
  } else {
    warnings.push({
      severity: 'warning',
      code: 'record_carry_skipped',
      message: `The repaired record was not carried into git: the current branch '${facts.branch ?? '(detached)'}' is not the delivery branch '${record.context.branch}'.`,
      fix: 'Re-run this repair on the delivery branch, or commit and push the record there manually (git add -f .specgit.yaml) so the CI verdict reads the same record.',
    });
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
    ...(warnings.length > 0 ? { warnings } : {}),
    human: humanBuilder()
      .line(human.prBound(record.pr as number | string, record.delivery))
      .line(human.prIssues(issueList(record.issues)))
      .build(),
  };
}
