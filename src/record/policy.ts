import { z } from 'zod';

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
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
