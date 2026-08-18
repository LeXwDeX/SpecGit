import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('package/bin/product naming (specgit)', () => {
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  it('renames the package to specgit', () => {
    expect(pkg.name).toBe('specgit');
  });

  it('points the canonical repository and homepage at LeXwDeX/SpecGit', () => {
    expect(pkg.repository.url).toBe('https://github.com/LeXwDeX/SpecGit');
    expect(pkg.homepage).toBe('https://github.com/LeXwDeX/SpecGit');
  });

  it('publishes a single specgit bin and no legacy alias', () => {
    expect(pkg.bin).toEqual({ specgit: './bin/specgit.js' });
    expect(Object.keys(pkg.bin)).not.toContain('openspec');
  });

  it('ships bin/specgit.js running the dist CLI entry', () => {
    const binPath = path.join(projectRoot, 'bin', 'specgit.js');
    expect(existsSync(binPath)).toBe(true);
    const content = readFileSync(binPath, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(content).toContain('dist/cli/index.js');
    expect(content).not.toMatch(/openspec/i);
  });

  it('removes the legacy bin alias file', () => {
    expect(existsSync(path.join(projectRoot, 'bin', 'openspec.js'))).toBe(false);
  });
});
