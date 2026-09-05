import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { GITLAB_PIPELINE_SUCCESS_GATE } from '../../src/github/port.js';
import {
  createFakeGlab,
  readFakeGlabCalls,
  readFakeGlabStdin,
  type FakeGlab,
  type FakeGlabRule,
} from './helpers/fake-glab.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

const execFileAsync = promisify(execFile);

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

// The advisory preflight fact (#241): the flag is platform-neutral (#247).
const UNVERIFIED_PREFLIGHT = { ok: true, value: { authenticated: true, versionUnverified: true } } as const;

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

  it('accepts 19.3.x inside the widened window (#236 rebaseline)', async () => {
    for (const version of ['19.3.0', '19.3.0-ee', '19.3.0-ce']) {
      const { provider } = setup(
        [
          { match: '^--version$', stdout: 'glab version 1.113.0\n' },
          { match: '^auth status --hostname', stdout: 'ok\n' },
          { match: '^api --hostname .* /metadata$', stdout: metadataJson(version) },
        ],
        { hostname: HOST }
      );
      const result = await provider.preflight();
      expect(result, version).toEqual({ ok: true, value: { authenticated: true } });
    }
  });

  it('flags versionUnverified above the verified window (>= 19.4.0) without aborting (#241)', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', stdout: metadataJson('19.4.0') },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result).toEqual(UNVERIFIED_PREFLIGHT);
  });

  it('flags versionUnverified below the verified window (< 19.2.4) without aborting (#241)', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'glab version 1.113.0\n' },
        { match: '^auth status --hostname', stdout: 'ok\n' },
        { match: '^api --hostname .* /metadata$', stdout: metadataJson('19.2.3-ee') },
      ],
      { hostname: HOST }
    );
    const result = await provider.preflight();
    expect(result).toEqual(UNVERIFIED_PREFLIGHT);
  });

  it('flags versionUnverified when the version is missing or unparsable, without aborting (#241)', async () => {
    // Both bodies are valid JSON metadata payloads whose version cannot be
    // verified inside the window — advisory, never an abort: the live
    // evidence pass stays the fail-closed guarantee.
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
      expect(result, body).toEqual(UNVERIFIED_PREFLIGHT);
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

  it('retains the squash result as the lineage anchor after a fast-forward squash merge (#377)', async () => {
    const squashSha = 'b'.repeat(40);
    const { provider } = setup([{
      match: '/merge_requests/42$',
      stdout: mrPayload({ state: 'merged', squash_commit_sha: squashSha }),
    }]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeCommitSha).toBe(squashSha);
  });

  it('uses the frozen MR diff head for a confirmed non-squashed fast-forward merge (#377)', async () => {
    const { provider } = setup([{
      match: '/merge_requests/42$',
      stdout: mrPayload({ state: 'merged', squash_commit_sha: null, diff_refs: { head_sha: SHA } }),
    }]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeCommitSha).toBe(SHA);
  });

  it.each([
    { state: 'opened', squash_commit_sha: 'b'.repeat(40), diff_refs: { head_sha: SHA } },
    { state: 'merged', diff_refs: { head_sha: SHA } },
    { state: 'merged', squash_commit_sha: null },
    { state: 'merged', squash_commit_sha: null, diff_refs: null },
  ])('does not invent a merged anchor from incomplete or unmerged facts: %j (#377)', async (facts) => {
    const { provider } = setup([{ match: '/merge_requests/42$', stdout: mrPayload(facts) }]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeCommitSha).toBeNull();
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

  it('reports all jobs and the platform pipeline status for guarded merge (#382)', async () => {
    const { provider } = setup([
      { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'pending' } }) },
      { match: 'projects/99/pipelines/20/jobs', stdout: jobPage(1) },
      { match: 'projects/99/pipelines/20/trigger_jobs', stdout: '[]' },
    ]);
    expect(await provider.getPrChecks(REPO, 42)).toEqual({ ok: true, value: {
      headSha: SHA,
      pipelineStatus: 'pending',
      checks: [{ name: 'job-0', status: 'completed', conclusion: 'success', id: 1000, startedAt: '2026-08-20T00:00:00Z' }],
    } });
  });

  it.each(['success', 'failed', 'pending'])(
    'includes %s trigger jobs even when the parent pipeline reports success (#382)', async (status) => {
      const { provider } = setup([
        { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'success' } }) },
        { match: 'projects/99/pipelines/20/jobs', stdout: jobPage(1) },
        { match: 'projects/99/pipelines/20/trigger_jobs', stdout: JSON.stringify([
          { id: 2000, name: 'deploy-child', status, allow_failure: true, started_at: null, downstream_pipeline: null },
        ]) },
      ]);
      expect(await provider.getPrChecks(REPO, 42)).toMatchObject({ ok: true, value: {
        checks: [
          { name: 'job-0', conclusion: 'success' },
          { name: 'deploy-child', allowFailure: true,
            status: status === 'pending' ? 'pending' : 'completed',
            conclusion: status === 'success' ? 'success' : status === 'failed' ? 'failure' : null },
        ],
        pipelineStatus: 'success',
      } });
    }
  );

  it.each([
    { stdout: '[null]' },
    { stdout: '[{"id":2000,"name":"deploy-child","status":"success"}]' },
    { exit: 1, stderr: 'glab: 404 Not Found' },
  ])('fails closed when trigger-job evidence is unavailable or malformed: %j (#382)', async (response) => {
    const { provider } = setup([
      { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'success' } }) },
      { match: 'projects/99/pipelines/20/jobs', stdout: jobPage(1) },
      { match: 'projects/99/pipelines/20/trigger_jobs', ...response },
    ]);
    expect(await provider.getPrChecks(REPO, 42)).toMatchObject({ ok: false, code: 'glab_transport' });
  });

  it('exhausts trigger-job pages so a later failed trigger remains visible (#382)', async () => {
    const { provider } = setup([
      { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'success' } }) },
      { match: 'projects/99/pipelines/20/jobs', stdout: jobPage(1) },
      { match: 'trigger_jobs\\?per_page=100&page=2$', stdout: JSON.stringify([
        { id: 2000, name: 'deploy-child', status: 'failed', allow_failure: true, started_at: null, downstream_pipeline: null },
      ]) },
      { match: 'trigger_jobs\\?per_page=100&page=1$', stdout: JSON.stringify(
        JSON.parse(jobPage(100)).map((job: Record<string, unknown>) => ({ ...job, downstream_pipeline: null }))
      ) },
    ]);
    const result = await provider.getPrChecks(REPO, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checks).toHaveLength(102);
    expect(result.value.checks.at(-1)).toMatchObject({ name: 'deploy-child', conclusion: 'failure', allowFailure: true });
  });

  it.each(['failed', 'running', 'success'])(
    'reads the downstream pipeline and its allow-failure jobs when its current state is %s (#382)', async (status) => {
      const { provider } = setup([
        { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'success' } }) },
        { match: 'projects/99/pipelines/20/jobs', stdout: jobPage(1) },
        { match: 'projects/99/pipelines/20/trigger_jobs', stdout: JSON.stringify([
          { id: 2000, name: 'deploy-child', status: 'success', allow_failure: false, started_at: null,
            downstream_pipeline: { id: 30, web_url: `https://${HOST}/group/subgroup/child/${status === 'success' ? '' : '-/'}pipelines/30` } },
        ]) },
        { match: 'projects/group%2Fsubgroup%2Fchild/pipelines/30$', stdout: JSON.stringify({ id: 30, project_id: 100, sha: 'b'.repeat(40), status }) },
        { match: 'projects/100/pipelines/30/jobs', stdout: JSON.stringify([
          { id: 3000, name: 'job-0', status: 'failed', allow_failure: true, started_at: null },
        ]) },
        { match: 'projects/100/pipelines/30/trigger_jobs', stdout: '[]' },
      ]);
      const result = await provider.getPrChecks(REPO, 42);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.checks).toContainEqual(expect.objectContaining({
        name: 'downstream:100/30:job-0', conclusion: 'failure', allowFailure: true,
      }));
      expect(result.value.checks).toContainEqual(expect.objectContaining({
        name: 'downstream:100/30:pipeline',
        status: status === 'running' ? 'running' : 'completed',
        conclusion: status === 'success' ? 'success' : status === 'failed' ? 'failure' : null,
      }));
    }
  );

  it.each([
    undefined,
    { id: 30 },
    { id: 30, project_id: 100, web_url: 'https://other.example.com/group/child/-/pipelines/30' },
    { id: 30, web_url: `https://${HOST}/group/child/-/pipelines/31` },
  ])('refuses untraceable downstream identity rather than declaring all CI green: %j (#382)', async (downstream) => {
    const { provider } = setup([
      { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'success' } }) },
      { match: 'projects/99/pipelines/20/jobs', stdout: jobPage(1) },
      { match: 'projects/99/pipelines/20/trigger_jobs', stdout: JSON.stringify([
        { id: 2000, name: 'deploy-child', status: 'success', allow_failure: false, started_at: null, downstream_pipeline: downstream },
      ]) },
    ]);
    expect(await provider.getPrChecks(REPO, 42)).toMatchObject({ ok: false, code: 'glab_transport' });
  });

  it('deduplicates downstream cycles and retains evidence from nested pipelines (#382)', async () => {
    const calls: string[] = [];
    const provider = new GlabProvider({ hostname: HOST, spawnImpl: async (_command, args) => {
      const route = args.join(' ');
      calls.push(route);
      let body: unknown;
      if (route.includes('/merge_requests/')) body = { iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99, status: 'success' } };
      else if (route.endsWith('/pipelines/30')) body = { id: 30, project_id: 99, sha: SHA, status: 'success' };
      else if (route.includes('/trigger_jobs')) body = [{
        id: route.includes('/20/') ? 2000 : 3000, name: 'child', status: 'success', allow_failure: false, started_at: null,
        downstream_pipeline: { id: route.includes('/20/') ? 30 : 20, project_id: 99 },
      }];
      else body = [{ id: 1000, name: 'test', status: route.includes('/30/') ? 'failed' : 'success', allow_failure: true, started_at: null }];
      return { stdout: JSON.stringify(body), stderr: '' };
    } });
    const result = await provider.getPrChecks(REPO, 42);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.checks).toContainEqual(expect.objectContaining({ name: 'downstream:99/30:test', conclusion: 'failure' }));
    expect(calls.filter((call) => call.endsWith('/pipelines/30'))).toHaveLength(1);
    expect(calls).toHaveLength(6);
  });

  it('fails closed when a downstream graph exceeds the 32-pipeline evidence bound (#382)', async () => {
    const provider = new GlabProvider({ hostname: HOST, spawnImpl: async (_command, args) => {
      const route = args.join(' ');
      const id = Number(/\/pipelines\/(\d+)/.exec(route)?.[1] ?? 1);
      const body = route.includes('/merge_requests/')
        ? { iid: 42, sha: SHA, head_pipeline: { id: 1, sha: SHA, project_id: 99, status: 'success' } }
        : route.includes('/trigger_jobs') ? [{ id, name: 'child', status: 'success', allow_failure: false, started_at: null,
          downstream_pipeline: { id: id + 1, project_id: 99 } }]
          : /\/jobs\?/.test(route) ? [] : { id, project_id: 99, sha: SHA, status: 'success' };
      return { stdout: JSON.stringify(body), stderr: '' };
    } });
    expect(await provider.getPrChecks(REPO, 42)).toMatchObject({ ok: false, code: 'evidence_truncated' });
  });

  it.each([null, { id: 20, sha: SHA, project_id: 99 }, { id: 20, sha: SHA, project_id: 99, status: '' }])(
    'refuses guarded-merge evidence without an explicit pipeline status: %j (#382)', async (pipeline) => {
      const { provider, fake } = setup([{
        match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: pipeline }),
      }]);
      expect(await provider.getPrChecks(REPO, 42)).toMatchObject({ ok: false, code: 'glab_transport' });
      expect(readFakeGlabCalls(fake.logPath)).toHaveLength(1);
    }
  );

  it.each(['pending', 'skipped', 'canceled'])('uses only the MR head pipeline when its required job is %s (#376)', async (status) => {
    const { provider, fake } = setup([
      {
        match: '/merge_requests/42$',
        stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99 } }),
      },
      { match: 'pipelines\\?sha=', stdout: JSON.stringify([{ id: 10, sha: SHA }]) },
      { match: 'pipelines/10/jobs', stdout: jobPage(1) },
      {
        match: 'projects/99/pipelines/20/jobs',
        stdout: JSON.stringify([{ id: 200, name: 'test', status, started_at: null, allow_failure: false }]),
      },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA, 42);
    expect(result).toEqual({ ok: true, value: status === 'skipped' ? [] : [{
      id: 200,
      name: 'test',
      status: status === 'canceled' ? 'completed' : 'pending',
      conclusion: status === 'canceled' ? 'cancelled' : null,
      startedAt: null,
    }] });
    expect(readFakeGlabCalls(fake.logPath).some((call) => call.includes('/pipelines?sha='))).toBe(false);
  });

  it.each([
    null,
    { id: 1, name: 'test', status: 'success' },
    { id: 1, name: '', status: 'success', started_at: null, allow_failure: false },
    { id: 1, name: 'test', status: 'success', started_at: 'invalid', allow_failure: false },
  ])('fails closed on malformed jobs instead of supplying partial evidence: %j (#376)', async (job) => {
    const { provider } = setup([
      { match: '/merge_requests/42$', stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA, project_id: 99 } }) },
      { match: 'projects/99/pipelines/20/jobs', stdout: JSON.stringify([job]) },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA, 42);
    expect(result).toMatchObject({ ok: false, code: 'glab_transport' });
  });

  it('reports an absent MR head pipeline without borrowing a branch pipeline (#376)', async () => {
    const { provider, fake } = setup([{
      match: '/merge_requests/42$',
      stdout: JSON.stringify({ iid: 42, sha: SHA, head_pipeline: null }),
    }]);
    expect(await provider.getCheckRuns(REPO, SHA, 42)).toEqual({ ok: true, value: [] });
    expect(readFakeGlabCalls(fake.logPath)).toHaveLength(1);
  });

  it.each([
    null,
    { iid: 42, sha: SHA },
    { iid: 41, sha: SHA, head_pipeline: null },
    { iid: 42, sha: 'b'.repeat(40), head_pipeline: null },
    { iid: 42, sha: SHA, head_pipeline: {} },
    { iid: 42, sha: SHA, head_pipeline: { id: 20, sha: SHA } },
    { iid: 42, sha: SHA, head_pipeline: { id: 20, sha: 'b'.repeat(40), project_id: 99 } },
  ])('fails closed on incomplete or mismatched MR pipeline identity: %j (#376)', async (mr) => {
    const { provider, fake } = setup([{ match: '/merge_requests/42$', stdout: JSON.stringify(mr) }]);
    expect(await provider.getCheckRuns(REPO, SHA, 42)).toMatchObject({ ok: false, code: 'glab_transport' });
    expect(readFakeGlabCalls(fake.logPath)).toHaveLength(1);
  });

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

  it('exhausts the newest compatibility pipeline without filling its jobs from older pipelines (>100 jobs)', async () => {
    const olderPipelineJobs = [
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
      { match: 'pipelines/2/jobs\\?per_page=100&page=2$', stdout: jobPage(3) },
      { match: 'pipelines/2/jobs', stdout: jobPage(100) },
      { match: 'pipelines/1/jobs', stdout: JSON.stringify(olderPipelineJobs) },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(100 + 3);
    expect(result.value.some((job) => job.name === 'extra')).toBe(false);
  });

  it('returns an empty list when the sha has no pipelines', async () => {
    const { provider } = setup([
      { match: `pipelines\\?sha=${SHA}`, stdout: '[]' },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('bounds compatibility discovery and selects the highest pipeline id independent of response order (#376)', async () => {
    // #187: the listing is bounded by recency — `order_by=updated_at`
    // `sort=desc`, one page of limit + 1 — so the job pages fetched no
    // longer scale with the sha's total pipeline history. Exactly one
    // list call happens, and only the highest id contributes its jobs.
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
    expect(result.value).toHaveLength(1);
    const calls = readFakeGlabCalls(fake.logPath);
    const listCalls = calls.filter((c) => c.includes(`pipelines?sha=${SHA}`));
    expect(listCalls).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines?sha=${SHA}&order_by=updated_at&sort=desc&per_page=11&page=1`,
    ]);
    expect(calls.filter((c) => c.includes('/jobs'))).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/pipelines/109/jobs?per_page=100&page=1`,
    ]);
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
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/issues -f title=Add strict delivery harness -f description=Body with #4 ref`,
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

  it('adopts the original note after a successful POST loses its response (#380)', async () => {
    const body = 'SpecGit delivery branch: `fix/380-retry` (draft pull request #42).';
    const notes: Array<{ id: number; body: string }> = [];
    let posts = 0;
    const provider = new GlabProvider({ hostname: HOST, spawnImpl: async (_command, args) => {
      if (args.includes('POST')) {
        posts += 1;
        notes.push({ id: 91, body });
        throw Object.assign(new Error('response lost'), { code: 1, stderr: 'connection reset' });
      }
      return { stdout: JSON.stringify(notes), stderr: '' };
    } });
    expect(await provider.addIssueComment(REPO, 8, body)).toMatchObject({ ok: false, code: 'glab_transport' });
    expect(await provider.addIssueComment(REPO, 8, body)).toEqual({
      ok: true, value: { url: 'https://git.example.com/group/subgroup/project/-/issues/8#note_91' },
    });
    expect(posts).toBe(1);
  });

  it('finds an existing exact-body note on a later page without posting (#380)', async () => {
    const { provider, fake } = setup([
      { match: '/notes\\?per_page=100&page=1$', stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `other ${i}` }))) },
      { match: '/notes\\?per_page=100&page=2$', stdout: JSON.stringify([{ id: 101, body: 'B' }]) },
    ]);
    expect(await provider.addIssueComment(REPO, 8, 'B')).toEqual({
      ok: true, value: { url: 'https://git.example.com/group/subgroup/project/-/issues/8#note_101' },
    });
    expect(readFakeGlabCalls(fake.logPath)).toHaveLength(2);
    expect(readFakeGlabCalls(fake.logPath).some((call) => call.includes('-X POST'))).toBe(false);
  });

  it.each([
    { stdout: JSON.stringify([{ id: 1, body: 'B' }, null]) },
    { stdout: JSON.stringify([{ id: 1 }]) },
    { exit: 1, stderr: 'glab: HTTP 503' },
  ])('does not post after incomplete note evidence: %j (#380)', async (response) => {
    const { provider, fake } = setup([{ match: '/notes\\?per_page=', ...response }]);
    expect(await provider.addIssueComment(REPO, 8, 'B')).toMatchObject({ ok: false, code: 'glab_transport' });
    expect(readFakeGlabCalls(fake.logPath).some((call) => call.includes('-X POST'))).toBe(false);
  });

  it('fails closed when a note scan reaches its cap even if a matching note was seen (#380)', async () => {
    const { provider, fake } = setup([{
      match: '/notes\\?per_page=',
      stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'B' }))),
    }]);
    expect(await provider.addIssueComment(REPO, 8, 'B')).toMatchObject({ ok: false, code: 'evidence_truncated' });
    expect(readFakeGlabCalls(fake.logPath)).toHaveLength(10);
    expect(readFakeGlabCalls(fake.logPath).some((call) => call.includes('-X POST'))).toBe(false);
  });

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
      `api --hostname ${HOST} projects/${PROJECT_ID}/issues/8/notes?per_page=100&page=1`,
      `api --hostname ${HOST} -X POST projects/${PROJECT_ID}/issues/8/notes -f body=SpecGit delivery branch: \`feat/8-x\` (draft pull request #9).`,
    ]);
  });

  it('derives the note deep-link when CE returns no web_url (#252)', async () => {
    // Live CE shape (19.3.0 probe, note 88688): the note object carries
    // an id but no web_url. The deep-link is derived deterministically
    // from returned facts, never scraped.
    const { provider } = setup([
      { match: '-X POST projects/.*/issues/8/notes ', stdout: JSON.stringify({ id: 88688, noteable_iid: 8 }) },
    ]);
    const result = await provider.addIssueComment(REPO, 8, 'B');
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://git.example.com/group/subgroup/project/-/issues/8#note_88688' },
    });
  });

  it('keeps a ported self-managed host literal in the derived deep-link (#252)', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: '-X POST projects/.*/issues/8/notes ', stdout: JSON.stringify({ id: 7 }) },
    ]);
    const provider = new GlabProvider({ hostname: 'git.example.com:8443', env: fake.env() });
    const result = await provider.addIssueComment(REPO, 8, 'B');
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://git.example.com:8443/group/subgroup/project/-/issues/8#note_7' },
    });
  });

  it('falls back to gitlab.com in the derived deep-link when no hostname is scoped (#252)', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: '-X POST projects/.*/issues/8/notes', stdout: JSON.stringify({ id: 9 }) },
    ]);
    const provider = new GlabProvider({ env: fake.env() });
    const result = await provider.addIssueComment(REPO, 8, 'B');
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://gitlab.com/group/subgroup/project/-/issues/8#note_9' },
    });
  });

  it('fails closed with glab_transport when the payload has neither web_url nor id', async () => {
    const { provider } = setup([
      { match: '-X POST projects/.*/issues/8/notes ', stdout: JSON.stringify({ body: 'x' }) },
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

describe('GlabProvider guarded delivery mutations (#382)', () => {
  const mrFact = (state: string, sha: string = SHA) => ({
    iid: 42, state, sha, draft: false, source_branch: 'feat/test', target_branch: 'main',
    description: 'Closes #8', merge_commit_sha: state === 'merged' ? 'b'.repeat(40) : null,
  });

  it('merges the verified head with an atomic SHA condition and confirms the remote result', async () => {
    const calls: string[][] = [];
    let merged = false;
    const provider = new GlabProvider({ hostname: HOST, spawnImpl: async (_command, args) => {
      calls.push(args);
      if (args.includes('PUT')) {
        expect(args).toContain(`sha=${SHA}`);
        merged = true;
      }
      return { stdout: JSON.stringify(mrFact(merged ? 'merged' : 'opened')), stderr: '' };
    } });
    expect(await provider.mergePr(REPO, 42, SHA)).toEqual({ ok: true, value: { merged: true } });
    expect(calls).toEqual([
      ['api', '--hostname', HOST, `projects/${PROJECT_ID}/merge_requests/42`],
      ['api', '--hostname', HOST, '-X', 'PUT', `projects/${PROJECT_ID}/merge_requests/42/merge`, '-f', `sha=${SHA}`],
      ['api', '--hostname', HOST, `projects/${PROJECT_ID}/merge_requests/42`],
    ]);
  });

  it('closes an issue with verified post-state and resumes without a second mutation', async () => {
    let closed = false;
    const writes: string[][] = [];
    const provider = new GlabProvider({ hostname: HOST, spawnImpl: async (_command, args) => {
      if (args.includes('PUT')) {
        writes.push(args);
        closed = true;
      }
      return { stdout: JSON.stringify({ iid: 8, state: closed ? 'closed' : 'opened' }), stderr: '' };
    } });
    expect(await provider.closeIssue(REPO, 8)).toEqual({ ok: true, value: { closed: true } });
    expect(await provider.closeIssue(REPO, 8)).toEqual({ ok: true, value: { closed: true } });
    expect(writes).toEqual([[
      'api', '--hostname', HOST, '-X', 'PUT', `projects/${PROJECT_ID}/issues/8`, '-f', 'state_event=close',
    ]]);
  });

  it('refuses a changed head before mutation and lets GitLab reject a race at the SHA condition', async () => {
    let writes = 0;
    const changed = new GlabProvider({ spawnImpl: async () => ({ stdout: JSON.stringify(mrFact('opened', 'c'.repeat(40))), stderr: '' }) });
    expect(await changed.mergePr(REPO, 42, SHA)).toMatchObject({ ok: false, code: 'glab_transport' });
    const raced = new GlabProvider({ spawnImpl: async (_command, args) => {
      if (args.includes('PUT')) {
        writes += 1;
        expect(args).toContain(`sha=${SHA}`);
        throw Object.assign(new Error('head changed'), { code: 1, stderr: 'glab: HTTP 409 SHA does not match HEAD of source branch' });
      }
      return { stdout: JSON.stringify(mrFact('opened')), stderr: '' };
    } });
    expect(await raced.mergePr(REPO, 42, SHA)).toMatchObject({ ok: false, code: 'glab_transport' });
    expect(writes).toBe(1);
  });

  it('does not report queued merges or unconfirmed issue closures as complete', async () => {
    const provider = new GlabProvider({ spawnImpl: async (_command, args) => ({
      stdout: JSON.stringify(args.some((arg) => arg.includes('merge_requests')) ? mrFact('opened') : { iid: 8, state: 'opened' }),
      stderr: '',
    }) });
    expect(await provider.mergePr(REPO, 42, SHA)).toEqual({ ok: true, value: { merged: false } });
    expect(await provider.closeIssue(REPO, 8)).toEqual({ ok: true, value: { closed: false } });
  });

  it('resumes an already merged MR without issuing another PUT', async () => {
    let calls = 0;
    const provider = new GlabProvider({ spawnImpl: async (_command, args) => {
      calls += 1;
      expect(args).not.toContain('PUT');
      return { stdout: JSON.stringify(mrFact('merged')), stderr: '' };
    } });
    expect(await provider.mergePr(REPO, 42, SHA)).toEqual({ ok: true, value: { merged: true } });
    expect(calls).toBe(1);
  });

  it('returns failed evidence when a mutation preflight receives a null resource payload', async () => {
    const provider = new GlabProvider({ spawnImpl: async () => ({ stdout: 'null', stderr: '' }) });
    expect(await provider.mergePr(REPO, 42, SHA)).toMatchObject({ ok: false, code: 'glab_transport' });
    expect(await provider.closeIssue(REPO, 8)).toMatchObject({ ok: false, code: 'glab_transport' });
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

  function setup(
    rules: FakeGlabRule[],
    providerOptions: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
    fakeOptions: { repoDir?: string } = {}
  ) {
    const fake = createFakeGlab(tempDir, rules, fakeOptions);
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

  // #270: GitLab rejects an MR whose source branch was never pushed.
  // The double enforces that against a real bare remote, so the create
  // must fail closed with the transport diagnosis instead of a rule hit.
  describe('against a remote that only knows pushed branches (#270)', () => {
    const MR_RULE: FakeGlabRule = {
      match: `-X POST projects/${PROJECT_ID}/merge_requests `,
      stdout: JSON.stringify({
        iid: 12,
        web_url: 'https://git.example.com/group/subgroup/project/-/merge_requests/12',
        draft: true,
        work_in_progress: true,
      }),
    };

    async function bareRemote(): Promise<string> {
      const repoDir = path.join(tempDir, 'remote.git');
      await execFileAsync('git', ['init', '--bare', repoDir]);
      return repoDir;
    }

    // CI runners carry no global git identity; commit-tree needs one.
    const COMMIT_IDENTITY = {
      ...process.env,
      GIT_AUTHOR_NAME: 'specgit-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'specgit-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };

    it('fails closed when the source branch was never pushed', async () => {
      const repoDir = await bareRemote();
      const { provider } = setup([MR_RULE], {}, { repoDir });
      const result = await provider.createDraftPr(REPO, 'feat/7-never-pushed', 'main', 'T', 'B');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('glab_transport');
      expect(result.message).toContain('source_branch');
    });

    it('creates the MR once the branch exists on the remote', async () => {
      const repoDir = await bareRemote();
      const { stdout: emptyTree } = await execFileAsync('git', ['--git-dir', repoDir, 'hash-object', '-t', 'tree', '/dev/null']);
      const { stdout: commitSha } = await execFileAsync(
        'git',
        ['--git-dir', repoDir, 'commit-tree', emptyTree.trim(), '-m', 'seed'],
        { env: COMMIT_IDENTITY }
      );
      await execFileAsync('git', ['--git-dir', repoDir, 'update-ref', 'refs/heads/feat/7-pushed', commitSha.trim()]);
      const { provider } = setup([MR_RULE], {}, { repoDir });
      const result = await provider.createDraftPr(REPO, 'feat/7-pushed', 'main', 'T', 'B');
      expect(result).toEqual({
        ok: true,
        value: { number: 12, url: 'https://git.example.com/group/subgroup/project/-/merge_requests/12' },
      });
    });
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

  it('fails closed when the protection read does not identify the requested branch', async () => {
    const { provider } = setup([
      {
        match: `protected_branches/main$`,
        stdout: JSON.stringify({ name: 'release', push_access_levels: [{ access_level: 40 }] }),
      },
    ]);
    const result = await provider.getBranchProtection(REPO, 'main');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('requested branch "main"');
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
        match: `-X PUT projects/${PROJECT_ID} `,
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
    const result = await provider.enableBranchProtection(REPO, 'main', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
      `api --hostname ${HOST} -X PUT projects/${PROJECT_ID} -f only_allow_merge_if_pipeline_succeeds=true`,
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
        match: `-X PUT projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    const calls = readFakeGlabCalls(fake.logPath);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes('-X POST projects/'))).toBe(false);
  });

  it('a failed POST protection reports the error, never a fabricated fact', async () => {
    const { provider } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
      {
        match: `-X PUT projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
      { match: `-X POST projects/${PROJECT_ID}/protected_branches `, exit: 1, stderr: 'glab: 422\n' },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
  });

  it('fails closed when the POST response does not prove the requested branch was protected', async () => {
    const { provider } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
      {
        match: `-X PUT projects/${PROJECT_ID} `,
        stdout: JSON.stringify({
          id: 1278,
          path_with_namespace: 'group/subgroup/project',
          only_allow_merge_if_pipeline_succeeds: true,
        }),
      },
      {
        match: `-X POST projects/${PROJECT_ID}/protected_branches `,
        stdout: JSON.stringify({ name: 'release', push_access_levels: [{ access_level: 40 }] }),
      },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('requested branch "main"');
  });

  it('does not protect the branch when GitLab fails to confirm the pipeline gate', async () => {
    const { provider, fake } = setup([
      { match: `protected_branches/main$`, exit: 1, stderr: 'glab: 404 Not Found\n' },
      {
        match: `-X PUT projects/${PROJECT_ID} `,
        stdout: JSON.stringify({ id: 1278, path_with_namespace: 'group/subgroup/project' }),
      },
    ]);
    const result = await provider.enableBranchProtection(REPO, 'main', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain('successful pipelines as required');
    expect(readFakeGlabCalls(fake.logPath).some((call) => call.includes('-X POST'))).toBe(false);
  });

  it('refuses an empty branch without invoking glab', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.enableBranchProtection(REPO, ' ', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });

  it('rejects a GitHub status-check name instead of treating it as a GitLab job', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('glab_transport');
    expect(result.message).toContain(GITLAB_PIPELINE_SUCCESS_GATE);
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
          match: `-X PUT projects/${PROJECT_ID} `,
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
    const result = await provider.enableBranchProtection(REPO, 'main', GITLAB_PIPELINE_SUCCESS_GATE);
    expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: ['build', 'SpecGit Acceptance'] } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([
      `api --hostname ${HOST} projects/${PROJECT_ID}/protected_branches/main`,
      `api --hostname ${HOST} -X PUT projects/${PROJECT_ID} -f only_allow_merge_if_pipeline_succeeds=true`,
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

  it('enables the gate via PUT and reports the verified setting', async () => {
    const { provider, fake } = setup([
      {
        match: `-X PUT projects/${PROJECT_ID} `,
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
      `api --hostname ${HOST} -X PUT projects/${PROJECT_ID} -f only_allow_merge_if_pipeline_succeeds=true`,
    ]);
  });

  it('reports enabled=false when the server response does not echo the setting', async () => {
    const { provider } = setup([
      {
        match: `-X PUT projects/${PROJECT_ID} `,
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

// The double is a routing oracle, not just a request matcher (#234): a
// call hitting a known endpoint with an unrouted verb gets GitLab's
// shaped 404. This is the regression guard for the #229 failure class —
// a wrong verb (like PATCH on the PUT-only edit-project endpoint) must
// fail here exactly as it fails against a real GitLab.
describe('fake glab routing oracle (#234)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-routing-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function callFakeGlab(fake: FakeGlab, args: string[]) {
    return execFileAsync(process.execPath, [path.join(fake.binDir, 'fake-glab.cjs'), ...args], {
      env: fake.env(),
    });
  }

  async function expectGitLab404(promise: Promise<{ stdout: string; stderr: string }>): Promise<void> {
    try {
      await promise;
    } catch (error) {
      const err = error as { code?: unknown; stdout?: string; stderr?: string };
      expect(err.code).toBe(1);
      expect(err.stdout).toBe('{"error":"404 Not Found"}\n');
      expect(err.stderr).toContain('glab: HTTP 404');
      return;
    }
    expect.unreachable('an unrouted verb must fail with GitLab\'s shaped 404');
  }

  it('rejects PATCH on the PUT-only edit-project endpoint with GitLab\'s shaped 404', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: `projects/${PROJECT_ID}$`, stdout: '{"id":1}\n' },
    ]);
    await expectGitLab404(
      callFakeGlab(fake, [
        'api',
        '--hostname',
        HOST,
        '-X',
        'PATCH',
        `projects/${PROJECT_ID}`,
        '-f',
        'only_allow_merge_if_pipeline_succeeds=true',
      ])
    );
    // The call still lands in the recorder log — the rejection shapes the
    // evidence, it does not hide the request.
    expect(readFakeGlabCalls(fake.logPath)).toHaveLength(1);
  });

  it('rejects an unrouted verb on protected_branches the same way', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: `projects/${PROJECT_ID}/protected_branches -f`, stdout: '{"name":"main"}\n' },
    ]);
    await expectGitLab404(
      callFakeGlab(fake, [
        'api',
        '--hostname',
        HOST,
        '-X',
        'DELETE',
        `projects/${PROJECT_ID}/protected_branches`,
        '-f',
        'name=main',
      ])
    );
  });

  it('serves the scripted response when the verb is routed', async () => {
    const fake = createFakeGlab(tempDir, [
      { match: `-X PUT projects/${PROJECT_ID} `, stdout: '{"id":1}\n' },
    ]);
    const { stdout } = await callFakeGlab(fake, [
      'api',
      '--hostname',
      HOST,
      '-X',
      'PUT',
      `projects/${PROJECT_ID}`,
      '-f',
      'only_allow_merge_if_pipeline_succeeds=true',
    ]);
    expect(stdout).toBe('{"id":1}\n');
  });

  it('leaves unrouted paths to the scripted rules', async () => {
    const fake = createFakeGlab(tempDir, [{ match: '/metadata$', stdout: metadataJson('19.2.4') }]);
    const { stdout } = await callFakeGlab(fake, ['api', '--hostname', HOST, '/metadata']);
    expect(stdout).toBe(metadataJson('19.2.4'));
  });
});

describe('GlabProvider#getEvidenceAnchor (check freshness #315)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-glab-anchor-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('declares no boundary — ok({ anchoredAt: null }) — without invoking glab', async () => {
    // Compatibility is proven by pinning the absence of behavior, not by
    // assuming a GitLab defect: within the verified window (19.2.4 CE,
    // docs/evidence/gitlab-19.2.md) no equivalent of GitHub's
    // ready-for-review transition has been evidenced, so the adapter
    // sets no freshness boundary (`anchoredAt: null`, the three-state
    // contract's legal "no boundary" arm) and makes no CLI call — no
    // GitLab-specific behavior is invented or worked around (#315).
    const fake = createFakeGlab(tempDir, [
      { match: '^--version$', stdout: 'glab version 1.113.0\n' },
    ]);
    const provider = new GlabProvider({ hostname: HOST, env: fake.env() });
    const result = await provider.getEvidenceAnchor(REPO, 9);
    expect(result).toEqual({ ok: true, value: { anchoredAt: null } });
    expect(readFakeGlabCalls(fake.logPath)).toEqual([]);
  });
});
