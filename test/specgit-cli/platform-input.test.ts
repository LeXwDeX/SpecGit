import { describe, expect, it } from 'vitest';
import { classifyHarnessPlatform } from '../../src/cli/platform-input.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import type { Providers } from '../../src/record/providers.js';

describe('harness platform inputs', () => {
  it('offers GitLab adoption without granting an undeclared origin platform capability', () => {
    const originUrl = 'https://gitlab.example.com/group/project.git';
    expect(classifyHarnessPlatform({
      originUrl, providers: fail('providers_missing', 'No declaration.'),
    })).toEqual({ mode: 'gitlab', source: 'origin', declaration: { host: 'gitlab.example.com', port: null } });
    expect(parseRepoRef(originUrl)).toMatchObject({ ok: false, code: 'gitlab_unsupported' });
  });

  it.each([
    ['https://github.com:443/group/project.git', 'github'],
    ['ssh://git@github.com:22/group/project.git', 'github'],
    ['https://gitlab.example.com:443/group/project.git', 'gitlab'],
    ['ssh://git@gitlab.example.com:22/group/project.git', 'gitlab'],
    ['https://github.com:8443/group/project.git', 'undecided'],
    ['https://gitlab.example.com:8443/group/project.git', 'undecided'],
    ['https://mygitlab.example.com/group/project.git', 'undecided'],
    ['ftp://gitlab.example.com/group/project.git', 'undecided'],
  ])('keeps the existing adoption decision for %s', (originUrl, mode) => {
    expect(classifyHarnessPlatform({ originUrl, providers: ok({}) }).mode).toBe(mode);
  });

  it.each(['https://github.com/group/project.git', 'https://gitlab.com/group/project.git', null])(
    'refuses to classify over invalid declaration evidence on %s', (originUrl) => {
      expect(classifyHarnessPlatform({ originUrl, providers: fail('providers_invalid', 'Broken YAML.') }))
        .toEqual({ mode: 'providers_invalid', message: 'Broken YAML.' });
    }
  );

  it('preserves a declared endpoint independently of origin hints', () => {
    expect(classifyHarnessPlatform({
      originUrl: 'https://github.com/group/project.git',
      providers: ok({ gitlab: { host: 'git.example.com', port: '8443', insecure_ssl: false } }),
    })).toEqual({ mode: 'gitlab', source: 'providers', declaration: { host: 'git.example.com', port: '8443' } });
  });

  it('distinguishes an absent origin from a malformed origin for init diagnostics', () => {
    const providers = fail<Providers>('providers_missing', 'No declaration.');
    expect(classifyHarnessPlatform({ originUrl: null, providers }))
      .toEqual({ mode: 'undecided', endpoint: null, hasOrigin: false });
    expect(classifyHarnessPlatform({ originUrl: 'not an origin', providers }))
      .toEqual({ mode: 'undecided', endpoint: null, hasOrigin: true });
  });
});
