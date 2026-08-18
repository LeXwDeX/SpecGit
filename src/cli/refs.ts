/**
 * Reference coercion for `specgit bind`.
 *
 * Issues must be GitHub issue numbers — pure-digit refs coerce to numbers
 * (shared `parseNumericRef` rule) and GitHub issue URLs resolve to their
 * trailing number; everything else (opaque tracker ids such as `JIRA-123`,
 * other hosts) is rejected at bind time so the record can never carry a
 * reference the acceptance evaluator cannot verify. PR refs coerce pure
 * digits to numbers and keep anything else verbatim (the schema accepts
 * `number | string`).
 */

import { parseNumericRef } from '../record/schema.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { sanitize } from './output.js';

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/iu;

export function coerceIssueRef(raw: string): Evidence<number> {
  const value = raw.trim();

  const numeric = parseNumericRef(value);
  if (numeric !== null) {
    return ok(numeric);
  }

  const url = GITHUB_ISSUE_URL.exec(value);
  if (url) {
    return ok(Number(url[3]));
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
