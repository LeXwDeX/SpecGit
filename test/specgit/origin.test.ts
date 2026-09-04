import { describe, expect, it } from 'vitest';

import {
  formatRepoRef,
  parsePrUrl,
  parseRepoRef,
  type RepoRef,
  sameRepoRef,
} from '../../src/gitfacts/origin.js';

describe('parseRepoRef', () => {
  it.each([
    'https://audit-user:sentinel-password@example.invalid/o/r.git',
    'https://github.com/o/r?token=sentinel-password',
    'https://github.com/o/r#sentinel-password',
    'https://audit-user:sentinel-password@' + 'x'.repeat(4100),
  ])('keeps rejected URL secrets out of diagnostics', (url) => {
    for (const result of [parseRepoRef(url), parsePrUrl(url)]) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('sentinel-password');
      expect(JSON.stringify(result)).not.toContain('audit-user');
    }
  });

  it.each(['git@gitlab.com:group/repo.git', 'git@gitlab.com:group/sub/repo.git'])(
    'explains the missing declaration for %s without denying implemented support', (url) => {
      const result = parseRepoRef(url);
      expect(result).toMatchObject({ ok: false, code: 'gitlab_unsupported' });
      if (result.ok) return;
      expect(result.message).toContain('not declared');
      expect(result.message).not.toContain('not implemented');
      expect(result.fix).toContain('specgit init --gitlab-host');
      expect(result.fix).not.toContain('roadmap');
    }
  );
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
    // #186: github refs carry the explicit platform marker — the parse
    // layer always fills it, so routing can match exhaustively.
    expect(result.value).toEqual({ ...expected, platform: 'github' });
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

  // #112: a declared host resolves (the origin grammar accepts its
  // paths); the ref carries the gitlab platform marker so gh-only
  // consumers can route instead of handing a group path to gh.
  it('resolves a configured self-hosted gitlab host with the gitlab platform marker (#112)', () => {
    for (const url of [
      'git@git.ycgame.com:suntao/specgit.git',
      'ssh://git@git.ycgame.com/suntao/specgit.git',
      'https://git.ycgame.com/suntao/specgit.git',
    ]) {
      const result = parseRepoRef(url, { gitlabHost: 'git.ycgame.com' });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toEqual({ owner: 'suntao', repo: 'specgit', platform: 'gitlab' });
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
    expect(
      sameRepoRef(
        { owner: 'LeXwDeX', repo: 'SpecGit', platform: 'github' },
        { owner: 'lexwdex', repo: 'specgit', platform: 'github' }
      )
    ).toBe(true);
    expect(
      sameRepoRef(
        { owner: 'a', repo: 'b', platform: 'github' },
        { owner: 'a', repo: 'c', platform: 'github' }
      )
    ).toBe(false);
  });

  it('formats owner/repo', () => {
    expect(formatRepoRef({ owner: 'o', repo: 'r', platform: 'github' })).toBe('o/r');
  });

  // #186: compile-time lock — `platform` is a REQUIRED union of the
  // supported platforms. Either regression (an optional field or a
  // narrowed/widened union) fails the typecheck, not just the suite.
  it('RepoRef.platform is a required union of the supported platforms (#186)', () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
      ? true
      : false;
    const requiredCheck: Same<Required<RepoRef>, RepoRef> = true;
    const unionCheck: Same<RepoRef['platform'], 'github' | 'gitlab'> = true;
    expect(requiredCheck && unionCheck).toBe(true);
    const github: RepoRef = { owner: 'o', repo: 'r', platform: 'github' };
    const gitlab: RepoRef = { owner: 'o', repo: 'r', platform: 'gitlab' };
    expect(github.platform).toBe('github');
    expect(gitlab.platform).toBe('gitlab');
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

  it('declared-host nested origins resolve on all three accepted forms (#112)', () => {
    const resolves = (url: string) => {
      const result = parseRepoRef(url, { gitlabHost: 'git.ycgame.com' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.platform).toBe('gitlab');
    };
    resolves('git@git.ycgame.com:ycgame/General-Framework-Background-Operations/main_art-ai.git');
    resolves('ssh://git@git.ycgame.com/ycgame/Operations/main_art-ai.git');
    resolves('https://git.ycgame.com/ycgame/Operations/main_art-ai.git');
    resolves('https://git.ycgame.com/deep/a/b/c/project.git');
    const nested = parseRepoRef('https://git.ycgame.com/ycgame/Operations/main_art-ai.git', {
      gitlabHost: 'git.ycgame.com',
    });
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.value.owner).toBe('ycgame/Operations');
      expect(nested.value.repo).toBe('main_art-ai');
    }
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
    // declared GitLab hosts with a portless declaration: default ports in;
    // #112 — the declaration resolves the ref (platform gitlab).
    resolves('https://git.example.com:443/o/r', { gitlabHost: 'git.example.com' });
    resolves('ssh://git@git.example.com:22/o/r', { gitlabHost: 'git.example.com' });
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

  it('a declared non-default port resolves only its exact host:port (#112)', () => {
    resolves('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:8443' });
    resolves('ssh://git@git.example.com:2222/o/r', { gitlabHost: 'git.example.com:2222' });
    // the portless origin is a different effective port: fail closed
    unresolvable('https://git.example.com/o/r', { gitlabHost: 'git.example.com:8443' });
    unresolvable('https://git.example.com:443/o/r', { gitlabHost: 'git.example.com:8443' });
    // declaring a scheme default accepts the portless form of that scheme only
    resolves('https://git.example.com/o/r', { gitlabHost: 'git.example.com:443' });
    resolves('ssh://git@git.example.com/o/r', { gitlabHost: 'git.example.com:22' });
    unresolvable('https://git.example.com/o/r', { gitlabHost: 'git.example.com:2222' });
    // scp implies the ssh default port: a :22 (or portless) declaration
    // matches, any other declared port does not
    resolves('git@git.example.com:o/r', { gitlabHost: 'git.example.com' });
    resolves('git@git.example.com:o/r', { gitlabHost: 'git.example.com:22' });
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
    // nested-group paths on port-bearing declared hosts resolve (#112)
    resolves('https://git.example.com:8443/g/s/p.git', { gitlabHost: 'git.example.com:8443' });
    resolves('ssh://git@git.example.com:22/g/s/p.git', { gitlabHost: 'git.example.com' });
  });

  it('malformed declarations never match (fail closed)', () => {
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:84x3' });
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:' });
    unresolvable('https://git.example.com:8443/o/r', { gitlabHost: 'git.example.com:8443:9' });
    unresolvable('https://git.example.com/o/r', { gitlabHost: 'git example.com' });
  });
});

// #112: on a DECLARED host (spec_git/providers.yaml), the origin grammar
// accepts group[/subgroup…]/project paths at depth 2–5, including
// URL-encoded %2F separator forms; the ref carries platform 'gitlab' so
// consumers route by the declaration (never the substring heuristic —
// heuristic *gitlab* hosts gain no acceptance). Deeper paths and other
// percent-escapes fail closed; the GitHub truth table is untouched.
describe('parseRepoRef — nested-group acceptance on declared hosts (#112)', () => {
  const resolves = (url: string, options?: { gitlabHost?: string }) => {
    const result = parseRepoRef(url, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return null;
    return result.value;
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
  const declared = { gitlabHost: 'git.example.com' } as const;

  it('accepts group/subgroup/project at every depth 2–5 on all three forms', () => {
    expect(resolves('https://git.example.com/g/p.git', declared)).toEqual({
      owner: 'g',
      repo: 'p',
      platform: 'gitlab',
    });
    expect(resolves('git@git.example.com:g/sg/p.git', declared)).toEqual({
      owner: 'g/sg',
      repo: 'p',
      platform: 'gitlab',
    });
    expect(resolves('ssh://git@git.example.com/g/sg/p.git', declared)).toEqual({
      owner: 'g/sg',
      repo: 'p',
      platform: 'gitlab',
    });
    expect(resolves('https://git.example.com/g/sg/sub/p.git', declared)).toEqual({
      owner: 'g/sg/sub',
      repo: 'p',
      platform: 'gitlab',
    });
    expect(resolves('git@git.example.com:g/sg/sub/deep/p.git', declared)).toEqual({
      owner: 'g/sg/sub/deep',
      repo: 'p',
      platform: 'gitlab',
    });
    // trailing slash on the url track and no .git suffix both resolve
    expect(resolves('https://git.example.com/g/sg/p/', declared)).toEqual({
      owner: 'g/sg',
      repo: 'p',
      platform: 'gitlab',
    });
  });

  it('decodes %2F separators (both letter cases) to the same refs', () => {
    expect(resolves('https://git.example.com/group%2Fsubgroup%2Fproject.git', declared)).toEqual({
      owner: 'group/subgroup',
      repo: 'project',
      platform: 'gitlab',
    });
    expect(resolves('ssh://git@git.example.com/a%2fb%2fc.git', declared)).toEqual({
      owner: 'a/b',
      repo: 'c',
      platform: 'gitlab',
    });
    expect(resolves('git@git.example.com:g%2Fs%2Fp.git', declared)).toEqual({
      owner: 'g/s',
      repo: 'p',
      platform: 'gitlab',
    });
    // literal and encoded separators mix freely
    expect(resolves('https://git.example.com/group/sub%2Fproject.git', declared)).toEqual({
      owner: 'group/sub',
      repo: 'project',
      platform: 'gitlab',
    });
  });

  it('depth > 5 on a declared host fails closed as gitlab_unsupported naming the bound', () => {
    const result = parseRepoRef('https://git.example.com/a/b/c/d/e/f.git', declared);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_unsupported');
    expect(result.message).toContain('depth');
    expect(result.fix).not.toMatch(/github\.com/);
  });

  it('declared hosts never accept other percent-escapes or malformed paths', () => {
    // a non-%2F escape anywhere in the path never classifies
    unresolvable('https://git.example.com/g/p%20q.git', declared);
    unresolvable('https://git.example.com/g%252Fs/p.git', declared);
    // %2F decoding that yields empty segments is malformed
    unresolvable('https://git.example.com/g%2F%2Fp.git', declared);
    unresolvable('https://git.example.com/%2Fp.git', declared);
    // depth 1 is not a project path
    unresolvable('https://git.example.com/g.git', declared);
    // scp port-intent shape stays rejected (first segment all digits)
    unresolvable('git@git.example.com:8443/g/s/p.git', declared);
  });

  it('heuristic *gitlab* hosts never gain acceptance at any depth', () => {
    gitlab('https://gitlab.com/g/p.git');
    gitlab('git@gitlab.com:g/sg/p.git');
    gitlab('https://gitlab.com/a/b/c/d/e/f/g/h.git');
    // %2F forms on a heuristic host classify gitlab_unsupported (nested),
    // never unresolvable-with-github-advice and never ok
    gitlab('https://gitlab.example.com/g%2Fs%2Fp.git');
  });

  it('undeclared hosts keep origin_unresolvable including %2F forms', () => {
    unresolvable('https://git.undeclared.com/g/sg/p.git', declared);
    unresolvable('https://git.undeclared.com/g%2Fsg%2Fp.git', declared);
    unresolvable('git@git.undeclared.com:g%2Fs%2Fp.git', declared);
  });

  it('github keeps the pinned grammar: no nested paths, no %2F decoding, explicit github marker', () => {
    unresolvable('https://github.com/g/sg/p.git');
    unresolvable('https://github.com/o%2Fr.git');
    const plain = parseRepoRef('https://github.com/o/r');
    expect(plain.ok).toBe(true);
    // #186: github refs carry the marker explicitly — never undefined.
    if (plain.ok) expect(plain.value.platform).toBe('github');
  });

  it('the spoof corpus stays closed on the declared nested grammar', () => {
    unresolvable('git@git.example.com.evil.com:g/sg/p.git', declared);
    unresolvable('https://git.example.com.evil.com/g%2Fs%2Fp.git', declared);
    unresolvable('ssh://bob@git.example.com/g/sg/p.git', declared);
    unresolvable('https://git@git.example.com/g/p.git', declared);
    unresolvable('ssh://git:pw@git.example.com/g/p.git', declared);
    unresolvable('https://git.example.com/g/s/p.git?goto=github.com', declared);
  });

  it('port rules compose with the nested grammar', () => {
    expect(
      resolves('https://git.example.com:8443/g/sg/p.git', { gitlabHost: 'git.example.com:8443' })
    ).toEqual({ owner: 'g/sg', repo: 'p', platform: 'gitlab' });
    expect(
      resolves('ssh://git@git.example.com:22/g/sg/p.git', { gitlabHost: 'git.example.com' })
    ).toEqual({ owner: 'g/sg', repo: 'p', platform: 'gitlab' });
    // portless declaration still rejects the non-default port
    unresolvable('https://git.example.com:8443/g/sg/p.git', declared);
  });

  it('.git strips once, only from the project segment', () => {
    expect(resolves('https://git.example.com/g/sg/p.git.git', declared)).toEqual({
      owner: 'g/sg',
      repo: 'p.git',
      platform: 'gitlab',
    });
    expect(resolves('git@git.example.com:g/sg/.git', declared)).toEqual({
      owner: 'g/sg',
      repo: '.git',
      platform: 'gitlab',
    });
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
    if (r443.ok) expect(r443.value).toEqual({ owner: 'o', repo: 'r', platform: 'github' });

    const mixedCase = parseRepoRef('git@GitHub.com:o/r');
    expect(mixedCase.ok).toBe(true);
    if (mixedCase.ok) expect(mixedCase.value).toEqual({ owner: 'o', repo: 'r', platform: 'github' });

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
    if (doubled.ok) expect(doubled.value).toEqual({ owner: 'o', repo: 'r.git', platform: 'github' });

    const bare = parseRepoRef('https://github.com/o/.git');
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.value).toEqual({ owner: 'o', repo: '.git', platform: 'github' });
  });

  it('pins declared-host matching: exact, user-tolerant, spoof-proof (#112 resolves)', () => {
    const resolves = (url: string, options?: { gitlabHost?: string }) => {
      const result = parseRepoRef(url, options);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.platform).toBe('gitlab');
    };
    resolves('git@git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    resolves('Git@git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    resolves('git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    resolves('ssh://git@git.ycgame.com/o/r', { gitlabHost: 'git.ycgame.com' });
    resolves('https://GIT.YCGAME.COM/o/r', { gitlabHost: 'GIT.YCGAME.COM' });
    // non-github.com suffixes never match the declaration
    unresolvable('git@git.ycgame.com.evil.com:o/r', { gitlabHost: 'git.ycgame.com' });
    unresolvable('git@sourceforge.git.ycgame.com:o/r', { gitlabHost: 'git.ycgame.com' });
    // a declared host never captures the github.com exact match
    const githubWins = parseRepoRef('git@github.com:o/r', { gitlabHost: 'git.ycgame.com' });
    expect(githubWins.ok).toBe(true);
    if (githubWins.ok) expect(githubWins.value.platform).toBe('github');
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

// #112: the shared guard for GitHub-only evidence flows (the production
// #117: the GitHub-only route guard (requireGithubRoute, #112) retired —
// evaluation and the gh-backed commands now route through the platform
// routing provider (src/providers/routing.ts), which dispatches on the
// platform marker so a group/subgroup ref never reaches the gh adapter.
// The routing behavior is pinned by test/specgit/routing-provider.test.ts
// and the #117 e2e; the parse-level gitlab_unsupported shapes (undeclared
// host, too-deep path) are pinned above.

describe('parsePrUrl', () => {
  it('parses a canonical github.com PR URL', () => {
    const result = parsePrUrl('https://github.com/LeXwDeX/SpecGit/pull/42');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repo).toEqual({ owner: 'LeXwDeX', repo: 'SpecGit', platform: 'github' });
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
