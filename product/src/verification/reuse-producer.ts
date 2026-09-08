import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, ok, type Evidence } from '../kernel/evidence.js';

const profile = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const filePath = z.string().max(300).regex(/^[A-Za-z0-9_.\/-]+$/).refine((value) =>
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git'));
const recipeSchema = z.object({
  profile, entry: filePath,
  files: z.array(z.object({ path: filePath, sha256: digest }).strict()).min(1).max(30),
}).strict();

/** Constructed from the approved fixed integration, never from an execution receipt. */
export type ApprovedReuseProducer = z.infer<typeof recipeSchema>;

export function originalJobName(profileId: string, inputDigest: string): string {
  profile.parse(profileId);
  digest.parse(inputDigest);
  return `SpecGit original / ${profileId} / ${inputDigest}`;
}

export function parseOriginalJobName(name: string): { profile: string; digest: string } | null {
  const match = /^SpecGit original \/ ([a-z0-9]+(?:-[a-z0-9]+)*) \/ ([a-f0-9]{64})$/.exec(name);
  return match && match[1].length <= 60 ? { profile: match[1], digest: match[2] } : null;
}

/** Verify the approved producer bytes; native identity and recipe semantics are separate. */
export async function verifyReuseProducer(
  approved: ApprovedReuseProducer,
  sourceSha: string,
  readFile: (sha: string, file: string) => Promise<Evidence<Buffer>>,
): Promise<Evidence<{ recipeDigest: string }>> {
  const unavailable = () => fail<{ recipeDigest: string }>('verification_producer_unproven',
    'The original execution does not have a complete matching approved producer.',
    'Execute verification; current files or self-declared receipts cannot replace historical producer evidence.');
  try {
    const parsed = recipeSchema.safeParse(approved);
    if (!parsed.success || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) return unavailable();
    const recipe = parsed.data;
    if (!recipe.files.some((file) => file.path === recipe.entry) ||
        new Set(recipe.files.map((file) => file.path.toLowerCase())).size !== recipe.files.length) return unavailable();
    for (const file of recipe.files) {
      const result = await readFile(sourceSha, file.path);
      if (!result.ok || result.value.length > 1024 * 1024 ||
          createHash('sha256').update(result.value).digest('hex') !== file.sha256) return unavailable();
    }
    return ok({ recipeDigest: createHash('sha256').update(JSON.stringify({
      version: 1, ...recipe, files: [...recipe.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    })).digest('hex') });
  } catch { return unavailable(); }
}
