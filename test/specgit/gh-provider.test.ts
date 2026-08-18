import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhCliGitHubProvider, sanitizeApiText } from '../../src/github/gh-cli.js';
import { createFakeGh, readFakeGhCalls, type FakeGhRule } from './helpers/fake-gh.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

const REPO = { owner: 'LeXwDeX', repo: 'SpecGit' };
const SHA = 'a'.repeat(40);

describe('gh command resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-resolve-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('SPECGIT_GH pointing at a node-shebang script executes through node', async () => {
    const { provider, fake } = (() => {
      const fake = createFakeGh(tempDir, [
        { match: '^--version$', stdout: 'gh version 2.60.0\n' },
        { match: '^auth status$', stdout: 'Logged in to github.com\n' },
      ]);
      // Deliberately construct WITHOUT options.env so the only wiring is the
      // process-level SPECGIT_GH set below.
      const provider = new GhCliGitHubProvider();
      return { provider, fake };
    })();
    const prev = process.env.SPECGIT_GH;
    process.env.SPECGIT_GH = path.join(fake.binDir, 'gh');
    try {
      const result = await provider.preflight();
      expect(result).toEqual({ ok: true, value: { authenticated: true } });
    } finally {
      if (prev === undefined) delete process.env.SPECGIT_GH;
      else process.env.SPECGIT_GH = prev;
    }
  });

  it('a node-shebang script passed as ghCommand runs identically', async () => {
    const fake = createFakeGh(tempDir, [
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', stdout: 'Logged in to github.com\n' },
    ]);
    const provider = new GhCliGitHubProvider({
      ghCommand: path.join(fake.binDir, 'gh'),
      env: fake.env(),
    });
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
  });
});

describe('GhCliGitHubProvider', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGhRule[], providerOptions: { timeoutMs?: number; maxBuffer?: number } = {}) {
    const fake = createFakeGh(tempDir, rules);
    const provider = new GhCliGitHubProvider({ env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  it('preflight passes when gh exists and is authenticated', async () => {
    const { provider, fake } = setup([
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', stdout: 'Logged in to github.com\n' },
    ]);
    const result = await provider.preflight();
    expect(result).toEqual({ ok: true, value: { authenticated: true } });
    expect(readFakeGhCalls(fake.logPath)).toEqual(['--version', 'auth status']);
  });

  it('fails closed with gh_missing when gh is not on PATH', async () => {
    const emptyBin = path.join(tempDir, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const provider = new GhCliGitHubProvider({ env: { PATH: emptyBin } });
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_missing');
  });

  it('fails closed with gh_unauthenticated and never leaks token output', async () => {
    const { provider } = setup([
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      {
        match: '^auth status$',
        exit: 1,
        stderr: 'Token: ghp_SUPERSECRETTOKEN123\ngh auth status failed\n',
      },
    ]);
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_unauthenticated');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ghp_SUPERSECRETTOKEN123');
  });

  it('classifies an auth-status timeout as gh_transport, not gh_unauthenticated', async () => {
    const { provider } = setup(
      [
        { match: '^--version$', stdout: 'gh version 2.60.0\n' },
        { match: '^auth status$', delayMs: 20_000, stdout: 'Logged in to github.com\n' },
      ],
      { timeoutMs: 1000 }
    );
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('auth check failed');
  });

  it('classifies a non-auth auth-status exit code as gh_transport', async () => {
    const { provider } = setup([
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', exit: 2, stderr: 'fatal: gh crashed\n' },
    ]);
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('auth check failed');
  });

  it('parses an issue fact including the pull_request marker', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/7$',
        stdout: JSON.stringify({ number: 7, state: 'open', pull_request: { url: 'x' } }),
      },
    ]);
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ number: 7, state: 'open', pullRequest: true });
  });

  it('classifies a 404 issue lookup as issue_not_found', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/99$',
        exit: 1,
        stderr: 'gh: Not Found (HTTP 404)\n',
      },
    ]);
    const result = await provider.getIssue(REPO, 99);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('issue_not_found');
  });

  it('classifies other non-zero exits as gh_transport with sanitized text', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/7$',
        exit: 1,
        stderr: '\u001b[31mrate limit exceeded\u001b[0m\n',
      },
    ]);
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).not.toContain('\u001b');
    expect(result.message).toContain('rate limit exceeded');
  });

  it('parses a merged PR fact', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'closed',
          merged_at: '2026-01-01T00:00:00Z',
          head: { ref: 'feat/123-login', sha: SHA },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
    ]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('merged');
    expect(result.value.headBranch).toBe('feat/123-login');
    expect(result.value.headSha).toBe(SHA);
    expect(result.value.baseBranch).toBe('main');
    expect(result.value.body).toBe('Closes #123');
  });

  it('classifies a 404 PR lookup as pr_not_found', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/43$',
        exit: 1,
        stderr: 'gh: Not Found (HTTP 404)\n',
      },
    ]);
    const result = await provider.getPr(REPO, 43);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('pr_not_found');
  });

  it('rejects a non-numeric PR ref without invoking gh', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.getPr(REPO, 'not-a-number');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('pr_not_found');
    expect(readFakeGhCalls(fake.logPath)).toEqual([]);
  });

  it('paginates check-runs across pages', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      name: `run-${i}`,
      status: 'completed',
      conclusion: 'success',
    }));
    const pageTwo = [
      { name: 'All checks passed', status: 'completed', conclusion: 'success' },
      { name: 'Test', status: 'in_progress', conclusion: null },
    ];
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/commits/' + SHA + '/check-runs\\?per_page=100&page=1$',
        stdout: JSON.stringify({ total_count: 102, check_runs: pageOne }),
      },
      {
        match: '^api repos/LeXwDeX/SpecGit/commits/' + SHA + '/check-runs\\?per_page=100&page=2$',
        stdout: JSON.stringify({ total_count: 102, check_runs: pageTwo }),
      },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(102);
    expect(result.value[100]).toEqual({ name: 'All checks passed', status: 'completed', conclusion: 'success' });
    expect(result.value[101]).toEqual({ name: 'Test', status: 'in_progress', conclusion: null });
  });

  it('fails closed with gh_transport on unparsable check-run JSON', async () => {
    const { provider } = setup([
      {
        match: 'check-runs',
        stdout: 'this is not json',
      },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
  });

  it('kills a slow gh at the timeout and reports gh_transport', async () => {
    const { provider } = setup(
      [{ match: '^api repos/LeXwDeX/SpecGit/issues/7$', delayMs: 5000, stdout: '{}' }],
      { timeoutMs: 250 }
    );
    const started = Date.now();
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('fails closed with gh_transport when output exceeds the size cap', async () => {
    const { provider } = setup(
      [
        {
          match: '^api repos/LeXwDeX/SpecGit/issues/7$',
          stdout: 'x'.repeat(3 * 1024 * 1024),
        },
      ],
      { maxBuffer: 100_000 }
    );
    const result = await provider.getIssue(REPO, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
  });

  it('never invokes anything but gh subcommands', async () => {
    const { provider, fake } = setup([
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', stdout: 'ok\n' },
      { match: '^api repos/LeXwDeX/SpecGit/issues/1$', stdout: JSON.stringify({ number: 1, state: 'open' }) },
    ]);
    await provider.preflight();
    await provider.getIssue(REPO, 1);
    const calls = readFakeGhCalls(fake.logPath);
    for (const call of calls) {
      expect(call).toMatch(/^(--version|auth status|api repos\/)/);
    }
  });
});

describe('sanitizeApiText', () => {
  it('strips ANSI escapes and control characters', () => {
    const dirty = '\u001b[31mERROR\u001b[0m\u0007 with\u0000 controls\u001b[2J';
    const clean = sanitizeApiText(dirty);
    expect(clean).not.toMatch(/\u001b/);
    expect(clean).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    expect(clean).toContain('ERROR');
  });

  it('truncates long text', () => {
    const clean = sanitizeApiText('y'.repeat(1000), 50);
    expect(clean.length).toBeLessThanOrEqual(51);
  });
});
