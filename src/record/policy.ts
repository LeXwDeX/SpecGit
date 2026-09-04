import { z } from 'zod';

import { isTagSlug, TAG_GRAMMAR_FIX } from '../tags/catalog.js';

/**
 * #118 — the presentation languages the generated-text catalog ships.
 * `en` is the default (an absent `language` key); adding a language is a
 * catalog growth step, not a policy-format change. The machine contract
 * (exit codes, `--json` field names, diagnostic `code` values) is never
 * localized under any value here.
 */
export const POLICY_LANGUAGES = ['en', 'zh'] as const;

export type PolicyLanguage = (typeof POLICY_LANGUAGES)[number];

/**
 * A project-declared tag (#330): the name must satisfy the portable tag
 * grammar (both forges tolerate it); the seed color is optional — a
 * missing one falls back to the catalog's stable per-name assignment.
 */
export const PolicyTagSchema = z
  .object({
    name: z.string().refine(isTagSlug, { message: TAG_GRAMMAR_FIX }),
    color: z
      .string()
      .regex(/^[0-9a-fA-F]{6}$/, 'Color must be six hex digits without "#".')
      .optional(),
    description: z.string().max(300).optional(),
  })
  .strict();

export type PolicyTag = z.infer<typeof PolicyTagSchema>;

/** A branch name, not a revision expression, option, or fully qualified ref. */
export function isAutomationTargetBranch(branch: string): boolean {
  return branch.length > 0 &&
    branch !== 'HEAD' && branch !== '@' &&
    !branch.startsWith('-') && !branch.startsWith('refs/') && !branch.endsWith('.') &&
    !/[\s\p{Cc}\p{Cf}~^:?*\[\\]/u.test(branch) &&
    !branch.includes('..') && !branch.includes('@{') &&
    branch.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

export const PolicyAutomationSchema = z.object({
  merge: z.boolean(),
  target_branch: z.string().refine(isAutomationTargetBranch, {
    message: 'Use a branch name such as main or release/stable, without revision syntax or options.',
  }).optional(),
  close_issues: z.boolean().optional(),
}).strict().superRefine((automation, ctx) => {
  if (automation.merge && automation.target_branch === undefined) {
    ctx.addIssue({ code: 'custom', path: ['target_branch'], message: 'Automatic merge requires an explicit target branch.' });
  }
  if (!automation.merge && automation.close_issues === true) {
    ctx.addIssue({ code: 'custom', path: ['close_issues'], message: 'Automatic issue closure requires automatic merge to be enabled.' });
  }
});

export type PolicyAutomation = z.infer<typeof PolicyAutomationSchema>;

export const PolicySchema = z
  .object({
    version: z.literal(1),
    // An empty list is a valid no-CI policy (#63): it names zero sibling
    // checks, so the acceptance workflow's wait step trivially completes
    // and the SpecGit Acceptance job itself (enforced through branch
    // protection, kept out of this list to avoid self-deadlock) is the
    // gate. Names that can never appear as check-runs (e.g. the PR merge
    // box aggregate) are rejected at init detection instead.
    required_checks: z.array(z.string().min(1)),
    ordered_issues: z.boolean().optional(),
    /** Presentation language of generated text (scaffolds, harness guidance, human prose). Default `en`. */
    language: z.enum(POLICY_LANGUAGES).optional(),
    /**
     * Project-declared tag vocabulary (#330): the pool-first selection's
     * additional known names beyond the built-in `kind::` axis. Declared
     * here means seedable; anything else absent from the pool is an
     * unknown slug the selection refuses.
     */
    tags: z.array(PolicyTagSchema).optional(),
    /** Explicitly selected project conventions, checked against live forge facts. */
    validation: z.object({
      titles: z.boolean().optional(),
      labels: z.enum(['off', 'kind', 'project']).optional(),
    }).strict().optional(),
    /** Explicit authorization for merge and issue closure; absent means disabled. */
    automation: PolicyAutomationSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.validation?.labels === 'project' && !policy.tags?.length) {
      ctx.addIssue({ code: 'custom', path: ['tags'], message: 'Project label validation requires a non-empty tags vocabulary.' });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;
