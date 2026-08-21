/**
 * `specgit bind` — writes/updates `.specgit.yaml` at the repository root.
 *
 * The execution context is auto-resolved from live git; there are no
 * `--branch`/`--worktree` flags. `issues` merge with dedupe keeping
 * first-seen order; `pr` replaces on flag presence and stays untouched
 * otherwise; `delivery` is set on the first bind only. No network: the
 * GitHub provider is never consulted.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { deriveBindingState, resolveExecutionContext } from '../gates.js';
import { errorDiagnostic, type BindOutcome } from '../output.js';
import { coerceIssueRef, coercePrRef } from '../refs.js';
import { catalogFor, commandLanguage } from '../language.js';
import { isKebabId, KEBAB_ID_FIX, mergeIssueNumbers } from '../../record/schema.js';
import type { CommandContext, DeliveryBinding } from '../types.js';

export interface BindOptions {
  issue?: string[];
  pr?: string;
  delivery?: string;
  json?: boolean;
}

export async function runBind(
  options: BindOptions,
  ctx: CommandContext
): Promise<BindOutcome> {
  const hasBindingFlag =
    (options.issue !== undefined && options.issue.length > 0) ||
    options.pr !== undefined ||
    options.delivery !== undefined;
  if (!hasBindingFlag) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic('nothing_to_bind', 'Nothing to bind.', {
          fix: 'Pass at least one of --issue <n>, --pr <ref>, or --delivery <kebab-id>.',
        }),
      ],
    };
  }

  if (options.delivery !== undefined && !isKebabId(options.delivery)) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'delivery_invalid',
          `Delivery id '${options.delivery}' is not a valid delivery id.`,
          { fix: KEBAB_ID_FIX }
        ),
      ],
    };
  }

  const incomingIssues: number[] = [];
  for (const raw of options.issue ?? []) {
    const coerced = coerceIssueRef(raw);
    if (!coerced.ok) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(coerced.code, coerced.message, coerced.fix ? { fix: coerced.fix } : {}),
        ],
      };
    }
    incomingIssues.push(coerced.value);
  }

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const language = await commandLanguage(ctx, root);
  const { human: text } = catalogFor(language);

  const facts = await ctx.git.facts(root);
  const contextEv = resolveExecutionContext(facts);
  if (!contextEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(contextEv.code, contextEv.message, contextEv.fix ? { fix: contextEv.fix } : {}),
      ],
    };
  }

  const existing = await ctx.record.readRecord(root);
  if (!existing.ok && existing.code !== 'record_missing') {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(existing.code, existing.message, existing.fix ? { fix: existing.fix } : {}),
      ],
    };
  }

  const existingRecord = existing.ok ? existing.value : undefined;
  if (existingRecord && options.delivery !== undefined) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'delivery_locked',
          `Delivery '${existingRecord.delivery}' was set on the first bind and cannot change.`,
          { fix: 'Run "specgit unbind --yes" to remove the record, then bind again.' }
        ),
      ],
    };
  }
  if (!existingRecord && options.delivery === undefined) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic('delivery_required', 'The first bind requires a delivery id.', {
          fix: 'Pass --delivery <kebab-id>, e.g. --delivery add-login-flow.',
        }),
      ],
    };
  }

  const mergedIssues = mergeIssueNumbers(existingRecord?.issues ?? [], incomingIssues);

  const pr =
    options.pr !== undefined
      ? coercePrRef(options.pr)
      : existingRecord?.pr;

  const record: DeliveryBinding = {
    ...(existingRecord ?? {}),
    version: 1,
    delivery: existingRecord?.delivery ?? (options.delivery as string),
    context: contextEv.value,
    issues: mergedIssues,
    ...(pr !== undefined ? { pr } : {}),
  };

  try {
    await ctx.record.writeRecord(root, record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('record_write_failed', message)],
    };
  }

  const summary: Record<string, unknown> = {
    version: record.version,
    delivery: record.delivery,
    context: record.context,
    issues: record.issues,
    ...(record.pr !== undefined ? { pr: record.pr } : {}),
  };

  const contextLine =
    record.context.kind === 'worktree'
      ? text.bindContextWorktree(record.context.label, record.context.branch)
      : text.bindContextBranch(record.context.branch);

  return {
    exit: EXIT_SUCCESS,
    state: deriveBindingState(record),
    record: summary,
    human: [
      text.bindHeader(record.delivery),
      `  ${contextLine}`,
      ...(record.issues.length > 0 ? [text.bindIssues(record.issues.map((n) => `#${n}`).join(', '))] : []),
      ...(record.pr !== undefined ? [text.bindPr(record.pr)] : []),
    ],
  };
}
