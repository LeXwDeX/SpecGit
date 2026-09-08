import { z } from 'zod';

/** Portable, case-sensitive repository paths: * within a component, ** as a whole component. */
export function isVerificationPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 300 || /[\\\p{Cc}\p{Cf}?\[\]{}!]/u.test(pattern)) return false;
  const parts = pattern.split('/');
  return parts[0] !== '**' && parts.every((part) =>
    part !== '' && part !== '.' && part !== '..' && (!part.includes('**') || part === '**'));
}

const CheckNameSchema = z.string().min(1).max(200).refine((name) => name === name.trim(),
  { message: 'Use the exact check name without surrounding whitespace.' }).refine((name) =>
  name !== 'SpecGit Acceptance' && name !== 'SpecGit Completion',
{ message: 'Verification cannot require its own acceptance or completion job.' });

export const VerificationPolicySchema = z.object({
  gitlab_entry: z.string().max(300).refine((value) =>
    isVerificationPattern(value) && !/[*:@%]/.test(value) && value === value.trim(),
  { message: 'Use a local GitLab CI entry path without URL, project, ref or wildcard syntax.' }).optional(),
  product_checks: z.array(CheckNameSchema).min(1).max(100),
  rules: z.array(z.object({
    paths: z.array(z.string().refine(isVerificationPattern, {
      message: 'Use anchored repository paths with * or component **; no traversal or leading **.',
    })).min(1).max(100),
    checks: z.array(CheckNameSchema).max(100),
  }).strict()).max(100),
}).strict();

export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;
