import type { ForgeEvidencePort, OpenIssueFact } from '../../github/port.js';
import type { PolicyLanguage } from '../../record/policy.js';
import { parseNumericRef } from '../../record/schema.js';
import { EXIT_USAGE } from '../exit-codes.js';
import { catalogFor } from '../language.js';
import { errorDiagnostic, sanitize, type IssueOutcome } from '../output.js';
import type { RepoRef } from '../types.js';
import { passthrough } from './bootstrap.js';

export type PlannedIssue =
  | { readonly action: 'reuse'; readonly index: number; readonly number: number }
  | { readonly action: 'adopt'; readonly index: number; readonly number: number; readonly title: string }
  | { readonly action: 'create'; readonly index: number; readonly title: string };

/** Read-only choices shared by convention preflight and durable execution. */
export interface IssuePlan {
  readonly delivery: string;
  readonly entries: readonly PlannedIssue[];
}

export function issueBody(title: string, language: PolicyLanguage = 'en'): string {
  const { scaffold } = catalogFor(language);
  return [
    scaffold.issueWhy, title, '', scaffold.issueScope, '', scaffold.issueApproach,
    '', scaffold.issueAcceptance, scaffold.issueAcceptanceLine, '',
  ].join('\n');
}

/**
 * Reconcile one open-issue snapshot before any creation. A retry builds a
 * new plan, so an issue created before a failed record write can be adopted.
 * Occupancy is deliberately checked by the executor immediately before
 * each record write; a plan does not reserve an issue on the forge.
 */
export async function prepareIssuePlan(deps: {
  provider: Pick<ForgeEvidencePort, 'getOpenIssues'>;
  repo: RepoRef;
  language: PolicyLanguage;
  delivery: string;
  boundIssues: readonly number[];
  args: readonly string[];
  startIndex: number;
}): Promise<IssuePlan | IssueOutcome> {
  const remaining = deps.args.slice(deps.startIndex);
  let openIssues: OpenIssueFact[] = [];
  if (remaining.some((arg) => parseNumericRef(arg) === null)) {
    const open = await deps.provider.getOpenIssues(deps.repo);
    if (!open.ok) return passthrough(open);
    openIssues = open.value;
  }
  const used = new Set(deps.boundIssues);
  const entries: PlannedIssue[] = [];
  for (const [offset, title] of remaining.entries()) {
    const index = deps.startIndex + offset;
    const numeric = parseNumericRef(title);
    if (numeric !== null) {
      entries.push({ action: 'reuse', index, number: numeric });
      used.add(numeric);
      continue;
    }
    const candidates = openIssues.filter((issue) => issue.title === title && !used.has(issue.number));
    if (candidates.length === 0) {
      entries.push({ action: 'create', index, title });
      continue;
    }
    // Exact-title collisions are adoptable only when one candidate remains,
    // or exactly one carries SpecGit's deterministic scaffold (#77).
    const adoptable = candidates.length === 1 ? candidates
      : candidates.filter((issue) => issue.body === issueBody(title, deps.language));
    if (adoptable.length !== 1) {
      const listing = candidates.map((issue) => `  #${issue.number} ${issue.title ?? title}`).join('\n');
      return {
        exit: EXIT_USAGE,
        errors: [errorDiagnostic('issue_title_ambiguous',
          `Multiple open issues have the title '${sanitize(title)}':\n${listing}`, {
            fix: 'Adopt one explicitly by number (specgit issue <number>), or rename the unrelated issue so titles are unique, then re-run.',
          })],
      };
    }
    const number = adoptable[0].number;
    used.add(number);
    entries.push({ action: 'adopt', index, number, title });
  }
  return { delivery: deps.delivery, entries };
}
