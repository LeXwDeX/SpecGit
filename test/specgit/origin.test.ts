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
    expect(result.fix).toContain('gitlab-host');
  });

  it('keeps shorthand gitlab: refs as unresolvable', () => {
    const result = parseRepoRef('gitlab:owner/repo.git');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  });

  it('classifies a configured self-hosted gitlab host as gitlab_unsupported', () => {
    for (const url of [
      'git@git.ycgame.com:suntao/specgit.git',
      'ssh://git@git.ycgame.com/suntao/specgit.git',
      'https://git.ycgame.com/suntao/specgit.git',
    ]) {
      const result = parseRepoRef(url, { gitlabHost: 'git.ycgame.com' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('gitlab_unsupported');
    }
  });

  it('a configured gitlab host does not capture other hosts', () => {
    const result = parseRepoRef('https://git.other.com/o/r.git', {
      gitlabHost: 'git.ycgame.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  });

  it('a suffix-spoofing host stays unresolvable (anchored match)', () => {
    for (const url of [
      'git@git.ycgame.com.evil.com:o/r.git',
      'https://git.ycgame.com.evil.com/o/r.git',
      'ssh://git@git.ycgame.com.evil.com/o/r.git',
    ]) {
      const result = parseRepoRef(url, { gitlabHost: 'git.ycgame.com' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('origin_unresolvable');
    }
  });

  it('compares repo refs case-insensitively', () => {
    expect(sameRepoRef({ owner: 'LeXwDeX', repo: 'SpecGit' }, { owner: 'lexwdex', repo: 'specgit' })).toBe(true);
    expect(sameRepoRef({ owner: 'a', repo: 'b' }, { owner: 'a', repo: 'c' })).toBe(false);
  });

  it('formats owner/repo', () => {
    expect(formatRepoRef({ owner: 'o', repo: 'r' })).toBe('o/r');
  });
});

// #95: a nested-group GitLab origin (depth >= 2 subgroups, >= 3 path
// segments) is a recognized-but-unsupported platform — never a
// misdiagnosed "unresolvable" URL carrying GitHub-pointing repair
// advice. Reproduction: git.ycgame.com declared in providers.yaml with a
// three-segment scp origin reported origin_unresolvable on 0.7.1/0.7.2.
describe('parseRepoRef — nested-group GitLab origins (#95)', () => {
  const nestedGitlab = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_unsupported');
    expect(result.message).toContain('nested-group');
    expect(result.fix).not.toMatch(/github\.com/);
  };
  const unresolvable = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  };

  it('declared-host nested origins report gitlab_unsupported on all three accepted forms', () => {
    nestedGitlab('git@git.ycgame.com:ycgame/General-Framework-Background-Operations/main_art-ai.git', {
      gitlabHost: 'git.ycgame.com',
    });
    nestedGitlab('ssh://git@git.ycgame.com/ycgame/Operations/main_art-ai.git', {
      gitlabHost: 'git.ycgame.com',
    });
    nestedGitlab('https://git.ycgame.com/ycgame/Operations/main_art-ai.git', {
      gitlabHost: 'git.ycgame.com',
    });
    nestedGitlab('https://git.ycgame.com/deep/a/b/c/project.git', { gitlabHost: 'git.ycgame.com' });
  });

  it('heuristic gitlab hosts classify nested origins the same way', () => {
    nestedGitlab('git@gitlab.com:group/subgroup/project.git');
    nestedGitlab('https://gitlab.com/group/subgroup/project');
    nestedGitlab('ssh://git@gitlab.example.com/group/sub/project.git');
  });

  it('github hosts and undeclared hosts keep origin_unresolvable for nested paths', () => {
    unresolvable('https://github.com/a/b/c.git');
    unresolvable('git@github.com:a/b/c.git');
    unresolvable('https://example.com/a/b/c.git');
    unresolvable('https://git.undeclared.com/a/b/c.git', { gitlabHost: 'git.ycgame.com' });
  });

  it('malformed paths on declared GitLab hosts keep origin_unresolvable', () => {
    unresolvable('git@git.ycgame.com:only.git', { gitlabHost: 'git.ycgame.com' });
    unresolvable('git@git.ycgame.com:a//b.git', { gitlabHost: 'git.ycgame.com' });
    unresolvable('https://git.ycgame.com/', { gitlabHost: 'git.ycgame.com' });
  });

  it('the spoofing and port corpus stays intact for nested paths', () => {
    // suffix-spoofed declared host: structural host match fails
    unresolvable('git@git.ycgame.com.evil.com:a/b/c.git', { gitlabHost: 'git.ycgame.com' });
    unresolvable('https://git.ycgame.com.evil.com/a/b/c.git', { gitlabHost: 'git.ycgame.com' });
    // userinfo smuggling on the real host is still rejected (fail-closed)
    unresolvable('ssh://bob@git.ycgame.com/a/b/c.git', { gitlabHost: 'git.ycgame.com' });
    // explicit ports keep today's fail-closed rejection (#78 owns that change)
    unresolvable('https://git.ycgame.com:8443/a/b/c.git', { gitlabHost: 'git.ycgame.com' });
  });
});

// Mutation-sensitive hardening corpus for CodeQL alerts 1-4: every block
// targets a specific regression (substring classification over the raw
// URL, first-`@` scp splitting, unanchored/suffix host comparison,
// polynomial regex reintroduction) and fails if it comes back.
describe('parseRepoRef — structural host classification (security hardening)', () => {
  const unresolvable = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  };
  const gitlab = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_unsupported');
  };

  it('never matches github.com in userinfo (kills full-URL substring classification)', () => {
    unresolvable('https://github.com@evil.com/o/r');
    unresolvable('https://github.com:secret@evil.com/o/r');
    unresolvable('https://user:github.com@evil.com/o/r');
    unresolvable('https://git@github.com.evil.com@evil.com/o/r');
    // userinfo on the real host is rejected too (fail-closed)
    unresolvable('https://git@github.com/o/r');
    unresolvable('https://oauth2@github.com/o/r');
    unresolvable('ssh://github.com@evil.com/o/r');
  });

  it('never matches github.com or gitlab in the path', () => {
    unresolvable('https://evil.com/github.com/o/r');
    unresolvable('https://evil.com/some/github.com/decoy/o/r');
    unresolvable('https://evil.com/gitlab/o/r');
    unresolvable('https://evil.com/gitlab.com/owner/repo.git');
    // a real github host with a decoy "gitlab" owner stays github
    const decoy = parseRepoRef('https://github.com/gitlab/repokit');
    expect(decoy.ok).toBe(true);
  });

  it('never matches in the query or fragment', () => {
    unresolvable('https://evil.com/o/r?goto=github.com');
    unresolvable('https://evil.com/o/r?gitlab=1&x=2');
    unresolvable('https://github.com.evil.com/o/r?x=1');
    unresolvable('ssh://git@github.com/o/r?x=1');
    unresolvable('https://evil.com/o/r#github.com');
    unresolvable('https://evil.com/o/r#gitlab');
  });

  it('never matches attacker-controlled host suffixes or prefixes', () => {
    unresolvable('https://github.com.evil.com/o/r');
    unresolvable('https://github.com.evil.com/o/r.git');
    unresolvable('https://evil-github.com/o/r');
    unresolvable('git@github.com.evil.com:o/r');
    unresolvable('ssh://git@github.com.evil.com/o/r');
    // the gitlab heuristic is host-scoped, so a spoofs-with-contains host
    // still lands in the fail-closed gitlab diagnostic, never in github
    gitlab('https://gitlab.com.evil.com/o/r');
    gitlab('https://notgitlab.example.com/o/r');
  });

  it('scp userinfo cannot smuggle a host (last-@ wins, user must be git)', () => {
    unresolvable('git@gitlab.com@github.com:o/r');
    unresolvable('git@github.com@evil.com:o/r');
    unresolvable('git@bob@github.com:o/r');
    unresolvable('bob@github.com:o/r');
    unresolvable('bob@gitlab.com:o/r');
    unresolvable('ssh://bob@github.com/o/r');
    unresolvable('ssh://git:password@github.com/o/r');
  });

  it('rejects explicit non-default ports on every track', () => {
    unresolvable('https://github.com:8443/o/r');
    unresolvable('ssh://git@github.com:22/o/r');
    unresolvable('https://gitlab.com:8443/o/r');
    unresolvable('https://git.ycgame.com:8443/o/r', { gitlabHost: 'git.ycgame.com' });
    // scp syntax has no port slot: a port-looking segment breaks the
    // two-segment owner/repo shape and stays unresolvable
    unresolvable('git@gitlab.com:8443/o/r');
    unresolvable('git@git.ycgame.com:8443/o/r', { gitlabHost: 'git.ycgame.com' });
  });

  it('pins the widened shapes: default https port and normalized host case', () => {
    const r443 = parseRepoRef('https://github.com:443/o/r');
    expect(r443.ok).toBe(true);
    if (r443.ok) expect(r443.value).toEqual({ owner: 'o', repo: 'r' });

    const mixedCase = parseRepoRef('git@GitHub.com:o/r');
    expect(mixedCase.ok).toBe(true);
    if (mixedCase.ok) expect(mixedCase.value).toEqual({ owner: 'o', repo: 'r' });

    const upperSsh = parseRepoRef('SSH://Git@GitHub.COM/o/r');
    expect(upperSsh.ok).toBe(true);

    gitlab('ssh://git@GitLab.com/o/r');
    gitlab('git@GitLab.example.com:o/r');

    // the scp user itself stays case-sensitive on the generic tracks
    unresolvable('Git@github.com:o/r');
    unresolvable('GIT@gitlab.com:o/r');
  });

  it('pins path shapes per track', () => {
    unresolvable('https://github.com');
    unresolvable('ssh://git@github.com');
    unresolvable('https://github.com/o//r');
    unresolvable('https://github.com/o/r//');
    unresolvable('https://github.com/o/r/extra');
    unresolvable('git@github.com:o/r/');
    unresolvable('git@github.com:/o/r');
    unresolvable('git@github.com:');
    unresolvable('https://github.com/o%2Fonly');
  });

  it('pins .git suffix handling', () => {
    const doubled = parseRepoRef('https://github.com/o/r.git.git');
    expect(doubled.ok).toBe(true);
    if (doubled.ok) expect(doubled.value).toEqual({ owner: 'o', repo: 'r.git' });

    const bare = parseRepoRef('https://github.com/o/.git');
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.value).toEqual({ owner: 'o', repo: '.git' });
  });

  it('pins declared-host matching: exact, user-tolerant, spoof-proof', () => {
    gitlab('git@git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    gitlab('Git@git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    gitlab('git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    gitlab('ssh://git@git.ycgame.com/o/r', { gitlabHost: 'git.ycgame.com' });
    gitlab('https://GIT.YCGAME.COM/o/r', { gitlabHost: 'GIT.YCGAME.COM' });
    // non-github.com suffixes never match the declaration
    unresolvable('git@git.ycgame.com.evil.com:o/r', { gitlabHost: 'git.ycgame.com' });
    unresolvable('git@sourceforge.git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    // a declared host never captures the github.com exact match
    const githubWins = parseRepoRef('git@github.com:o/r', { gitlabHost: 'git.ycgame.com' });
    expect(githubWins.ok).toBe(true);
  });

  it('rejects oversized origins before any parsing', () => {
    unresolvable(`https://github.com/o/${'a'.repeat(5000)}`);
    unresolvable(`${'a'.repeat(5000)}:o/r`);
  });

  it('classifies long adversarial inputs within a bounded time budget', () => {
    // Inputs sized to turn the removed polynomial GitLab regexes into
    // multi-second backtracking (O(n^2): repeated `gitlab` literals plus a
    // class-breaking char; ~1.4s per old regex at repeat(20_000)); the
    // structural parser (or the length cap) must stay far inside the
    // budget.
    const hostile = [
      `https://${'a'.repeat(60_000)}.com/o/r.git`,
      `https://${'a'.repeat(30_000)}gitlab${'a'.repeat(30_000)}.com/o/r`,
      `https://github.com/${'a'.repeat(60_000)}/${'b'.repeat(60_000)}`,
      `git@${'a'.repeat(60_000)}.com:o/r.git`,
      `ssh://git@${'a'.repeat(60_000)}.com/o/r`,
      `${'a'.repeat(60_000)}:${'b'.repeat(60_000)}/c`,
      `git@gitlab.com:${'a/'.repeat(30_000)}tail`,
      `https://${'gitlab'.repeat(20_000)}!/o/r`,
      `git@${'gitlab'.repeat(20_000)}!:o/r`,
      `ssh://git@${'gitlab'.repeat(20_000)}!/o/r`,
    ];
    const start = performance.now();
    for (const url of hostile) {
      expect(parseRepoRef(url).ok).toBe(false);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
  });

  it('stays fast on sub-cap adversarial hosts (no pathological parsing)', () => {
    const subCap = `https://${'a'.repeat(4070)}.com/o/r`;
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      expect(parseRepoRef(subCap).ok).toBe(false);
    }
    expect(performance.now() - start).toBeLessThan(500);
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
