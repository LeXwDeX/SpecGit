import { z } from 'zod';

export const SPEC_GIT_DIR = 'spec_git';
export const POLICY_FILENAME = 'policy.yaml';
export const RECORD_FILENAME = '.specgit.yaml';
export const PROVIDERS_FILENAME = 'providers.yaml';

export const KEBAB_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isKebabId(value: string): boolean {
  return KEBAB_ID_REGEX.test(value);
}

export const KEBAB_ID_FIX =
  'Use kebab-case with lowercase letters, numbers, and single hyphen separators.';

const KebabIdSchema = z.string().superRefine((value, ctx) => {
  if (!isKebabId(value)) {
    ctx.addIssue({ code: 'custom', message: KEBAB_ID_FIX });
  }
});

const BranchSchema = z.string().min(1);

const WorktreeLabelSchema = z
  .string()
  .min(1)
  .refine((value) => !/^(\/|\\|[A-Za-z]:[/\\])/.test(value), {
    message: 'worktree label must be portable (no local paths)',
  });

export const ExecutionContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), branch: BranchSchema }),
  z.object({ kind: z.literal('worktree'), label: WorktreeLabelSchema, branch: BranchSchema }),
]);

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

export const DeliveryBindingSchema = z
  .object({
    version: z.literal(1),
    delivery: KebabIdSchema,
    context: ExecutionContextSchema,
    issues: z.array(z.number().int().positive()).default([]),
    pr: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  })
  .passthrough();

export type DeliveryBinding = z.infer<typeof DeliveryBindingSchema>;

export function mergeIssueNumbers(existing: number[], incoming: number[]): number[] {
  return [...existing, ...incoming].filter((value, index, all) => all.indexOf(value) === index);
}

export function parseNumericRef(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
