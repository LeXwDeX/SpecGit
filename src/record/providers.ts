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
        /**
         * Optional explicit port (#78): present only when the instance
         * uses a non-default port. Origins classify against host:port;
         * absence means the scheme default (443 https, 22 ssh).
         */
        port: z
          .union([z.number().int().min(1).max(65535), z.string().regex(/^\d{1,5}$/)])
          .transform((value) => String(value))
          .optional(),
        insecure_ssl: z.boolean().default(false),
      })
      .optional(),
  })
  .strict();

export type Providers = z.infer<typeof ProvidersSchema>;
