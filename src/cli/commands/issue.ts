/**
 * `specgit issue [<title-or-number> ...]` — the one-command delivery
 * bootstrap: create/reuse N issues (one issue = one independently
 * verifiable WHY), create the branch `<type>/<first#>-<slug>`, open a
 * draft PR whose body closes every issue, write `.specgit.yaml`, commit
 * and push. Re-runs resume: every completed step is detected from the
 * record and the live branch, so a failure between steps heals on the
 * next invocation with the same arguments.
 *
 * The CLI is non-interactive: no arguments and no record is a usage
 * error (exit 2). With a record present, no arguments is a pure resume.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { deriveBindingState, resolveExecutionContext } from '../gates.js';
import { errorDiagnostic, sanitize, type CommandOutcome } from '../output.js';
import { isKebabId, parseNumericRef, RECORD_FILENAME } from '../../record/schema.js';
import type { CommandContext, DeliveryBinding, Evidence } from '../types.js';

export interface IssueOptions {
  titles?: string[];
  json?: boolean;
}

/** Conventional-commit types accepted as the `<type>` of the branch name. */
const BRANCH_TYPES = new Set([
  'feat',
  'fix',
  'chore',
  'docs',
  'test',
  'refactor',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
]);

const CONVENTIONAL_PREFIX = /^([a-z]+):\s+(.*)$/s;

export function parseIssueTitle(title: string): { type: string; cleanTitle: string } {
  const match = CONVENTIONAL_PREFIX.exec(title.trim());
  if (match && BRANCH_TYPES.has(match[1])) {
    return { type: match[1], cleanTitle: match[2].trim() };
  }
  return { type: 'feat', cleanTitle: title.trim() };
}

/**
 * Kebab slug from the first three ASCII words of the title. A title
 * without ASCII words (e.g. non-ASCII only) yields '' and the caller
 * falls back to `issue<N>` — the branch stays typeable and valid.
 */
export function slugifyTitle(title: string): string {
  const words = title.match(/[A-Za-z0-9]+/g) ?? [];
  return words
    .slice(0, 3)
    .map((word) => word.toLowerCase())
    .join('-');
}

function issueBody(title: string): string {
  return [
    '## Why',
    title,
    '',
    '## Acceptance',
    'The delivery pull request closes this issue; `specgit finish` must exit 0.',
    '',
  ].join('\n');
}

function recordSummary(record: DeliveryBinding): Record<string, unknown> {
  return {
    version: record.version,
    delivery: record.delivery,
    context: record.context,
    issues: record.issues,
    ...(record.pr !== undefined ? { pr: record.pr } : {}),
  };
}

type FailureEvidence = Extract<Evidence<unknown>, { ok: false }>;

function passthrough(failure: FailureEvidence): CommandOutcome {
  return {
    exit: EXIT_UNKNOWN,
    errors: [
      errorDiagnostic(failure.code, failure.message, failure.fix ? { fix: failure.fix } : {}),
    ],
  };
}

export async function runIssue(
  options: IssueOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  const args = (options.titles ?? []).map((value) => value.trim());

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return passthrough(rootEv);
  }
  const root = rootEv.value;

  const facts = await ctx.git.facts(root);
  const contextEv = resolveExecutionContext(facts);
  if (!contextEv.ok) {
    return passthrough(contextEv);
  }

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
  const repoEv = ctx.parseRepoRef(facts.originUrl);
  if (!repoEv.ok) {
    return passthrough(repoEv);
  }

  const existing = await ctx.record.readRecord(root);
  if (!existing.ok && existing.code !== 'record_missing') {
    return passthrough(existing);
  }

  let record: DeliveryBinding;
  let resumed = false;
  let firstTitle: string | null = null;

  if (existing.ok) {
    // Resume: the record is the durable step marker (issues written as
    // soon as they exist; the PR appended when created).
    resumed = true;
    record = existing.value;
    if (args.length > 0) {
      if (args.length !== record.issues.length) {
        return {
          exit: EXIT_USAGE,
          errors: [
            errorDiagnostic(
              'issue_resume_drift',
              `This checkout already carries delivery '${record.delivery}' with ${record.issues.length} bound issue(s); the ${args.length} argument(s) do not match.`,
              {
                fix: 'Re-run with the original arguments (or none) to resume, or run "specgit unbind --yes" to start a new delivery.',
              }
            ),
          ],
        };
      }
      // Numeric arguments are verifiable and must be bound already. Title
      // arguments cannot be matched against numbers post-creation; the
      // count check above is their guard, and resume never creates.
      for (const arg of args) {
        const number = parseNumericRef(arg);
        if (number !== null && !record.issues.includes(number)) {
          return {
            exit: EXIT_USAGE,
            errors: [
              errorDiagnostic(
                'issue_resume_drift',
                `Argument '${sanitize(arg)}' is not among the issues bound to delivery '${record.delivery}'.`,
                {
                  fix: 'Re-run with the original arguments (or none) to resume, or run "specgit unbind --yes" to start a new delivery.',
                }
              ),
            ],
          };
        }
      }
    }
  } else {
    if (args.length === 0) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic('issue_args_required', 'specgit issue needs at least one issue.', {
            fix: 'Pass one or more quoted issue titles to create, or existing issue numbers to reuse, e.g. specgit issue "feat: add login".',
          }),
        ],
      };
    }

    const issues: number[] = [];
    for (const arg of args) {
      const reuseNumber = parseNumericRef(arg);
      if (reuseNumber !== null) {
        issues.push(reuseNumber);
        continue;
      }
      if (!arg) {
        return {
          exit: EXIT_USAGE,
          errors: [
            errorDiagnostic('issue_title_empty', 'Issue titles must not be empty.', {
              fix: 'Pass a non-empty quoted title, e.g. specgit issue "feat: add login".',
            }),
          ],
        };
      }
      const created = await ctx.gh.createIssue(repoEv.value, arg, issueBody(arg));
      if (!created.ok) {
        return passthrough(created);
      }
      issues.push(created.value.number);
      if (firstTitle === null) {
        firstTitle = arg;
      }
    }

    const firstNumber = issues[0];
    const { type, cleanTitle } = firstTitle !== null ? parseIssueTitle(firstTitle) : { type: 'feat', cleanTitle: '' };
    const slug = slugifyTitle(cleanTitle);
    const delivery = slug && isKebabId(slug) ? slug : `issue${firstNumber}`;
    const branch = `${type}/${firstNumber}-${delivery}`;

    record = {
      version: 1,
      delivery,
      context: { ...contextEv.value, branch },
      issues,
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
  }

  const target = record.context.branch;

  if (facts.branch !== target) {
    const checkout = await ctx.git.checkoutOrCreateBranch(root, target);
    if (!checkout.ok) {
      return passthrough(checkout);
    }
  }

  if (record.pr === undefined) {
    const baseEv = await ctx.git.remoteDefaultBranch(root);
    if (!baseEv.ok) {
      return passthrough(baseEv);
    }
    const prTitle = firstTitle ?? `Delivery ${record.delivery}`;
    const prBody = `${record.issues.map((n) => `Closes #${n}`).join('\n')}\n`;
    const prEv = await ctx.gh.createDraftPr(repoEv.value, target, baseEv.value, prTitle, prBody);
    if (!prEv.ok) {
      return passthrough(prEv);
    }
    record = { ...record, pr: prEv.value.number };
    try {
      await ctx.record.writeRecord(root, record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exit: EXIT_UNKNOWN,
        errors: [errorDiagnostic('record_write_failed', message)],
      };
    }
  }

  const commit = await ctx.git.commitFile(
    root,
    RECORD_FILENAME,
    `chore: record delivery binding for ${record.delivery}`
  );
  if (!commit.ok) {
    return passthrough(commit);
  }

  const push = await ctx.git.pushBranch(root, target);
  if (!push.ok) {
    return passthrough(push);
  }

  return {
    exit: EXIT_SUCCESS,
    state: deriveBindingState(record),
    record: recordSummary(record),
    human: [
      `${resumed ? 'Resumed' : 'Bootstrapped'} delivery '${record.delivery}':`,
      `  Branch: ${target}`,
      `  Issues: ${record.issues.map((n) => `#${n}`).join(', ')}`,
      `  PR: #${record.pr} (draft)`,
      `  Recorded ${RECORD_FILENAME}, committed, pushed to origin`,
    ],
  };
}
