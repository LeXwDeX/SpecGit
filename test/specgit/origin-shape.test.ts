/**
 * Origin URL shape parsing (#279): text → host + path, no platform
 * opinion. These tests never mention a platform — classification is
 * platform.ts's job.
 */

import { describe, expect, it } from 'vitest';

import {
  isAllDigits,
  parseOriginShape,
  parsePathSegments,
} from '../../src/gitfacts/origin-shape.js';

describe('parseOriginShape: the url track', () => {
  it('splits scheme, host, port, userinfo, and path', () => {
    expect(parseOriginShape('https://example.com/owner/repo.git')).toEqual({
      kind: 'url',
      scheme: 'https',
      host: 'example.com',
      port: '',
      username: '',
      password: '',
      path: '/owner/repo.git',
    });
    expect(parseOriginShape('ssh://user@Host.Example:8022/some/path')).toEqual({
      kind: 'url',
      scheme: 'ssh',
      host: 'host.example',
      port: '8022',
      username: 'user',
      password: '',
      path: '/some/path',
    });
  });

  it('rejects query and fragment: attacker-controlled surfaces never carry identity', () => {
    expect(parseOriginShape('https://example.com/o/r?x=1')).toBeNull();
    expect(parseOriginShape('https://example.com/o/r#frag')).toBeNull();
  });

  it('unknown schemes fall through to the scp track: shape parsing holds no platform opinion', () => {
    expect(parseOriginShape('ftp://example.com/o/r')).toEqual({
      kind: 'scp',
      user: '',
      host: 'ftp',
      path: '//example.com/o/r',
    });
  });

  it('rejects implausible hosts', () => {
    expect(parseOriginShape('https://_bad_host/o/r')).toBeNull();
    expect(parseOriginShape('https://')).toBeNull();
  });
});

describe('parseOriginShape: the scp track', () => {
  it('splits user, host, and path; host is lowercased', () => {
    expect(parseOriginShape('git@Example.COM:owner/repo.git')).toEqual({
      kind: 'scp',
      user: 'git',
      host: 'example.com',
      path: 'owner/repo.git',
    });
  });

  it('the LAST @ bounds the host: earlier @ signs are user text', () => {
    expect(parseOriginShape('git@example.com@other.net:o/r')).toEqual({
      kind: 'scp',
      user: 'git@example.com',
      host: 'other.net',
      path: 'o/r',
    });
  });

  it('schemeless text without a colon is not an origin', () => {
    expect(parseOriginShape('not-a-url')).toBeNull();
    expect(parseOriginShape(':path-only')).toBeNull();
  });
});

describe('parsePathSegments', () => {
  it('url track: requires the leading slash, tolerates a trailing one', () => {
    expect(parsePathSegments('/owner/repo', true)).toEqual(['owner', 'repo']);
    expect(parsePathSegments('/owner/repo/', true)).toEqual(['owner', 'repo']);
    expect(parsePathSegments('owner/repo', true)).toBeNull();
  });

  it('scp track: rejects slashes at either edge', () => {
    expect(parsePathSegments('owner/repo', false)).toEqual(['owner', 'repo']);
    expect(parsePathSegments('/owner/repo', false)).toBeNull();
    expect(parsePathSegments('owner/repo/', false)).toBeNull();
  });

  it('empty segments fail closed on both tracks', () => {
    expect(parsePathSegments('/owner//repo', true)).toBeNull();
    expect(parsePathSegments('owner//repo', false)).toBeNull();
  });
});

describe('isAllDigits', () => {
  it('accepts only pure digit runs', () => {
    expect(isAllDigits('22')).toBe(true);
    expect(isAllDigits('22a')).toBe(false);
    expect(isAllDigits('')).toBe(true);
  });
});
