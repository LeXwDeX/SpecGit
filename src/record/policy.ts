import { z } from 'zod';

export const PolicySchema = z
  .object({
    version: z.literal(1),
    required_checks: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
