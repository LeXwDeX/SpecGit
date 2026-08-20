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
    // #78: an explicit port equal to the scheme default classifies like
    // the portless form (the https :443 case is pinned below in the
    // widened-shapes test; the ssh :22 case needs the port rules).
    ['ssh://git@github.com:22/owner/repo.git', { owner: 'owner', repo: 'repo' }],
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

// #78: explicit-port origin classification. An explicit port equal to
// the scheme default (443 for https, 22 for ssh) classifies identically
// to the portless form for github.com and GitLab hosts (heuristic or
// declared); every other explicit port stays fail-closed rejected unless
// the declaration itself names it (host:port). The spoofing surface
// (userinfo, path, query, host-suffix) must not reopen.
describe('parseRepoRef — explicit-port origin classification (#78)', () => {
  const resolves = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(true);
  };
  const gitlab = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_unsupported');
  };
  const unresolvable = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('origin_unresolvable');
  };

  it('default ports classify identically to the portless form (truth table)', () => {
    // github.com: both URL tracks accept their scheme default explicitly.
    resolves('https://github.com:443/o/r');
    resolves('ssh://git@github.com:22/o/r');
    // WHATWG URL normalization strips leading zeros: :022 is the default
    // port, not a distinct classification input.
    resolves('ssh://git@github.com:022/o/r');
    // heuristic GitLab hosts: same rule, surfaced as gitlab_unsupported.
    gitlab('https://gitlab.com:443/o/r');
    gitlab('ssh://git@gitlab.com:22/o/r');
    gitlab('https://gitlab.example.com:443/o/r');
    // declared GitLab hosts with a portless declaration: default ports in.
    gitlab('https://git.example.com:443/o/r', { gitlabHost: 'git.example.com' });
    gitlab('ssh://git@git.example.com:22/o/r', { gitlabHost: 'git.example.com' });
  });

  it('non-default ports stay fail-closed without a port declaration (:8443 undeclared still rejected)', () => {
    unresolvable('https://github.com:8443/o/r');
    unresolvable('ssh://git@github.com:2222/o/r');
    unresolvable('https://gitlab.com:8443/o/r');
    // a portless declaration names the host, not a non-default port
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com' });
    unresolvable('ssh://git@git.example.com:2222/o/r', { gitlabHost: 'git.example.com' });
    // degenerate ports never classify (0 is not a scheme default; the
    // others fail URL parsing outright)
    unresolvable('ssh://git@github.com:0/o/r');
    unresolvable('ssh://git@github.com:65536/o/r');
    unresolvable('ssh://git@github.com:22x/o/r');
  });

  it('a declared non-default port classifies only its exact host:port', () => {
    gitlab('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:8443' });
    gitlab('ssh://git@git.example.com:2222/o/r', { gitlabHost: 'git.example.com:2222' });
    // the portless origin is a different effective port: fail closed
    unresolvable('https://git.example.com/o/r', { gitlabHost: 'git.example.com:8443' });
    unresolvable('https://git.example.com:443/o/r', { gitlabHost: 'git.example.com:8443' });
    // declaring a scheme default accepts the portless form of that scheme only
    gitlab('https://git.example.com/o/r', { gitlabHost: 'git.example.com:443' });
    gitlab('ssh://git@git.example.com/o/r', { gitlabHost: 'git.example.com:22' });
    unresolvable('https://git.example.com/o/r', { gitlabHost: 'git.example.com:2222' });
    // scp implies the ssh default port: a :22 (or portless) declaration
    // matches, any other declared port does not
    gitlab('git@git.example.com:o/r', { gitlabHost: 'git.example.com' });
    gitlab('git@git.example.com:o/r', { gitlabHost: 'git.example.com:22' });
    unresolvable('git@git.example.com:o/r', { gitlabHost: 'git.example.com:8443' });
    unresolvable('git@git.example.com:o/r', { gitlabHost: 'git.example.com:443' });
    // a declared host:port never captures other hosts
    unresolvable('https://other.example.com:8443/o/r', { gitlabHost: 'git.example.com:8443' });
  });

  it('port-bearing origins keep the spoof corpus semantics', () => {
    // a default port on a spoofed suffix is still a spoofed suffix
    unresolvable('ssh://git@github.com.evil.com:22/o/r');
    unresolvable('https://github.com.evil.com:443/o/r');
    unresolvable('ssh://git@git.example.com.evil.com:2222/o/r', {
      gitlabHost: 'git.example.com:2222',
    });
    // userinfo smuggling with a default port stays rejected (fail-closed)
    unresolvable('ssh://bob@github.com:22/o/r');
    unresolvable('ssh://git:pw@github.com:22/o/r');
    unresolvable('https://git@github.com:443/o/r');
    // the github.com exact match wins over any declaration
    resolves('ssh://git@github.com:22/o/r', { gitlabHost: 'git.example.com:22' });
    // nested-group paths on port-bearing declared hosts keep #95 behavior
    gitlab('https://git.example.com:8443/g/s/p.git', { gitlabHost: 'git.example.com:8443' });
    gitlab('ssh://git@git.example.com:22/g/s/p.git', { gitlabHost: 'git.example.com' });
  });

  it('malformed declarations never match (fail closed)', () => {
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:84x3' });
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:' });
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:8443:9' });
    unresolvable('https://git.example.com/o/r', { gitlabHost: 'git example.com' });
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
    unresolvable('ssh://git@github.com:2222/o/r');
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
