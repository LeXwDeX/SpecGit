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
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
