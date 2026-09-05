/**
 * Reference coercion for `specgit bind`.
 *
 * Pure-digit issue refs are local to the routed forge. GitHub issue URLs are
 * also accepted and retain their repository identity until bind verifies it
 * against the origin. Request refs likewise accept pure digits or a full
 * GitHub PR URL. Other URL forms and opaque tracker ids such as `JIRA-123`
 * are rejected before the record can carry a reference the evaluator cannot
 * verify.
 */

import { parseNumericRef } from '../record/schema.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { sanitize } from './output.js';

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/iu;
const GITHUB_PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/iu;

export interface ParsedIssueRef {
  number: number;
  repository?: { owner: string; repo: string };
}

export interface ParsedPrRef {
  value: number | string;
  repository?: { owner: string; repo: string };
}

export function coerceIssueRef(raw: string): Evidence<ParsedIssueRef> {
  const value = raw.trim();

  const numeric = parseNumericRef(value);
  if (numeric !== null) {
    return ok({ number: numeric });
  }

  const url = GITHUB_ISSUE_URL.exec(value);
  const urlNumber = url === null ? null : parseNumericRef(url[3]);
  if (url !== null && urlNumber !== null) {
    return ok({ number: urlNumber, repository: { owner: url[1], repo: url[2] } });
  }

  return fail(
    'issue_ref_not_github',
    `Issue reference '${sanitize(value)}' is not a supported forge issue reference.`,
    'Use a numeric issue number on the current forge, or https://github.com/<owner>/<repo>/issues/<n> for GitHub.'
  );
}

export function coercePrRef(raw: string): Evidence<ParsedPrRef> {
  const value = raw.trim();
  const numeric = parseNumericRef(value);
  if (numeric !== null) {
    return ok({ value: numeric });
  }
  const url = GITHUB_PR_URL.exec(value);
  if (url !== null && parseNumericRef(url[3]) !== null) {
    return ok({ value, repository: { owner: url[1], repo: url[2] } });
  }
  return fail(
    'pr_ref_invalid',
    `PR/MR reference '${sanitize(value)}' is not supported.`,
    'Use a numeric PR/MR ID on the current forge, or https://github.com/<owner>/<repo>/pull/<n> for GitHub.'
  );
}
