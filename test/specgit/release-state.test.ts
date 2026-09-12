import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('GitHub-only release entry point', () => {
  it('retains the private-workspace guard and removes npm publication controllers', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.release).toBe('pnpm run release:ci');
    expect(pkg.scripts['release:ci']).toBe('node runtime/distribution/publish.mjs');
    expect(pkg.scripts.prepublishOnly).toBe('node runtime/distribution/forbid-root-publish.mjs');
    for (const file of ['scripts/release-state.mjs', 'runtime/distribution/npm-publish.mjs']) expect(existsSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)))).toBe(false);
  });
});
