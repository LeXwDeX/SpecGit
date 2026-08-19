import { z } from 'zod';

/**
 * Provider configuration (spec_git/providers.yaml): explicit, user-owned
 * declarations the URL heuristics cannot decide — today, which self-hosted
 * host is a GitLab instance. Committed to the repository so the whole team
 * shares one declaration.
 */
export const ProvidersSchema = z
  .object({
    gitlab: z
      .object({
        /** Bare hostname (git.ycgame.com); no scheme, no path. */
        host: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9.-]+$/, 'host must be a bare hostname'),
        insecure_ssl: z.boolean().default(false),
      })
      .optional(),
  })
  .strict();

export type Providers = z.infer<typeof ProvidersSchema>;
