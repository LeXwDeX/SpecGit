import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import {
  createFakeGlab,
  readFakeGlabCalls,
  readFakeGlabStdin,
  type FakeGlabRule,
} from './helpers/fake-glab.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

// Nested-group ref (#112 grammar): the full group path is the owner, so
// the API-side :id is the %2F-encoded full path (ledger row 4).
const REPO = { owner: 'group/subgroup', repo: 'project', platform: 'gitlab' } as const;
const PROJECT_ID = 'group%2Fsubgroup%2Fproject';
const HOST = 'git.example.com';
const SHA = 'a'.repeat(40);
const MERGE_SHA = 'm'.repeat(40);

function metadataJson(version: string | undefined): string {
  return JSON.stringify(
    version === undefined ? { revision: '06e8d813296' } : { version, revision: '06e8d813296', enterprise: false }
  );
}

describe('glab command resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-resolve-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('SPECGIT_GLAB pointing at a node-shebang script executes through node', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: '^--version$', stdout: 'glab version 1.113.0\n' },
      { match: '^auth status$', stdout: 'Logged in to gitlab.com\n' },
      { match: '^api /metadata$', stdout: metadataJson('19.5.1-ee') },
    ]);
    // The injected env carries only the fake's config — no SPECGIT_GLAB —
    // so command resolution must fall through to the process-level
    // override set below.
    const provider = new GlabProvider({ env: { FAKE_GLAB_CONFIG: fake.configPath } });
    const prev = process.env.SPECGIT_GLAB;
    process.env.SPECGIT_GLAB = path.join(fake.binDir, 'fake-glab.cjs');
    try {
      const result = await provider.preflight();
      expect(result).toEqual({ ok: true, value: { authenticated: true } });
    } finally {
      if (prev === undefined) delete process.env.SPECGIT_GLAB;
      else process.env.SPECGIT_GLAB = prev;
    }
  });

  it('a node-shebang script passed as glabCommand runs identically', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: '^--version$', stdout: 'glab version 1.113.0\n' },
      { match: '^auth status$', stdout: 'Logged in to gitlab.com\n' },
      { match: '^api /metadata$', stdout: metadataJson('19.5.1-ee') },
    ]);
    const provider = new GlabProvider({
      glabCommand: path.join(fake.binDir, 'fake-glab.cjs'),
      env: fake.env(),
    });
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
  });
});

describe('GlabProvider#preflight', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(
    rules: FakeGlabRule[],
    providerOptions: {
      timeoutMs?: number;
      maxBuffer?: number;
      env?: NodeJS.ProcessEnv;
      hostname?: string;
    } = {}
  ) {
    const fake = createFakeGlab(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GlabProvider({ env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }

  it('passes when glab exists, is authenticated per host, and the self-managed version is in window', async () => {
    const { provider, fake } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: `^auth status --hostname ${HOST}$`, stdout: `Logged in to ${HOST}\n` },
        { match: `^api --hostname ${HOST} /metadata$`, stdout: metadataJson('19.2.4-ee') },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      '--version',
      `auth status --hostname ${HOST}`,
      `api --hostname ${HOST} /metadata`,
    ]);
  });

  it('accepts a CE channel marker: bare 19.2.4 and the -ee suffix both pass (ledger rule 4)', async () => {
    for (const version of ['19.2.4', '19.2.4-ee', '19.2.4-ce']) {
      const { provider } = setup(
        [
          { match: '^--version$', stdout: 'glab version 1.113.0\n' },
          { match: '^auth status --hostname', stdout: 'ok\n' },
          { match: '^api --hostname .* /metadata$', stdout: metadataJson(version) },
        ],
        { hostname: HOST }
      );
      const result = await provider.preflight();
      // Naive semver ordering ranks 19.2.4-ee BELOW 19.2.4 and would
      // exclude the channel marker — the suffix must be stripped first.
      expect(result, version).toEqual({ ok: true, value: { authenticated: true } });
    }
  });

  it('fails closed with gitlab_version_unsupported above the window (>= 19.3.0)', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', stdout: metadataJson('19.3.0') },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_version_unsupported');
    expect(result.message).toContain('19.3.0');
    expect(result.fix).toContain('19.2');
  });

  it('fails closed with gitlab_version_unsupported below the window (< 19.2.4)', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', stdout: metadataJson('19.2.3-ee') },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gitlab_version_unsupported');
    expect(result.message).toContain('19.2.3');
  });

  it('fails closed with gitlab_version_unsupported when the version is missing or unparsable', async () => {
    // Both bodies are valid JSON metadata payloads whose version cannot be
    // verified inside the window — never an inferred capability.
    for (const body of [metadataJson(undefined), JSON.stringify({ revision: '06e8d813296' })]) {
      const { provider } = setup(
        [
          { match: '^--version$', stdout: 'glab version 1.113.0\n' },
          { match: '^auth status --hostname', stdout: 'ok\n' },
          { match: '^api --hostname .* /metadata$', stdout: body },
        ],
        { hostname: HOST }
      );
      const result = await provider.preflight();
      expect(result.ok, body).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('gitlab_version_unsupported');
    }
  });

  it('never version-pins GitLab.com (SaaS): any version passes, metadata still probed (#93)', async () => {
    const { provider, fake } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname gitlab.com$', stdout: 'Logged in to gitlab.com\n' },
        { match: '^api --hostname gitlab.com /metadata$', stdout: metadataJson('19.9.0-ee') },
      ],
      { hostname: 'gitlab.com' }
    );
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
    expect(readFakeGlabCalls(fake.logPath)).toContain('api --hostname gitlab.com /metadata');
  });

  it('without a declared host, auth and metadata use glab default context (SaaS semantics)', async () => {
    const { provider, fake } = setup([
      { match: '^--version$', stdout: 'glab version 1.113.0\n' },
      { match: '^auth status$', stdout: 'Logged in to gitlab.com\n' },
      { match: '^api /metadata$', stdout: metadataJson('20.1.0-pre') },
    ]);
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual(['--version', 'auth status', 'api /metadata']);
  });

  it('fails closed with glab_missing when glab is not on PATH', async () => {
    const emptyBin = path.join(tempDir, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const provider = new GlabProvider({ hostname: HOST, env: { PATH: emptyBin } });
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_missing');
  });

  it('fails closed with glab_unauthenticated on auth-status exit 1 and never leaks token output', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        {
          match: '^auth status --hostname',
          exit: 1,
          stderr: 'Token: glpat-SUPERSECRETTOKEN123\nno token for host\n',
        },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_unauthenticated');
    expect(JSON.stringify(result)).not.toContain('glpat-SUPERSECRETTOKEN123');
  });

  it('classifies an auth-status timeout as glab_transport, not glab_unauthenticated', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', delayMs: 20_000, stdout: 'ok\n' },
      ],
      { hostname: HOST, timeoutMs: 1000 }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('auth check failed');
  });

  it('classifies a non-auth auth-status exit code as glab_transport', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', exit: 2, stderr: 'fatal: glab crashed\n' },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('auth check failed');
  });

  it('classifies a metadata transport failure as glab_transport', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', exit: 1, stderr: 'glab: 502 Bad Gateway\n' },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('kills a slow metadata call at the timeout and reports glab_transport with the SPECGIT_GLAB_TIMEOUT_MS knob', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', delayMs: 5000, stdout: metadataJson('19.2.4') },
      ],
      { hostname: HOST, timeoutMs: 250 }
    );
    const started = Date.now();
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('250 ms');
    expect(result.fix).toContain('SPECGIT_GLAB_TIMEOUT_MS');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('SPECGIT_GLAB_TIMEOUT_MS raises the default timeout', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', delayMs: 2000, stdout: metadataJson('19.2.4') },
      ],
      { hostname: HOST, env: { SPECGIT_GLAB_TIMEOUT_MS: '10000' } as NodeJS.ProcessEnv }
    );
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
  });
});

describe('GlabProvider#getIssue', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-issue-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }

  it('parses an issue fact: iid→number, opened→open, never a pull request', async () => {
    const { provider, fake } = setup([
      {
        match: `^api --hostname ${HOST} projects/${PROJECT_ID}/issues/7$`,
        stdout: JSON.stringify({ iid: 7, state: 'opened', title: 'the why' }),
      },
    ]);
    const result = await provider.getIssue(REPO, 7);
    expect(result).toEqual({ ok: true, value: { number: 7, state: 'open', pullRequest: false, title: 'the why' } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/issues/7`,
    ]);
  });

  it('maps the closed state', async () => {
    const { provider } = setup([
      {
        match: '/issues/7$',
        stdout: JSON.stringify({ iid: 7, state: 'closed' }),
      },
    ]);
    const result = await provider.getIssue(REPO, 7);
    expect(result).toEqual({ ok: true, value: { number: 7, state: 'closed', pullRequest: false } });
  });

  it('classifies a 404 issue lookup as issue_not_found', async () => {
    const { provider } = setup([
      { match: '/issues/99$', exit: 1, stderr: 'glab: 404 Issue Not Found\n' },
    ]);
    const result = await provider.getIssue(REPO, 99);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('issue_not_found');
  });

  it('classifies an HTTP 401 as glab_unauthenticated without leaking status text', async () => {
    const { provider } = setup([
      { match: '/issues/7$', exit: 1, stderr: 'glab: 401 Unauthorized\n' },
    ]);
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_unauthenticated');
    expect(JSON.stringify(result)).not.toContain('401');
  });

  it('kills a slow glab at the timeout and reports glab_transport', async () => {
    const { provider } = setup(
      [{ match: '/issues/7$', delayMs: 5000, stdout: '{}' }],
      { timeoutMs: 250 }
    );
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('250 ms');
  });

  it('fails closed with glab_transport on bad JSON', async () => {
    const { provider } = setup([{ match: '/issues/7$', stdout: 'not json' }]);
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('not valid JSON');
  });

  it('fails closed with glab_transport on an unexpected payload shape', async () => {
    const { provider } = setup([
      { match: '/issues/7$', stdout: JSON.stringify({ state: 'opened' }) },
    ]);
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });
});

describe('GlabProvider evidence completeness (open issues, #120 I3b / #77 mirror)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-completeness-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }

  function issuePage(
    items: Array<{ iid: number; title?: string; description?: string | null }>,
  ): string {
    return JSON.stringify(items);
  }

  it('getOpenIssues paginates to exhaustion carrying titles and bodies, open state pinned in the query', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      iid: 101 + i,
      title: `chore: filler ${101 + i}`,
      description: 'filler body',
    }));
    const page2 = [
      { iid: 9, title: 'feat: alpha why', description: 'unrelated human body' },
      { iid: 42, title: 'feat: alpha why', description: null },
    ];
    const { provider, fake } = setup([
      { match: 'issues\\?state=opened.*page=2', stdout: issuePage(page2) },
      { match: 'issues\\?state=opened', stdout: issuePage(page1) },
    ]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(102);
    expect(result.value.find((f) => f.number === 9)).toEqual({
      number: 9,
      title: 'feat: alpha why',
      body: 'unrelated human body',
    });
    // A null description is absence, never a string.
    expect(result.value.find((f) => f.number === 42)).toEqual({
      number: 42,
      title: 'feat: alpha why',
    });
    const calls = readFakeGlabCalls(fake.logPath);
    expect(calls).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/issues?state=opened&per_page=100&page=1`,
      `api --hostname ${HOST} projects/${PROJECT_ID}/issues?state=opened&per_page=100&page=2`,
    ]);
  });

  it('getOpenIssueNumbers derives from the same complete scan', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ iid: 101 + i }));
    const { provider } = setup([
      { match: 'issues\\?state=opened.*page=2', stdout: issuePage([{ iid: 42 }, { iid: 250 }]) },
      { match: 'issues\\?state=opened', stdout: issuePage(page1) },
    ]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort((a, b) => a - b)).toEqual([42, ...page1.map((i) => i.iid), 250]);
  });

  it('deduplicates a page-boundary shift between calls', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ iid: 1 + i }));
    const { provider } = setup([
      { match: 'issues\\?state=opened.*page=2', stdout: issuePage([{ iid: 100 }]) },
      { match: 'issues\\?state=opened', stdout: issuePage(page1) },
    ]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(100);
  });

  it('pins the probe call budget: a 250-issue scan is 3 list calls, zero per-issue GETs (#77)', async () => {
    const page = (from: number) =>
      Array.from({ length: 100 }, (_, i) => ({ iid: from + i, title: `chore: filler ${from + i}` }));
    const last = Array.from({ length: 50 }, (_, i) => ({ iid: 201 + i, title: `chore: filler ${201 + i}` }));
    const { provider, fake } = setup([
      { match: 'issues\\?state=opened.*page=3', stdout: issuePage(last) },
      { match: 'issues\\?state=opened.*page=2', stdout: issuePage(page(101)) },
      { match: 'issues\\?state=opened', stdout: issuePage(page(1)) },
    ]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(250);
    const calls = readFakeGlabCalls(fake.logPath);
    expect(calls.filter((c) => c.includes('issues?state=opened'))).toHaveLength(3);
    expect(calls.filter((c) => /issues\/\d/.test(c))).toHaveLength(0);
  });

  it('fails closed (evidence_truncated) at the page cap instead of silently truncating', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ iid: 101 + i }));
    const { provider, fake } = setup([{ match: 'issues\\?state=opened', stdout: issuePage(full) }]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    // The cap is 10 pages of 100; an 11th call must never be attempted.
    expect(readFakeGlabCalls(fake.logPath).filter((c) => c.includes('issues?state=opened'))).toHaveLength(10);
  });

  it('fails closed when a continuation page errors mid-list', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ iid: 101 + i }));
    const { provider } = setup([
      { match: 'issues\\?state=opened.*page=2', exit: 1, stderr: 'glab: 502 Bad Gateway\n' },
      { match: 'issues\\?state=opened', stdout: issuePage(full) },
    ]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('fails closed with glab_transport on bad JSON', async () => {
    const { provider } = setup([{ match: 'issues\\?state=opened', stdout: 'not json' }]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('fails closed with glab_transport on a timeout mid-scan', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ iid: 101 + i }));
    const { provider } = setup(
      [
        { match: 'issues\\?state=opened.*page=2', delayMs: 5000, stdout: '[]' },
        { match: 'issues\\?state=opened', stdout: issuePage(full) },
      ],
      { timeoutMs: 250 }
    );
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('classifies an HTTP 401 as glab_unauthenticated', async () => {
    const { provider } = setup([
      { match: 'issues\\?state=opened', exit: 1, stderr: 'glab: 401 Unauthorized\n' },
    ]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_unauthenticated');
  });
});

describe('GlabProvider#getPr', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-pr-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  function mrPayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      iid: 42,
      state: 'opened',
      source_branch: 'feat/123-login',
      target_branch: 'main',
      sha: SHA,
      description: 'Closes #123',
      draft: false,
      merge_commit_sha: null,
      ...overrides,
    });
  }

  it('parses an opened MR fact through the state machine (row 19)', async () => {
    const { provider } = setup([
      { match: `/merge_requests/42$`, stdout: mrPayload() },
    ]);
    const result = await provider.getPr(REPO, 42);
    expect(result).toEqual({
      ok: true,
      value: {
        number: 42,
        state: 'open',
        headBranch: 'feat/123-login',
        headSha: SHA,
        baseBranch: 'main',
        body: 'Closes #123',
        mergeCommitSha: null,
        draft: false,
      },
    });
  });

  it('maps merged with merge_commit_sha, and locked to open', async () => {
    const merged = setup([
      {
        match: `/merge_requests/43$`,
        stdout: mrPayload({ iid: 43, state: 'merged', merge_commit_sha: MERGE_SHA }),
      },
    ]);
    const mergedResult = await merged.provider.getPr(REPO, 43);
    expect(mergedResult.ok).toBe(true);
    if (mergedResult.ok) {
      expect(mergedResult.value.state).toBe('merged');
      expect(mergedResult.value.mergeCommitSha).toBe(MERGE_SHA);
    }
    const locked = setup([
      { match: `/merge_requests/44$`, stdout: mrPayload({ iid: 44, state: 'locked' }) },
    ]);
    const lockedResult = await locked.provider.getPr(REPO, 44);
    expect(lockedResult.ok).toBe(true);
    if (lockedResult.ok) expect(lockedResult.value.state).toBe('open');
  });

  it('collects the draft flag (row 18)', async () => {
    const { provider } = setup([
      { match: `/merge_requests/45$`, stdout: mrPayload({ iid: 45, draft: true, title: 'Draft: T' }) },
    ]);
    const result = await provider.getPr(REPO, 45);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.draft).toBe(true);
  });

  it('fails closed when the MR payload omits the draft flag (I0: never guess not-a-draft)', async () => {
    const payload = JSON.parse(mrPayload());
    delete payload.draft;
    const { provider } = setup([{ match: `/merge_requests/42$`, stdout: JSON.stringify(payload) }]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('rejects a non-numeric MR ref without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.getPr(REPO, 'not-a-number');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('pr_not_found');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });

  it('classifies a 404 MR lookup as pr_not_found', async () => {
    const { provider } = setup([
      { match: `/merge_requests/43$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
    ]);
    const result = await provider.getPr(REPO, 43);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('pr_not_found');
  });

  it('fails closed with glab_transport on bad JSON', async () => {
    const { provider } = setup([{ match: `/merge_requests/42$`, stdout: 'not json' }]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('classifies an HTTP 401 as glab_unauthenticated and a timeout as glab_transport', async () => {
    const unauth = setup([{ match: `/merge_requests/42$`, exit: 1, stderr: 'glab: 401 Unauthorized\n' }]);
    const unauthResult = await unauth.provider.getPr(REPO, 42);
    expect(unauthResult.ok).toBe(false);
    if (unauthResult.ok) return;
    expect(unauthResult.code).toBe('glab_unauthenticated');

    const slow = setup([{ match: `/merge_requests/42$`, delayMs: 5000, stdout: '{}' }], { timeoutMs: 250 });
    const slowResult = await slow.provider.getPr(REPO, 42);
    expect(slowResult.ok).toBe(false);
    if (slowResult.ok) return;
    expect(slowResult.code).toBe('glab_transport');
  });
});

describe('GlabProvider#getCheckRuns', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-checks-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  function jobPage(count: number): string {
    return JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        id: 1000 + i,
        name: `job-${i}`,
        status: 'success',
        allow_failure: false,
        started_at: '2026-08-20T00:00:00Z',
      }))
    );
  }

  it('chains pipelines-by-sha into per-pipeline jobs without include_retried (rows 15/16/17, #116)', async () => {
    const { provider, fake } = setup([
      {
        match: `pipelines\\?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1$`,
        stdout: JSON.stringify([{ id: 29614, iid: 342, sha: SHA, ref: 'main', status: 'failed' }]),
      },
      {
        match: 'pipelines/29614/jobs\\?per_page=100&page=1$',
        stdout: JSON.stringify([
          { id: 7, name: 'build', status: 'success', allow_failure: false, started_at: '2026-08-20T14:00:00Z' },
          { id: 8, name: 'test', status: 'failed', allow_failure: true, started_at: '2026-08-20T14:01:00Z' },
          { id: 9, name: 'deploy', status: 'running', allow_failure: false, started_at: '2026-08-20T14:02:00Z' },
          { id: 10, name: 'scan', status: 'skipped', allow_failure: false, started_at: null },
        ]),
      },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // #116 mapping (ledger rows 16/17/26): final states complete the
    // run — success/'success', failed/'failure' carrying the platform
    // allow_failure boolean — while `skipped` is absent (intentionally
    // not run: no evidence object at all) and running stays pending.
    expect(result.value).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', id: 7, startedAt: '2026-08-20T14:00:00Z' },
      { name: 'test', status: 'completed', conclusion: 'failure', allowFailure: true, id: 8, startedAt: '2026-08-20T14:01:00Z' },
      { name: 'deploy', status: 'running', conclusion: null, id: 9, startedAt: '2026-08-20T14:02:00Z' },
    ]);
    const calls = readFakeGlabCalls(fake.logPath);
    expect(calls).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1`,
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines/29614/jobs?per_page=100&page=1`,
    ]);
    for (const call of calls) {
      expect(call).not.toContain('include_retried');
    }
  });

  it('maps the whole job-status vocabulary to check-run truth (#116, ledger row 26)', async () => {
    // The status vocabulary is the closed list pinned at v19.2.4-ee
    // (doc/api/jobs.md "Job status values") plus fail-closed handling
    // of anything unknown. Final states complete the run; every other
    // status stays pending (the gate reads non-completed as pending);
    // `skipped` produces no check-run at all.
    const { provider } = setup([
      {
        match: `pipelines\\?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1$`,
        stdout: JSON.stringify([{ id: 1, sha: SHA, ref: 'main', status: 'success' }]),
      },
      {
        match: 'pipelines/1/jobs\\?per_page=100&page=1$',
        stdout: JSON.stringify([
          { id: 1, name: 'ok-soft', status: 'success', allow_failure: true, started_at: '2026-08-20T14:00:00Z' },
          { id: 2, name: 'hard-fail', status: 'failed', allow_failure: false, started_at: '2026-08-20T14:01:00Z' },
          { id: 3, name: 'aborted', status: 'canceled', allow_failure: false, started_at: '2026-08-20T14:02:00Z' },
          { id: 4, name: 'aborted-soft', status: 'canceled', allow_failure: true, started_at: '2026-08-20T14:03:00Z' },
          { id: 5, name: 'never-ran', status: 'manual', allow_failure: false, started_at: null },
          { id: 6, name: 'not-started', status: 'scheduled', allow_failure: false, started_at: null },
          { id: 7, name: 'born', status: 'created', allow_failure: false, started_at: null },
          { id: 8, name: 'waiting', status: 'waiting_for_resource', allow_failure: false, started_at: null },
          { id: 9, name: 'callback', status: 'waiting_for_callback', allow_failure: false, started_at: null },
          { id: 10, name: 'winding-down', status: 'canceling', allow_failure: false, started_at: '2026-08-20T14:04:00Z' },
          { id: 11, name: 'queued', status: 'pending', allow_failure: false, started_at: null },
          { id: 12, name: 'prep', status: 'preparing', allow_failure: false, started_at: null },
          { id: 13, name: 'busy', status: 'running', allow_failure: false, started_at: '2026-08-20T14:05:00Z' },
          { id: 14, name: 'gone', status: 'skipped', allow_failure: false, started_at: null },
          { id: 15, name: 'mystery', status: 'something-new', allow_failure: false, started_at: null },
        ]),
      },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { name: 'ok-soft', status: 'completed', conclusion: 'success', allowFailure: true, id: 1, startedAt: '2026-08-20T14:00:00Z' },
      { name: 'hard-fail', status: 'completed', conclusion: 'failure', id: 2, startedAt: '2026-08-20T14:01:00Z' },
      { name: 'aborted', status: 'completed', conclusion: 'cancelled', id: 3, startedAt: '2026-08-20T14:02:00Z' },
      // canceled + allow_failure stays gate-failing: row 17 launders
      // failure only, and the flag rides along as job-level truth.
      { name: 'aborted-soft', status: 'completed', conclusion: 'cancelled', allowFailure: true, id: 4, startedAt: '2026-08-20T14:03:00Z' },
      { name: 'never-ran', status: 'manual', conclusion: null, id: 5, startedAt: null },
      { name: 'not-started', status: 'scheduled', conclusion: null, id: 6, startedAt: null },
      { name: 'born', status: 'created', conclusion: null, id: 7, startedAt: null },
      { name: 'waiting', status: 'waiting_for_resource', conclusion: null, id: 8, startedAt: null },
      { name: 'callback', status: 'waiting_for_callback', conclusion: null, id: 9, startedAt: null },
      { name: 'winding-down', status: 'canceling', conclusion: null, id: 10, startedAt: '2026-08-20T14:04:00Z' },
      { name: 'queued', status: 'pending', conclusion: null, id: 11, startedAt: null },
      { name: 'prep', status: 'preparing', conclusion: null, id: 12, startedAt: null },
      { name: 'busy', status: 'running', conclusion: null, id: 13, startedAt: '2026-08-20T14:05:00Z' },
      // 'gone' (skipped) is absent; 'mystery' (unknown status) is
      // pending, never a pass.
      { name: 'mystery', status: 'something-new', conclusion: null, id: 15, startedAt: null },
    ]);
  });

  it('collects jobs from every pipeline for the sha across job pages (>100 jobs)', async () => {
    const secondPipelineJobs = [
      { id: 5, name: 'extra', status: 'success', allow_failure: false, started_at: '2026-08-20T15:00:00Z' },
    ];
    const { provider } = setup([
      {
        match: `pipelines\\?sha=${SHA}`,
        stdout: JSON.stringify([
          { id: 1, sha: SHA, status: 'success' },
          { id: 2, sha: SHA, status: 'failed' },
        ]),
      },
      { match: 'pipelines/1/jobs\\?per_page=100&page=2$', stdout: jobPage(3) },
      { match: 'pipelines/1/jobs', stdout: jobPage(100) },
      { match: 'pipelines/2/jobs', stdout: JSON.stringify(secondPipelineJobs) },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(100 + 3 + 1);
  });

  it('returns an empty list when the sha has no pipelines', async () => {
    const { provider } = setup([
      { match: `pipelines\\?sha=${SHA}`, stdout: '[]' },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('bounds the pipeline listing: newest-first by updated_at, one bounded page (#187)', async () => {
    // #187: the listing is bounded by recency — `order_by=updated_at`
    // `sort=desc`, one page of limit + 1 — so the job pages fetched no
    // longer scale with the sha's total pipeline history. Exactly one
    // list call happens, and every listed pipeline contributes its jobs.
    const pipelines = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      sha: SHA,
      status: 'success',
      updated_at: `2026-08-20T1${i}:00:00Z`,
    }));
    const { provider, fake } = setup([
      {
        match: `pipelines\\?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1$`,
        stdout: JSON.stringify(pipelines),
      },
      { match: 'pipelines/\\d+/jobs', stdout: JSON.stringify([
        { id: 1, name: 'job', status: 'success', allow_failure: false, started_at: '2026-08-20T14:00:00Z' },
      ]) },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(10);
    const calls = readFakeGlabCalls(fake.logPath);
    const listCalls = calls.filter((c) => c.includes(`pipelines?sha=${SHA}`));
    expect(listCalls).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1`,
    ]);
    expect(calls.filter((c) => c.includes('/jobs'))).toHaveLength(10);
  });

  it('fails closed (evidence_truncated) when the sha has more pipelines than the fetch limit (#187)', async () => {
    // Fail-closed completeness (#187): the bounded listing asks for
    // limit + 1 — an overflow proves the pipeline set continues, and a
    // silently partial job evidence set is never consumed: the verdict
    // is unknown, never a pass.
    const pipelines = Array.from({ length: 11 }, (_, i) => ({
      id: 200 + i,
      sha: SHA,
      status: 'success',
      updated_at: `2026-08-20T1${i % 10}:00:00Z`,
    }));
    const { provider, fake } = setup([
      {
        match: `pipelines\\?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1$`,
        stdout: JSON.stringify(pipelines),
      },
      { match: 'pipelines/\\d+/jobs', stdout: '[]' },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    // No job pages are fetched for a truncated pipeline set.
    expect(readFakeGlabCalls(fake.logPath).filter((c) => c.includes('/jobs'))).toHaveLength(0);
  });

  it('rejects an invalid sha without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.getCheckRuns(REPO, 'not-a-sha');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });

  it('fails closed (evidence_truncated) when job pagination hits the cap with full pages', async () => {
    const { provider, fake } = setup([
      { match: `pipelines\\?sha=${SHA}`, stdout: JSON.stringify([{ id: 1, sha: SHA, status: 'success' }]) },
      { match: 'pipelines/1/jobs', stdout: jobPage(100) },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    expect(
      readFakeGlabCalls(fake.logPath).filter((c) => c.includes('pipelines/1/jobs'))
    ).toHaveLength(10);
  });

  it('fails closed with glab_transport on bad pipeline JSON and bad job JSON', async () => {
    const badPipelines = setup([{ match: `pipelines\\?sha=${SHA}`, stdout: 'not json' }]);
    const pipelinesResult = await badPipelines.provider.getCheckRuns(REPO, SHA);
    expect(pipelinesResult.ok).toBe(false);
    if (pipelinesResult.ok) return;
    expect(pipelinesResult.code).toBe('glab_transport');

    const badJobs = setup([
      { match: `pipelines\\?sha=${SHA}`, stdout: JSON.stringify([{ id: 1, sha: SHA, status: 'success' }]) },
      { match: 'pipelines/1/jobs', stdout: 'not json' },
    ]);
    const jobsResult = await badJobs.provider.getCheckRuns(REPO, SHA);
    expect(jobsResult.ok).toBe(false);
    if (jobsResult.ok) return;
    expect(jobsResult.code).toBe('glab_transport');
  });

  it('classifies an HTTP 401 as glab_unauthenticated and a timeout as glab_transport', async () => {
    const unauth = setup([{ match: `pipelines\\?sha=${SHA}`, exit: 1, stderr: 'glab: 401 Unauthorized\n' }]);
    const unauthResult = await unauth.provider.getCheckRuns(REPO, SHA);
    expect(unauthResult.ok).toBe(false);
    if (unauthResult.ok) return;
    expect(unauthResult.code).toBe('glab_unauthenticated');

    const slow = setup(
      [{ match: `pipelines\\?sha=${SHA}`, delayMs: 5000, stdout: '[]' }],
      { timeoutMs: 250 }
    );
    const slowResult = await slow.provider.getCheckRuns(REPO, SHA);
    expect(slowResult.ok).toBe(false);
    if (slowResult.ok) return;
    expect(slowResult.code).toBe('glab_transport');
  });
});

describe('GlabProvider#createIssue', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-create-issue-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  it('creates an issue through glab api -f fields and returns {number: iid, url: web_url}', async () => {
    const { provider, fake } = setup([
      {
        match: `-X POST projects/${PROJECT_ID}/issues `,
        stdout: JSON.stringify({ iid: 8, web_url: 'https://git.example.com/group/subgroup/project/-/issues/8' }),
      },
    ]);
    const result = await provider.createIssue(REPO, 'Add strict delivery harness', 'Body with #4 ref');
    expect(result).toEqual({
      ok: true,
      value: { number: 8, url: 'https://git.example.com/group/subgroup/project/-/issues/8' },
    });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/issues -f title=Add strict delivery harness -f body=Body with #4 ref`,
    ]);
  });

  it('fails closed with glab_transport when the response is not valid JSON', async () => {
    const { provider } = setup([
      { match: '-X POST projects/.*/issues ', stdout: 'not json' },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('not valid JSON');
  });

  it('fails closed with glab_transport when the payload misses iid or web_url', async () => {
    const { provider } = setup([
      { match: '-X POST projects/.*/issues ', stdout: JSON.stringify({ iid: 8 }) },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('unexpected issue payload');
  });

  it('classifies an HTTP 401 as glab_unauthenticated without echoing status text', async () => {
    const { provider } = setup([
      { match: '-X POST projects/.*/issues ', exit: 1, stderr: 'glab: 401 Unauthorized\n' },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_unauthenticated');
    expect(JSON.stringify(result)).not.toContain('401');
  });

  it('classifies a server error as glab_transport with sanitized text', async () => {
    const { provider } = setup([
      {
        match: '-X POST projects/.*/issues ',
        exit: 1,
        stderr: '\u001b[31mglab: 500 uptime noise\u001b[0m\n',
      },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).not.toContain('\u001b');
    expect(result.message).toContain('500');
  });

  it('fails closed with glab_missing when glab is not on PATH', async () => {
    const emptyBin = path.join(tempDir, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const provider = new GlabProvider({ hostname: HOST, env: { PATH: emptyBin } });
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_missing');
  });

  it('refuses an empty title without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.createIssue(REPO, '   ', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });
});

describe('GlabProvider#addIssueComment', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-issue-comment-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[]) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env() });
    return { fake, provider };
  }

  it('posts a note through glab api -f body and returns {url}', async () => {
    const { provider, fake } = setup([
      {
        match: `-X POST projects/${PROJECT_ID}/issues/8/notes `,
        stdout: JSON.stringify({
          web_url: 'https://git.example.com/group/subgroup/project/-/issues/8#note_1',
        }),
      },
    ]);
    const result = await provider.addIssueComment(
      REPO,
      8,
      'SpecGit delivery branch: `feat/8-x` (draft pull request #9).'
    );
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://git.example.com/group/subgroup/project/-/issues/8#note_1' },
    });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/issues/8/notes -f body=SpecGit delivery branch: \`feat/8-x\` (draft pull request #9).`,
    ]);
  });

  it('fails closed with glab_transport when the payload misses the url', async () => {
    const { provider } = setup([
      { match: '-X POST projects/.*/issues/8/notes ', stdout: JSON.stringify({ id: 1 }) },
    ]);
    const result = await provider.addIssueComment(REPO, 8, 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('unexpected issue-note payload');
  });

  it('refuses an empty body without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.addIssueComment(REPO, 8, '   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });
});

describe('GlabProvider#createIssue timeout regression home', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-create-issue-slow-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  it('kills a slow glab at the timeout and reports glab_transport with the knob in the fix', async () => {
    const { provider } = setup(
      [{ match: '-X POST projects/.*/issues ', delayMs: 5000, stdout: '{}' }],
      { timeoutMs: 250 }
    );
    const started = Date.now();
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('250 ms');
    expect(result.fix).toContain('SPECGIT_GLAB_TIMEOUT_MS');
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('GlabProvider#createDraftPr', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-create-mr-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }

  it('creates a draft MR through glab api parameters and maps iid/web_url from JSON', async () => {
    const { provider, fake } = setup([
      {
        match: `-X POST projects/${PROJECT_ID}/merge_requests `,
        stdout: JSON.stringify({
          iid: 12,
          web_url: 'https://git.example.com/group/subgroup/project/-/merge_requests/12',
          draft: true,
          work_in_progress: true,
        }),
      },
    ]);
    const result = await provider.createDraftPr(
      REPO,
      'feat/4-strict-delivery-harness',
      'main',
      'Strict delivery harness',
      'Closes #4\n\nDraft body'
    );
    expect(result).toEqual({
      ok: true,
      value: { number: 12, url: 'https://git.example.com/group/subgroup/project/-/merge_requests/12' },
    });
    // Rows 6/18: no structured-output flag on glab mr create, so the
    // draft marker is the `Draft: ` title prefix on the REST create.
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/merge_requests` +
        ' -f source_branch=feat/4-strict-delivery-harness' +
        ' -f target_branch=main' +
        ' -f title=Draft: Strict delivery harness' +
        ' -f description=Closes #4\n\nDraft body',
    ]);
  });

  it('zero stdout scraping: a bare printed URL is not JSON and fails closed', async () => {
    // gh scrapes a printed pull-request URL; the glab adapter must read
    // the JSON entity only. A URL-only stdout is a transport failure,
    // never a parsed creation.
    const { provider } = setup([
      {
        match: '-X POST projects/.*/merge_requests ',
        stdout: 'https://git.example.com/group/subgroup/project/-/merge_requests/12\n',
      },
    ]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('not valid JSON');
  });

  it('fails closed when the JSON payload misses iid or web_url', async () => {
    const { provider } = setup([
      { match: '-X POST projects/.*/merge_requests ', stdout: JSON.stringify({ iid: 12 }) },
    ]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('unexpected merge request payload');
  });

  it('classifies a creation failure as glab_transport with sanitized text', async () => {
    const { provider } = setup([
      {
        match: '-X POST projects/.*/merge_requests ',
        exit: 1,
        stderr: 'glab: {"message":"500 Internal Server Error"}\n',
      },
    ]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('classifies an auth failure as glab_unauthenticated', async () => {
    const { provider } = setup([
      {
        match: '-X POST projects/.*/merge_requests ',
        exit: 1,
        stderr: 'glab: failed to authenticate: run glab auth login --hostname git.example.com\n',
      },
    ]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_unauthenticated');
  });

  it('kills a slow glab at the timeout and reports glab_transport', async () => {
    const { provider } = setup(
      [{ match: '-X POST projects/.*/merge_requests ', delayMs: 5000, stdout: '' }],
      { timeoutMs: 250 }
    );
    const started = Date.now();
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('250 ms');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('refuses an empty head without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.createDraftPr(REPO, '  ', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });
});

describe('GlabProvider#listOpenPrsByHead', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-list-mrs-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[], providerOptions: { timeoutMs?: number } = {}) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  it('lists open MRs through the source_branch filter (FU-4) and maps iid/title/web_url', async () => {
    const { provider, fake } = setup([
      {
        match: 'merge_requests\\?state=opened&source_branch=',
        stdout: JSON.stringify([
          {
            iid: 7,
            title: 'Delivery one',
            web_url: 'https://git.example.com/group/subgroup/project/-/merge_requests/7',
          },
        ]),
      },
    ]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/4-strict-delivery-harness');
    expect(result).toEqual({
      ok: true,
      value: [
        { number: 7, title: 'Delivery one', url: 'https://git.example.com/group/subgroup/project/-/merge_requests/7' },
      ],
    });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/merge_requests?state=opened&source_branch=feat%2F4-strict-delivery-harness&per_page=30`,
    ]);
  });

  it('returns an empty list when no MR matches', async () => {
    const { provider } = setup([{ match: 'merge_requests\\?state=opened', stdout: '[]\n' }]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/none');
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('fails closed with glab_transport on a non-array payload', async () => {
    const { provider } = setup([{ match: 'merge_requests\\?state=opened', stdout: '{"total": 0}\n' }]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('fails closed with glab_transport on invalid JSON', async () => {
    const { provider } = setup([{ match: 'merge_requests\\?state=opened', stdout: 'not json\n' }]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('classifies an HTTP 401 as glab_unauthenticated and a timeout as glab_transport', async () => {
    const unauth = setup([
      { match: 'merge_requests\\?state=opened', exit: 1, stderr: 'glab: 401 Unauthorized\n' },
    ]);
    const unauthResult = await unauth.provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(unauthResult.ok).toBe(false);
    if (unauthResult.ok) return;
    expect(unauthResult.code).toBe('glab_unauthenticated');

    const slow = setup(
      [{ match: 'merge_requests\\?state=opened', delayMs: 5000, stdout: '[]' }],
      { timeoutMs: 250 }
    );
    const slowResult = await slow.provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(slowResult.ok).toBe(false);
    if (slowResult.ok) return;
    expect(slowResult.code).toBe('glab_transport');
  });
});

describe('GlabProvider branch protection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-protection-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[]) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env() });
    return { fake, provider };
  }

  it('reports a protected branch without fabricating required checks (Free tier, row 20)', async () => {
    const { provider } = setup([
      {
        match: `protected_branches/main$`,
        stdout: JSON.stringify({
          name: 'main',
          push_access_levels: [{ access_level: 40 }],
          merge_access_levels: [{ access_level: 40 }],
          allow_force_push: false,
        }),
      },
    ]);
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
  });

  it('reports an unprotected branch from a 404 as protected=false', async () => {
    const { provider } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
    ]);
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result).toEqual({ ok: true, value: { protected: false, requiredChecks: [] } });
  });

  it('maps other lookup failures to glab_transport', async () => {
    const { provider } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 403 Forbidden\n' },
    ]);
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('enables protection: sets the pipeline gate, then protects with integer access levels', async () => {
    const { provider, fake } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
      {
        match: `-X PATCH projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
      {
        match: `-X POST projects/${PROJECT_ID}/protected_branches `,
        stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
      },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
      `api --hostname ${HOST} -X PATCH projects/${PROJECT_ID} -f only_allow_merge_if_pipeline_succeeds=true`,
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/protected_branches -f name=main -f push_access_level=40 -f merge_access_level=40 -f unprotect_access_level=40`,
    ]);
  });

  it('is idempotent: an already-protected branch sets the gate but never re-POSTs', async () => {
    const { provider, fake } = setup([
      {
        match: `protected_branches/main$`,
        stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
      },
      {
        match: `-X PATCH projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    const calls = readFakeGlabCalls(fake.logPath);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes('-X POST projects/'))).toBe(false);
  });

  it('a failed POST protection reports the error, never a fabricated fact', async () => {
    const { provider } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
      {
        match: `-X PATCH projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
      { match: `-X POST projects/${PROJECT_ID}/protected_branches `, exit: 1, stderr: 'glab: 422\n' },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('refuses an empty branch or check without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.enableBranchProtection(REPO, ' ', 'check');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });
});

describe('GlabProvider requiredChecks — the verified pipeline-gate intersection (#116)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-required-checks-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  const POLICY_CHECKS = ['build', 'lint', 'SpecGit Acceptance'];

  function projectJson(gate: boolean): string {
    return JSON.stringify({
      id: 1278,
      path_with_namespace: 'group/subgroup/project',
      only_allow_merge_if_pipeline_succeeds: gate,
    });
  }

  function setup(
    rules: FakeGlabRule[],
    options: { requiredChecks?: readonly string[] } = {}
  ) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({
      hostname: HOST,
      env: fake.env(),
      ...(options.requiredChecks === undefined ? {} : { requiredChecks: options.requiredChecks }),
    });
    return { fake, provider };
  }

  it('reports the policy ∩ latest-ref-pipeline job names when the gate is on (rows 7/25)', async () => {
    const { provider, fake } = setup(
      [
        {
          match: `protected_branches/main$`,
          stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
        },
        { match: `projects/${PROJECT_ID}$`, stdout: projectJson(true) },
        {
          match: `pipelines\\?ref=main&per_page=1&page=1$`,
          stdout: JSON.stringify([{ id: 29614, sha: SHA, ref: 'main', status: 'success' }]),
        },
        {
          match: 'pipelines/29614/jobs\\?per_page=100&page=1$',
          stdout: JSON.stringify([
            { id: 7, name: 'build', status: 'success', allow_failure: false },
            { id: 8, name: 'test:unit', status: 'failed', allow_failure: true },
            { id: 9, name: 'deploy', status: 'manual', allow_failure: false },
          ]),
        },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.getBranchProtection(REPO, 'main');
    // Verification is existence in the pipeline's job set — any status,
    // including a manual job that has not run; unverified names (lint,
    // SpecGit Acceptance) are never fabricated.
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: ['build'] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
      `api --hostname ${HOST} projects/${PROJECT_ID}`,
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines?ref=main&per_page=1&page=1`,
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines/29614/jobs?per_page=100&page=1`,
    ]);
    for (const call of readFakeGlabCalls(fake.logPath)) {
      expect(call).not.toContain('include_retried');
    }
  });

  it('gate off ⇒ requiredChecks [] and no pipeline reads at all (row 7)', async () => {
    const { provider, fake } = setup(
      [
        {
          match: `protected_branches/main$`,
          stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
        },
        { match: `projects/${PROJECT_ID}$`, stdout: projectJson(false) },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
      `api --hostname ${HOST} projects/${PROJECT_ID}`,
    ]);
  });

  it('gate on but no pipeline for the ref ⇒ nothing verified ⇒ requiredChecks []', async () => {
    const { provider } = setup(
      [
        {
          match: `protected_branches/main$`,
          stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
        },
        { match: `projects/${PROJECT_ID}$`, stdout: projectJson(true) },
        { match: `pipelines\\?ref=main&per_page=1&page=1$`, stdout: '[]' },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
  });

  it('without the policy list injected there is nothing to verify: [] and no gate read (#116)', async () => {
    // The intersection is policy-dependent: a caller without policy
    // context (none routes to glab until #117) gets the honest empty
    // list — the S3 behavior is pinned unchanged, no fabricated names.
    const { provider, fake } = setup([
      {
        match: `protected_branches/main$`,
        stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
      },
    ]);
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
    ]);
  });

  it('URL-encodes the ref for slash-carrying delivery branches', async () => {
    const { provider, fake } = setup(
      [
        { match: `protected_branches/feat%2F116-x$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
        { match: `projects/${PROJECT_ID}$`, stdout: projectJson(true) },
        {
          match: `pipelines\\?ref=feat%2F116-x&per_page=1&page=1$`,
          stdout: JSON.stringify([{ id: 31, sha: SHA, ref: 'feat/116-x', status: 'success' }]),
        },
        {
          match: 'pipelines/31/jobs\\?per_page=100&page=1$',
          stdout: JSON.stringify([{ id: 1, name: 'build', status: 'success', allow_failure: false }]),
        },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.getBranchProtection(REPO, 'feat/116-x');
    expect(result).toEqual({ ok: true, value: { protected: false, requiredChecks: ['build'] } });
    expect(
      readFakeGlabCalls(fake.logPath).some((c) => c.includes('pipelines?ref=feat%2F116-x'))
    ).toBe(true);
  });

  it('enableBranchProtection returns the verified intersection after enabling', async () => {
    const { provider, fake } = setup(
      [
        { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
        {
          match: `-X PATCH projects/${PROJECT_ID} `,
          stdout: projectJson(true),
        },
        {
          match: `-X POST projects/${PROJECT_ID}/protected_branches `,
          stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
        },
        { match: `projects/${PROJECT_ID}$`, stdout: projectJson(true) },
        {
          match: `pipelines\\?ref=main&per_page=1&page=1$`,
          stdout: JSON.stringify([{ id: 29614, sha: SHA, ref: 'main', status: 'success' }]),
        },
        {
          match: 'pipelines/29614/jobs\\?per_page=100&page=1$',
          stdout: JSON.stringify([
            { id: 7, name: 'build', status: 'success', allow_failure: false },
            { id: 8, name: 'SpecGit Acceptance', status: 'success', allow_failure: false },
          ]),
        },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: ['build', 'SpecGit Acceptance'] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
      `api --hostname ${HOST} -X PATCH projects/${PROJECT_ID} -f only_allow_merge_if_pipeline_succeeds=true`,
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/protected_branches -f name=main -f push_access_level=40 -f merge_access_level=40 -f unprotect_access_level=40`,
      `api --hostname ${HOST} projects/${PROJECT_ID}`,
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines?ref=main&per_page=1&page=1`,
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines/29614/jobs?per_page=100&page=1`,
    ]);
  });

  it('fails closed on a renamed project instead of silently rebinding (row 5)', async () => {
    const { provider } = setup(
      [
        {
          match: `protected_branches/main$`,
          stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
        },
        {
          match: `projects/${PROJECT_ID}$`,
          stdout: JSON.stringify({
            id: 1278,
            path_with_namespace: 'group/subgroup/renamed',
            only_allow_merge_if_pipeline_succeeds: true,
          }),
        },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toMatch(/renamed or moved/);
  });

  it('paginates the witness job list to exhaustion and fails closed at the cap (I3b)', async () => {
    const fullPage = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `job-${i}`, status: 'success', allow_failure: false }))
    );
    const { provider } = setup(
      [
        {
          match: `protected_branches/main$`,
          stdout: JSON.stringify({ name: 'main', push_access_levels: [{ access_level: 40 }] }),
        },
        { match: `projects/${PROJECT_ID}$`, stdout: projectJson(true) },
        {
          match: `pipelines\\?ref=main&per_page=1&page=1$`,
          stdout: JSON.stringify([{ id: 1, sha: SHA, ref: 'main', status: 'success' }]),
        },
        { match: 'pipelines/1/jobs', stdout: fullPage },
      ],
      { requiredChecks: POLICY_CHECKS }
    );
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
  });
});

describe('GlabProvider repo auto-merge (pipeline gate, row 7)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-automerge-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGlabRule[]) {
    const fake = createFakeGlab(tempDir, rules);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env() });
    return { fake, provider };
  }

  it('reads only_allow_merge_if_pipeline_succeeds from the project payload', async () => {
    const { provider } = setup([
      {
        match: `projects/${PROJECT_ID}$`,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: false,
        }),
      },
    ]);
    const result = await provider.getRepoAutomerge(REPO);
    expect(result).toEqual({ ok: true, value: { enabled: false } });
  });

  it('fails closed when the resolved project path no longer matches the binding (rename redirect, row 5)', async () => {
    const { provider } = setup([
      {
        match: `projects/${PROJECT_ID}$`,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/renamed/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
    ]);
    const result = await provider.getRepoAutomerge(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('renamed');
  });

  it('enables the gate via PATCH and reports the verified setting', async () => {
    const { provider, fake } = setup([
      {
        match: `-X PATCH projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
    ]);
    const result = await provider.enableRepoAutomerge(REPO);
    expect(result).toEqual({ ok: true, value: { enabled: true } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} -X PATCH projects/${PROJECT_ID} -f only_allow_merge_if_pipeline_succeeds=true`,
    ]);
  });

  it('reports enabled=false when the server response does not echo the setting', async () => {
    const { provider } = setup([
      {
        match: `-X PATCH projects/${PROJECT_ID} `,
        stdout: JSON.stringify({ id: 1278, path_with_namespace: 'group/subgroup/project' }),
      },
    ]);
    const result = await provider.enableRepoAutomerge(REPO);
    expect(result).toEqual({ ok: true, value: { enabled: false } });
  });

  it('classifies an HTTP 401 as glab_unauthenticated', async () => {
    const { provider } = setup([
      { match: `projects/${PROJECT_ID}$`, exit: 1, stderr: 'glab: 401 Unauthorized\n' },
    ]);
    const result = await provider.getRepoAutomerge(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_unauthenticated');
  });
});

describe('GlabProvider transport discipline', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-discipline-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('never invokes anything but glab subcommands', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: '^--version$', stdout: 'glab version 1.113.0\n' },
      { match: '^auth status --hostname', stdout: 'ok\n' },
      { match: '/metadata$', stdout: metadataJson('19.2.4') },
      { match: '/issues/1$', stdout: JSON.stringify({ iid: 1, state: 'opened' }) },
    ]);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env() });
    await provider.preflight();
    await provider.getIssue(REPO, 1);
    const calls = readFakeGlabCalls(fake.logPath);
    for (const call of calls) {
      expect(call).toMatch(/^(--version|auth status|api )/);
    }
  });

  it('fails closed with glab_transport when output exceeds the size cap', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: '/issues/7$', stdout: 'x'.repeat(3 * 1024 * 1024) },
    ]);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env(), maxBuffer: 100_000 });
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('stdin bodies are only read for --input calls (none today)', async () => {
    const fake = createFakeGlab(tempDir, [
      {
        match: '-X POST projects/.*/issues ',
        stdout: JSON.stringify({ iid: 8, web_url: 'https://x/-/issues/8' }),
      },
    ]);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env() });
    await provider.createIssue(REPO, 'T', 'B');
    expect(readFakeGlabStdin(fake.logPath)).toEqual([]);
  });
});
