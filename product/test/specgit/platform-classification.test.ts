/**
 * Origin platform classification (#279): shape + declared config →
 * platform marker. These tests fabricate shapes directly — no URL text
 * is parsed, so a classification rule cannot hide behind shape parsing.
 */

import { describe, expect, it } from 'vitest';

import {
  isDeclaredGitLab,
  isGitHubOrigin,
  isGitLabHeuristic,
  normalizeDeclaredGitLab,
} from '../../src/gitfacts/platform.js';
import type { ScpShape, UrlShape } from '../../src/gitfacts/origin-shape.js';

function urlShape(overrides: Partial<UrlShape> = {}): UrlShape {
  return {
    kind: 'url',
    scheme: 'https',
    host: 'example.com',
    port: '',
    username: '',
    password: '',
    path: '/o/r',
    ...overrides,
  };
}

function scpShape(overrides: Partial<ScpShape> = {}): ScpShape {
  return { kind: 'scp', user: 'git', host: 'example.com', path: 'o/r', ...overrides };
}

describe('isGitHubOrigin', () => {
  it('accepts the exact github.com host on the url tracks with default ports', () => {
    expect(isGitHubOrigin(urlShape({ host: 'github.com' }))).toBe(true);
    expect(isGitHubOrigin(urlShape({ host: 'github.com', scheme: 'ssh', username: 'git' }))).toBe(true);
    expect(isGitHubOrigin(urlShape({ host: 'github.com', port: '443' }))).toBe(true);
  });

  it('rejects host suffixes, userinfo, passwords, and non-default ports', () => {
    expect(isGitHubOrigin(urlShape({ host: 'notgithub.com' }))).toBe(false);
    expect(isGitHubOrigin(urlShape({ host: 'github.com.evil.net' }))).toBe(false);
    expect(isGitHubOrigin(urlShape({ host: 'github.com', username: 'someone' }))).toBe(false);
    expect(isGitHubOrigin(urlShape({ host: 'github.com', password: 'x' }))).toBe(false);
    expect(isGitHubOrigin(urlShape({ host: 'github.com', port: '8443' }))).toBe(false);
  });

  it('scp track: exactly the git user at github.com', () => {
    expect(isGitHubOrigin(scpShape({ host: 'github.com' }))).toBe(true);
    expect(isGitHubOrigin(scpShape({ host: 'github.com', user: 'someone' }))).toBe(false);
    expect(isGitHubOrigin(scpShape({ host: 'notgithub.com' }))).toBe(false);
  });
});

describe('isGitLabHeuristic', () => {
  it('is a substring probe on the extracted host — diagnostic only', () => {
    expect(isGitLabHeuristic(urlShape({ host: 'git.ycgame.com' }))).toBe(false);
    expect(isGitLabHeuristic(urlShape({ host: 'gitlab.example.com' }))).toBe(true);
    expect(isGitLabHeuristic(scpShape({ host: 'my-gitlab.internal' }))).toBe(true);
    expect(isGitLabHeuristic(scpShape({ host: 'my-gitlab.internal', user: 'someone' }))).toBe(false);
  });
});

describe('isDeclaredGitLab', () => {
  it('matches only the declared host', () => {
    const declared = { host: 'git.internal', port: null };
    expect(isDeclaredGitLab(urlShape({ host: 'git.internal' }), declared)).toBe(true);
    expect(isDeclaredGitLab(urlShape({ host: 'other.internal' }), declared)).toBe(false);
    expect(isDeclaredGitLab(urlShape({ host: 'git.internal' }), undefined)).toBe(false);
  });

  it('a declared non-default port admits exactly that port (#78)', () => {
    const declared = { host: 'git.internal', port: '8929' };
    expect(isDeclaredGitLab(urlShape({ host: 'git.internal', port: '8929' }), declared)).toBe(true);
    expect(isDeclaredGitLab(urlShape({ host: 'git.internal' }), declared)).toBe(false);
    expect(isDeclaredGitLab(urlShape({ host: 'git.internal', port: '9999' }), declared)).toBe(false);
  });

  it('scp implies ssh:22, so only a portless or :22 declaration matches', () => {
    expect(isDeclaredGitLab(scpShape({ host: 'git.internal' }), { host: 'git.internal', port: null })).toBe(true);
    expect(isDeclaredGitLab(scpShape({ host: 'git.internal' }), { host: 'git.internal', port: '22' })).toBe(true);
    expect(isDeclaredGitLab(scpShape({ host: 'git.internal' }), { host: 'git.internal', port: '8929' })).toBe(false);
  });

  it('url-track userinfo rules apply: no password, git-only on ssh', () => {
    const declared = { host: 'git.internal', port: null };
    expect(isDeclaredGitLab(urlShape({ host: 'git.internal', password: 'x' }), declared)).toBe(false);
    expect(
      isDeclaredGitLab(urlShape({ host: 'git.internal', scheme: 'ssh', username: 'someone' }), declared)
    ).toBe(false);
    expect(
      isDeclaredGitLab(urlShape({ host: 'git.internal', scheme: 'ssh', username: 'git' }), declared)
    ).toBe(true);
  });
});

describe('normalizeDeclaredGitLab', () => {
  it('parses host and optional host:port; malformed declarations never match', () => {
    expect(normalizeDeclaredGitLab('Git.Internal ')).toEqual({ host: 'git.internal', port: null });
    expect(normalizeDeclaredGitLab('git.internal:8929')).toEqual({ host: 'git.internal', port: '8929' });
    expect(normalizeDeclaredGitLab('git.internal:89x9')).toBeUndefined();
    expect(normalizeDeclaredGitLab('git.internal:123456')).toBeUndefined();
    expect(normalizeDeclaredGitLab('bad_host')).toBeUndefined();
    expect(normalizeDeclaredGitLab(undefined)).toBeUndefined();
    expect(normalizeDeclaredGitLab('   ')).toBeUndefined();
  });
});
