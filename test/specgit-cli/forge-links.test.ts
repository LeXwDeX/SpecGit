import { describe, expect, it } from 'vitest';
import { forgeWebBase } from '../../src/cli/forge-links.js';

describe('forgeWebBase (#361)', () => {
  it('derives the web base from https, ssh, and scp-like origins, stripping .git', () => {
    expect(forgeWebBase('https://github.com/LeXwDeX/SpecGit.git')).toBe(
      'https://github.com/LeXwDeX/SpecGit'
    );
    expect(forgeWebBase('git@github.com:LeXwDeX/SpecGit.git')).toBe(
      'https://github.com/LeXwDeX/SpecGit'
    );
    expect(forgeWebBase('ssh://git@github.com/LeXwDeX/SpecGit')).toBe(
      'https://github.com/LeXwDeX/SpecGit'
    );
  });

  it('keeps GitLab nested-group project paths intact (#120 seam)', () => {
    expect(forgeWebBase('git@git.example.com:group/subgroup/specgit.git')).toBe(
      'https://git.example.com/group/subgroup/specgit'
    );
  });

  it('never emits insecure or malformed bases', () => {
    expect(forgeWebBase('http://github.com/LeXwDeX/SpecGit.git')).toBeNull();
    expect(forgeWebBase('https://github.com')).toBeNull();
    expect(forgeWebBase('https://github.com/a/../b')).toBeNull();
    expect(forgeWebBase(null)).toBeNull();
    expect(forgeWebBase('not a url')).toBeNull();
  });
});
