/**
 * Reference coercion for `specgit bind`.
 *
 * Issues must be GitHub issue numbers — pure-digit refs coerce to numbers
 * (shared `parseNumericRef` rule); GitHub issue URLs retain their repository
 * identity until bind verifies it against the origin. Everything else (opaque tracker ids such as `JIRA-123`,
 * other hosts) is rejected at bind time so the record can never carry a
 * reference the acceptance evaluator cannot verify. PR refs coerce pure
 * digits to numbers and keep anything else verbatim (the schema accepts
 * `number | string`).
 */

import { parseNumericRef } from '../record/schema.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { sanitize } from './output.js';

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/iu;

export interface ParsedIssueRef {
  number: number;
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
    `Issue reference '${sanitize(value)}' is not a GitHub issue.`,
    'Use GitHub issue numbers or https://github.com/<owner>/<repo>/issues/<n> URLs.'
  );
}

export function coercePrRef(raw: string): number | string {
  const value = raw.trim();
  return parseNumericRef(value) ?? value;
}
