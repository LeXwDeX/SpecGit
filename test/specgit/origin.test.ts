import { describe, expect, it } from 'vitest';

import {
  formatRepoRef,
  parsePrUrl,
  parseRepoRef,
  sameRepoRef,
} from '../../src/gitfacts/origin.js';

describe('parseRepoRef', () => {
  const goodCases: Array<[string, { owner: string; repo: string }]> = [
    ['https://github.com/LeXwDeX/SpecGit', { owner: 'LeXwDeX', repo: 'SpecGit' }],
    ['https://github.com/LeXwDeX/SpecGit.git', { owner: 'LeXwDeX', repo: 'SpecGit' }],
    ['https://github.com/owner/repo/', { owner: 'owner', repo: 'repo' }],
    ['git@github.com:LeXwDeX/SpecGit.git', { owner: 'LeXwDeX', repo: 'SpecGit' }],
    ['git@github.com:owner/repo', { owner: 'owner', repo: 'repo' }],
    ['ssh://git@github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
    ['ssh://git@github.com/owner/repo', { owner: 'owner', repo: 'repo' }],
  ];

  it.each(goodCases)('parses %s', (url, expected) => {
    const result = parseRepoRef(url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(expected);
  });

  const badCases = [
    'https://example.com/owner/repo',
    'https://notgithub.com/owner/repo',
    'not-a-url',
    '',
    '  ',
    'https://github.com/owner-only',
  ];

  it.each(badCases)('fails closed for %s', (url) => {
    const result = parseRepoRef(url);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  });

  it.each([
    'https://gitlab.com/owner/repo.git',
    'git@gitlab.com:owner/repo.git',
    'ssh://git@gitlab.com/owner/repo.git',
    'https://gitlab.example.com/owner/repo.git',
  ])('classifies %s as a GitLab origin with a dedicated diagnostic', (url) => {
    const result = parseRepoRef(url);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_unsupported');
    expect(result.message).toContain('GitLab');
    expect(result.fix).toContain('github.com');
  });

  it('keeps shorthand gitlab: refs as unresolvable', () => {
    const result = parseRepoRef('gitlab:owner/repo.git');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  });

  it('compares repo refs case-insensitively', () => {
    expect(sameRepoRef({ owner: 'LeXwDeX', repo: 'SpecGit' }, { owner: 'lexwdex', repo: 'specgit' })).toBe(true);
    expect(sameRepoRef({ owner: 'a', repo: 'b' }, { owner: 'a', repo: 'c' })).toBe(false);
  });

  it('formats owner/repo', () => {
    expect(formatRepoRef({ owner: 'o', repo: 'r' })).toBe('o/r');
  });
});

describe('parsePrUrl', () => {
  it('parses a canonical github.com PR URL', () => {
    const result = parsePrUrl('https://github.com/LeXwDeX/SpecGit/pull/42');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repo).toEqual({ owner: 'LeXwDeX', repo: 'SpecGit' });
    expect(result.value.pr).toBe(42);
  });

  it('accepts a trailing slash', () => {
    const result = parsePrUrl('https://github.com/o/r/pull/7/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pr).toBe(7);
  });

  it('fails for non-PR or non-github URLs', () => {
    for (const url of [
      'https://github.com/o/r/issues/3',
      'https://gitlab.com/o/r/pull/3',
      '42',
      'https://github.com/o/r/pull/',
    ]) {
      const result = parsePrUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('pr_not_found');
    }
  });
});
