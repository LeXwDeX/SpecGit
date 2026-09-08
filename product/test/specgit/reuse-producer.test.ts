import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyReuseProducer, originalJobName, parseOriginalJobName } from '../../src/verification/reuse-producer.js';
import { fail, ok } from '../../src/kernel/evidence.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha = 'a'.repeat(40);
const recipe = {
  profile: 'linux', entry: '.github/workflows/verify.yml',
  files: [
    { path: '.github/workflows/verify.yml', sha256: hash('fixed workflow') },
    { path: 'ci/runtime.mjs', sha256: hash('fixed runtime') },
  ],
};
const contents = new Map([
  ['.github/workflows/verify.yml', 'fixed workflow'], ['ci/runtime.mjs', 'fixed runtime'],
]);

describe('original verification producer identity', () => {
  it('requires every approved producer input at the native execution revision', async () => {
    const reads: string[] = [];
    expect((await verifyReuseProducer(recipe, sha, async (revision, file) => {
      reads.push(`${revision}:${file}`);
      return ok(Buffer.from(contents.get(file)!));
    })).ok).toBe(true);
    expect(reads).toEqual(recipe.files.map((file) => `${sha}:${file.path}`));
  });

  it.each(['entry', 'runtime', 'missing', 'malformed'])('refuses %s producer evidence', async (change) => {
    const result = await verifyReuseProducer(recipe, sha, async (_revision, file) => {
      if (change === 'missing') return fail('not_found', 'Missing source');
      const modified = change === 'entry' ? file === recipe.entry : file !== recipe.entry;
      return ok(Buffer.from(change === 'malformed' ? [255] : modified ? 'tampered' : contents.get(file)!));
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    { ...recipe, files: recipe.files.slice(1) },
    { ...recipe, files: [...recipe.files, recipe.files[0]] },
    { ...recipe, entry: '../verify.yml' },
    { ...recipe, files: [{ path: recipe.entry, sha256: 'partial' }] },
  ])('refuses incomplete or ambiguous approval', async (invalid) => {
    expect((await verifyReuseProducer(invalid, sha, async (_revision, file) => ok(Buffer.from(contents.get(file) ?? '')))).ok).toBe(false);
  });

  it('distinguishes original execution names from current reuse gates without accepting partial digests', () => {
    const name = originalJobName('linux', 'b'.repeat(64));
    expect(parseOriginalJobName(name)).toEqual({ profile: 'linux', digest: 'b'.repeat(64) });
    for (const invalid of ['SpecGit reuse / linux / ' + 'b'.repeat(64), name + ' suffix', name.slice(0, -1), 'Test (linux)']) {
      expect(parseOriginalJobName(invalid)).toBeNull();
    }
  });
});
