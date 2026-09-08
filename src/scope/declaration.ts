import { z } from 'zod';
import YAML from 'yaml';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { isAutomationTargetBranch } from '../record/policy.js';
import { isKebabId } from '../record/schema.js';

const IssueNumber = z.number().int().positive().safe();
export const ScopeSchema = z.object({
  version: z.literal(1),
  name: z.string().max(100).refine(isKebabId),
  parent: IssueNumber,
  required: z.array(z.object({
    issue: IssueNumber,
    target: z.string().refine(isAutomationTargetBranch),
    request: IssueNumber.optional(),
  }).strict()).min(1).max(100),
}).strict().superRefine((scope, ctx) => {
  const issues = scope.required.map((member) => member.issue);
  if (issues.includes(scope.parent) || new Set(issues).size !== issues.length) {
    ctx.addIssue({ code: 'custom', path: ['required'], message: 'Required members must be unique and cannot include the parent.' });
  }
});

export type ScopeDeclaration = z.infer<typeof ScopeSchema>;
export type ScopeMember = ScopeDeclaration['required'][number];

export function scopePath(name: string): Evidence<string> {
  return name.length <= 100 && isKebabId(name)
    ? ok(`spec_git/scopes/${name}.yaml`)
    : fail('scope_invalid', 'Use a scope name of at most 100 lowercase kebab-case characters.');
}

export function parseScope(name: string, content: string): Evidence<ScopeDeclaration> {
  try {
    const parsed = ScopeSchema.safeParse(YAML.parse(content));
    if (parsed.success && parsed.data.name === name) return ok(parsed.data);
  } catch { /* Invalid YAML is evidence failure, never an empty scope. */ }
  return fail('scope_invalid', 'The scope declaration is invalid or its name differs from the requested scope.');
}

/** Oldest first, including deletions. Required work cannot disappear through edits or reverts. */
export function verifyScopeHistory(name: string, revisions: readonly (string | null)[]): Evidence<ScopeDeclaration> {
  let previous: ScopeDeclaration | undefined;
  for (const content of revisions) {
    if (content === null) {
      if (previous) return fail('scope_amendment_unsupported', 'An approved scope was deleted; version 1 cannot approve scope reduction.');
      continue;
    }
    const parsed = parseScope(name, content);
    if (!parsed.ok) return parsed;
    const current = parsed.value;
    if (previous && (current.parent !== previous.parent || previous.required.some((old) => {
      const member = current.required.find((item) => item.issue === old.issue);
      return !member || member.target !== old.target || (old.request !== undefined && member.request !== old.request);
    }))) return fail('scope_amendment_unsupported', 'Required membership, targets, and selected requests cannot be removed or replaced in version 1.');
    previous = current;
  }
  return previous ? ok(previous) : fail('scope_unapproved', 'No approved scope declaration exists on the remote default branch.');
}
