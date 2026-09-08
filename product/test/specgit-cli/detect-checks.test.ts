import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';

import { classifyPlatform } from '../../src/cli/detect-checks.js';
import { extractOriginHost } from '../../src/gitfacts/origin.js';

/**
 * Pinned origin-classification truth table for #83 (CodeQL alert 1,
 * js/incomplete-url-substring-sanitization).
 *
 * The table is one matrix with parseRepoRef (src/gitfacts/origin.ts):
 * platform trust is decided from the structurally extracted HOST
 * component only — never from userinfo, path, query, fragment, or a
 * token that merely appears somewhere in the URL. Explicit ports are
 * accepted only in the forms tracked by #78 (a port equal to the
 * scheme default classifies like the portless form; every other port
 * fails closed to 'unknown').
 */

async function platform(url: string | null): Promise<string> {
  return classifyPlatform(url);
}

describe('classifyPlatform — accepted github forms (host is genuinely github.com)', () => {
  it.each([
    ['https://github.com/LeXwDeX/SpecGit', 'https'],
    ['https://github.com/LeXwDeX/SpecGit.git', 'https with .git'],
    ['https://github.com/LeXwDeX/SpecGit.git/', 'https with trailing slash'],
    ['HTTPS://GITHUB.COM/LeXwDeX/SpecGit.GIT', 'mixed case'],
    ['  https://github.com/LeXwDeX/SpecGit.git  ', 'surrounding whitespace'],
    ['https://github.com', 'no path'],
    ['https://github.com?lazy=1', 'query directly after the genuine host'],
    ['https://github.com#fragment', 'fragment directly after the genuine host'],
    ['https://github.com:443/LeXwDeX/SpecGit.git', '#78 default port 443'],
    ['git@github.com:LeXwDeX/SpecGit.git', 'scp'],
    ['Git@GitHub.Com:LeXwDeX/SpecGit.GIT', 'scp mixed case'],
    ['deploy@github.com:owner/repo.git', 'scp with non-git userinfo'],
    ['github.com:owner/repo.git', 'scp without userinfo'],
    ['ssh://git@github.com/LeXwDeX/SpecGit.git', 'ssh'],
    ['ssh://git@github.com:22/LeXwDeX/SpecGit.git', '#78 default port 22'],
  ])('%s (%s)', async (url) => {
    await expect(platform(url)).resolves.toBe('github');
  });
});

describe('classifyPlatform — accepted gitlab forms (host-component heuristic, same predicate as parseRepoRef gitlab_unsupported)', () => {
  it.each([
    ['https://gitlab.com/owner/repo.git'],
    ['git@gitlab.com:owner/repo.git'],
    ['ssh://git@gitlab.com/owner/repo.git'],
    ['https://gitlab.example.com/owner/repo.git'],
    ['https://GitLab.Example.Com/owner/repo.git'],
    ['https://gitlab.example.com:443/owner/repo.git'],
    ['https://gitlab.example.com?go=1'],
  ])('%s', async (url) => {
    await expect(platform(url)).resolves.toBe('gitlab');
  });
});

describe('classifyPlatform — adversarial corpus (every spoof classifies unknown)', () => {
  it.each([
    // Host-suffix spoofs: the token is inside the host, the host is not
    // the genuine article.
    ['https://github.com.evil.example/owner/repo.git'],
    ['git@github.com.evil.example:owner/repo.git'],
    ['ssh://git@github.com.evil.example/owner/repo.git'],
    ['https://github.com.evil.example:443/owner/repo.git'],
    ['https://notgithub.com/owner/repo'],
    // Path-embedded tokens.
    ['https://evil.example/github.com/owner/repo.git'],
    ['git@evil.example:github.com/owner/repo.git'],
    ['https://evil.example/gitlab/owner/repo.git'],
    ['https://evil.example/repos/gitlab/owner/repo.git'],
    // Userinfo-embedded tokens (everything before the last '@' is credentials).
    ['https://git:github.com@evil.example/owner/repo.git'],
    ['https://github.com@evil.example/owner/repo.git'],
    ['https://github.com:443@evil.example/owner/repo.git'],
    ['ssh://git:github.com@evil.example/owner/repo.git'],
    ['https://user:gitlab@evil.example/o/r.git'],
    ['https://@evil.example/o/r.git'],
    // Query- and fragment-embedded tokens.
    ['https://evil.example/?ref=github.com'],
    ['https://evil.example/repo.git?gitlab=1'],
    ['https://evil.example/repo.git#github.com'],
    // Port variants: non-default or malformed ports are not accepted forms.
    ['https://github.com:8443/owner/repo.git'],
    ['ssh://git@github.com:2222/owner/repo.git'],
    ['https://gitlab.com:8443/owner/repo.git'],
    ['https://github.com:44x/owner/repo.git'],
    // Host charset and shape: anything outside [a-z0-9.-] fails closed,
    // as does the trailing-dot FQDN form parseRepoRef also rejects.
    ['https://gitlab$.example.com/o/r.git'],
    ['https://github.com./owner/repo.git'],
    ['https://github.com\\ .evil.example/owner/repo.git'],
    ['https://github.com\\.evil.example/owner/repo.git'],
    // A scheme-looking token inside a path/query is not a scheme.
    ['evil.example/redirect?next=https://github.com/owner/repo.git'],
    // Schemeless/bare strings are not origins.
    ['github.com'],
    ['github.com/owner/repo'],
    ['git@'],
  ])('%s', async (url) => {
    await expect(platform(url)).resolves.toBe('unknown');
  });
});

describe('classifyPlatform — malformed and empty input fails closed', () => {
  it.each([null, '', '   ', 'not-a-url', '://github.com/x', 'https://', 'file:///tmp/repo'])(
    '%j',
    async (url) => {
      await expect(platform(url)).resolves.toBe('unknown');
    }
  );
});

describe('classifyPlatform — long input is bounded', () => {
  it('rejects URLs beyond the length cap as unknown', async () => {
    const tooLong = `https://${'a'.repeat(5000)}.example.com/x`;
    expect(tooLong.length).toBeGreaterThan(4096);
    await expect(platform(tooLong)).resolves.toBe('unknown');
  });

  it('parses adversarial URLs at the cap boundary without polynomial behavior', async () => {
    const fill = (n: number) => 'a'.repeat(Math.max(0, n));
    const atCap = `https://github.com.evil.example/${fill(4096 - 'https://github.com.evil.example/'.length)}`;
    expect(atCap.length).toBe(4096);
    await expect(platform(atCap)).resolves.toBe('unknown');

    const overCap = `${atCap}a`;
    expect(overCap.length).toBe(4097);
    await expect(platform(overCap)).resolves.toBe('unknown');
  });

  it('classifies a corpus of ReDoS-shaped inputs linearly (coarse smoke, generous bound)', async () => {
    const killers = [
      `${'a'.repeat(4090)}:`,
      `${'git@'.repeat(1000)}evil.example:o/r.git`,
      `https://${'a@'.repeat(2000)}github.com.evil.example/x`,
      `https://github.com${'.evil.example'.repeat(300)}`,
      `${'a:b'.repeat(2000)}`,
      `${'['.repeat(4000)}`,
      `https://${'git:lab@'.repeat(500)}evil.example/o/r.git`,
    ];
    const started = performance.now();
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      for (const input of killers) {
        const verdict = extractOriginHost(input);
        expect(verdict === null || verdict.host !== 'github.com').toBe(true);
      }
    }
    const elapsed = performance.now() - started;
    // Generous coarse bound: a single pass over ≤4096 chars × 14k inputs
    // must stay far below this; catastrophic backtracking needs minutes.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('classifyPlatform — one pinned matrix with parseRepoRef', () => {
  it('a suffix-spoofed gitlab.com host keeps the gitlab_unsupported predicate (no capability granted)', async () => {
    // parseRepoRef's gitlab heuristic is "charset-valid host containing
    // gitlab" (gitlab_unsupported). classifyPlatform answers the same
    // predicate for this host so the two tables cannot drift apart;
    // the label grants nothing — GitLab is explicitly unsupported and a
    // declared host is re-validated with exact anchored matching.
    await expect(platform('https://gitlab.com.evil.example/o/r.git')).resolves.toBe('gitlab');
  });

  it('an undeclared self-host without the gitlab token stays unknown (declaration threading is not origin-string state)', async () => {
    await expect(platform('git@git.ycgame.com:suntao/specgit.git')).resolves.toBe('unknown');
    await expect(platform('https://git.ycgame.com/suntao/specgit.git')).resolves.toBe('unknown');
  });
});

describe('extractOriginHost — structural host facts', () => {
  it('extracts scheme, host, and port from an https URL', () => {
    expect(extractOriginHost('https://github.com:443/owner/repo.git')).toEqual({
      scheme: 'https',
      host: 'github.com',
      port: '443',
    });
  });

  it('strips userinfo (credentials) before reading the host', () => {
    expect(extractOriginHost('https://git:github.com@evil.example/owner/repo.git')).toEqual({
      scheme: 'https',
      host: 'evil.example',
      port: null,
    });
    expect(extractOriginHost('HTTPS://GITHUB.COM/Owner/Repo')).toEqual({
      scheme: 'https',
      host: 'github.com',
      port: null,
    });
  });

  it('reads the scp form as scheme-less with no port', () => {
    expect(extractOriginHost('git@github.com:owner/repo.git')).toEqual({
      scheme: null,
      host: 'github.com',
      port: null,
    });
  });

  it('stops the authority at path, query, and fragment delimiters', () => {
    expect(extractOriginHost('https://evil.example/?ref=github.com')?.host).toBe('evil.example');
    expect(extractOriginHost('https://evil.example/repo.git#github.com')?.host).toBe('evil.example');
  });

  it('caps host length at 255 characters', () => {
    const atCap = `https://${'a'.repeat(255)}/x`;
    expect(extractOriginHost(atCap)?.host.length).toBe(255);
    const overCap = `https://${'a'.repeat(256)}/x`;
    expect(extractOriginHost(overCap)).toBeNull();
  });

  it('caps URL length at 4096 characters', () => {
    const pad = (url: string, total: number) => url + 'a'.repeat(total - url.length);
    expect(extractOriginHost(pad('https://evil.example/', 4096))?.host).toBe('evil.example');
    expect(extractOriginHost(pad('https://evil.example/', 4097))).toBeNull();
  });

  it.each([
    ['https://github.com:44x/a'],
    ['https://github.com:/a'],
    ['https://github.com:123456/a'],
    ['https://github.com:443:22/a'],
    ['https:///path'],
    ['https://:443/x'],
    ['ht%tps://github.com/x'],
    ['1https://github.com/x'],
    ['github.com/o/r'],
    ['git@'],
  ])('fails closed for %s', (url) => {
    expect(extractOriginHost(url)).toBeNull();
  });
});
