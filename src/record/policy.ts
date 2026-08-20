import { z } from 'zod';

/**
 * #118 — the presentation languages the generated-text catalog ships.
 * `en` is the default (an absent `language` key); adding a language is a
 * catalog growth step, not a policy-format change. The machine contract
 * (exit codes, `--json` field names, diagnostic `code` values) is never
 * localized under any value here.
 */
export const POLICY_LANGUAGES = ['en', 'zh'] as const;

export type PolicyLanguage = (typeof POLICY_LANGUAGES)[number];

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
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
