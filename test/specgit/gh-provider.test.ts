import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhCliGitHubProvider, sanitizeApiText } from '../../src/github/gh-cli.js';
import {
  createFakeGh,
  readFakeGhCalls,
  readFakeGhStdin,
  type FakeGhRule,
} from './helpers/fake-gh.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

const REPO = { owner: 'LeXwDeX', repo: 'SpecGit' };
const SHA = 'a'.repeat(40);
const MERGE_SHA = 'm'.repeat(40);

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
      // The injected env carries only the fake's config — no SPECGIT_GH — so
      // command resolution must fall through to the process-level override
      // set below.
      const provider = new GhCliGitHubProvider({ env: { FAKE_GH_CONFIG: fake.configPath } });
      return { provider, fake };
    })();
    const prev = process.env.SPECGIT_GH;
    process.env.SPECGIT_GH = path.join(fake.binDir, 'fake-gh.cjs');
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
      ghCommand: path.join(fake.binDir, 'fake-gh.cjs'),
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

  function setup(
    rules: FakeGhRule[],
    providerOptions: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
  ) {
    const fake = createFakeGh(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    // fake.env(extra) merges the fake's own vars with the caller's extras.
    const provider = new GhCliGitHubProvider({ env: fake.env(extraEnv), ...rest });
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

  describe('branch protection', () => {
    it('reports an unprotected branch from a 404 as protected=false', async () => {
      const { provider } = setup([
        { match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$', exit: 1, stderr: 'HTTP 404: Branch not protected' },
      ]);
      const result = await provider.getBranchProtection(REPO, 'main');
      expect(result).toEqual({
        ok: true,
        value: { protected: false, requiredChecks: [] },
      });
    });

    it('parses required status check contexts from protection', async () => {
      const { provider } = setup([
        {
          match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$',
          stdout: JSON.stringify({
            required_status_checks: { strict: false, contexts: ['SpecGit Acceptance'] },
          }),
        },
      ]);
      const result = await provider.getBranchProtection(REPO, 'main');
      expect(result).toEqual({
        ok: true,
        value: { protected: true, requiredChecks: ['SpecGit Acceptance'] },
      });
    });

    it('maps other lookup failures to gh_transport', async () => {
      const { provider } = setup([
        { match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$', exit: 1, stderr: 'HTTP 403: resource not accessible' },
      ]);
      const result = await provider.getBranchProtection(REPO, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('gh_transport');
    });

    it('enables protection read-modify-write: reads governance, PUTs an additive body', async () => {
      const existing = {
        required_status_checks: { enforcement_level: 'non_admins', contexts: ['build'] },
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          required_approving_review_count: 2,
          dismissal_restrictions: { users: [{ login: 'alice' }], teams: [{ slug: 'core' }] },
        },
        enforce_admins: { enabled: true },
        restrictions: { users: [{ login: 'bob' }], teams: [{ slug: 'devs' }] },
      };
      const afterPut = {
        ...existing,
        required_status_checks: { enforcement_level: 'non_admins', contexts: ['build', 'SpecGit Acceptance'] },
      };
      const { provider, fake } = setup([
        {
          match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$',
          stdout: JSON.stringify(existing),
        },
        {
          match: '^api -X PUT repos/LeXwDeX/SpecGit/branches/main/protection',
          stdout: JSON.stringify(afterPut),
        },
      ]);
      const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
      // The reported fact comes from the server's post-update payload:
      // governance dimensions survived, the check was added.
      expect(result).toEqual({
        ok: true,
        value: { protected: true, requiredChecks: ['build', 'SpecGit Acceptance'] },
      });
      const calls = readFakeGhCalls(fake.logPath);
      expect(calls).toEqual([
        'api repos/LeXwDeX/SpecGit/branches/main/protection',
        'api -X PUT repos/LeXwDeX/SpecGit/branches/main/protection --input -',
      ]);
      // The PUT body preserves every governance dimension and only adds the check.
      const body = JSON.parse(readFakeGhStdin(fake.logPath)[0]);
      expect(body.required_status_checks.contexts).toEqual(['build', 'SpecGit Acceptance']);
      expect(body.enforce_admins).toBe(true);
      expect(body.required_pull_request_reviews).toEqual({
        dismiss_stale_reviews: true,
        required_approving_review_count: 2,
        dismissal_restrictions: { users: ['alice'], teams: ['core'] },
      });
      expect(body.restrictions).toEqual({ users: ['bob'], teams: ['devs'] });
    });

    it('an unprotected branch gets the minimal additive body (no governance to lose)', async () => {
      const { provider, fake } = setup([
        {
          match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$',
          exit: 1,
          stderr: 'HTTP 404: Branch not protected',
        },
        {
          match: '^api -X PUT repos/LeXwDeX/SpecGit/branches/main/protection',
          stdout: JSON.stringify({
            required_status_checks: { strict: false, contexts: ['SpecGit Acceptance'] },
          }),
        },
      ]);
      const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
      expect(result).toEqual({
        ok: true,
        value: { protected: true, requiredChecks: ['SpecGit Acceptance'] },
      });
      const calls = readFakeGhCalls(fake.logPath);
      expect(calls).toEqual([
        'api repos/LeXwDeX/SpecGit/branches/main/protection',
        'api -X PUT repos/LeXwDeX/SpecGit/branches/main/protection --input -',
      ]);
      const body = JSON.parse(readFakeGhStdin(fake.logPath)[0]);
      expect(body).toEqual({
        required_status_checks: { strict: false, contexts: ['SpecGit Acceptance'] },
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
      });
    });

    it('a PUT response without parseable checks fails closed instead of fabricating the list', async () => {
      const { provider } = setup([
        {
          match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$',
          exit: 1,
          stderr: 'HTTP 404: Branch not protected',
        },
        {
          match: '^api -X PUT repos/LeXwDeX/SpecGit/branches/main/protection',
          stdout: JSON.stringify({ unexpected: 'shape' }),
        },
      ]);
      const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('gh_transport');
        expect(result.message).toContain('verified');
      }
    });

    it('a failed PUT leaves the reported fact as an error, never a fabricated check list', async () => {
      const { provider } = setup([
        {
          match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$',
          exit: 1,
          stderr: 'HTTP 404: Branch not protected',
        },
        {
          match: '^api -X PUT repos/LeXwDeX/SpecGit/branches/main/protection',
          exit: 1,
          stderr: 'HTTP 403: Resource not accessible by integration',
        },
      ]);
      const result = await provider.enableBranchProtection(REPO, 'main', 'SpecGit Acceptance');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('gh_transport');
    });

    it('a malformed protection payload reports empty required checks, not the requested one', async () => {
      const { provider } = setup([
        {
          match: '^api repos/LeXwDeX/SpecGit/branches/main/protection$',
          stdout: JSON.stringify({ required_status_checks: {} }),
        },
      ]);
      const result = await provider.getBranchProtection(REPO, 'main');
      expect(result).toEqual({ ok: true, value: { protected: true, requiredChecks: [] } });
    });
  });

  describe('repo auto-merge', () => {
    it('reads allow_auto_merge from the repo payload', async () => {
      const { provider } = setup([
        { match: '^api repos/LeXwDeX/SpecGit$', stdout: JSON.stringify({ allow_auto_merge: true }) },
      ]);
      const result = await provider.getRepoAutomerge(REPO);
      expect(result).toEqual({ ok: true, value: { enabled: true } });
    });

    it('enables auto-merge via PATCH --input', async () => {
      const { provider, fake } = setup([
        { match: '^api -X PATCH repos/LeXwDeX/SpecGit ', stdout: JSON.stringify({ allow_auto_merge: true }) },
      ]);
      const result = await provider.enableRepoAutomerge(REPO);
      expect(result).toEqual({ ok: true, value: { enabled: true } });
      const bodies = readFakeGhStdin(fake.logPath);
      expect(JSON.parse(bodies[0])).toEqual({ allow_auto_merge: true });
    });
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
          merge_commit_sha: MERGE_SHA,
          draft: false,
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
    expect(result.value.mergeCommitSha).toBe(MERGE_SHA);
  });

  it('reports mergeCommitSha null for a merged PR whose payload omits merge_commit_sha', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'closed',
          merged_at: '2026-01-01T00:00:00Z',
          draft: false,
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
    expect(result.value.mergeCommitSha).toBeNull();
  });

  it('mirrors the test-merge merge_commit_sha of an open PR without marking it merged', async () => {
    // Before a merge, GitHub reports the SHA of a throwaway test merge
    // commit; the fact mirrors the field, and only merged PRs anchor
    // lineage on it.
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          merged_at: null,
          merge_commit_sha: MERGE_SHA,
          draft: false,
          head: { ref: 'feat/123-login', sha: SHA },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
    ]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('open');
    expect(result.value.mergeCommitSha).toBe(MERGE_SHA);
  });

  it('collects the draft flag of an open draft PR', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          merged_at: null,
          draft: true,
          head: { ref: 'feat/123-login', sha: SHA },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
    ]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('open');
    expect(result.value.draft).toBe(true);
  });

  it('collects draft false for a ready-for-review PR', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          merged_at: null,
          draft: false,
          head: { ref: 'feat/123-login', sha: SHA },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
    ]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.draft).toBe(false);
  });

  it('fails closed when the PR payload omits the draft flag', async () => {
    // GitHub always reports draft on pull request payloads; an answer
    // without it is a transport anomaly. The verdict must never guess
    // "not a draft" (I0: exit 0 over unmergeable state).
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          merged_at: null,
          head: { ref: 'feat/123-login', sha: SHA },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
    ]);
    const result = await provider.getPr(REPO, 42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
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
      { name: 'Test', status: 'in_progress', conclusion: null, id: 7, started_at: '2026-08-20T14:00:00Z' },
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
    // #119: id and started_at ride along for truth-run selection; absent
    // fields fail safe (id 0, startedAt null = oldest).
    expect(result.value[100]).toEqual({
      name: 'All checks passed',
      status: 'completed',
      conclusion: 'success',
      id: 0,
      startedAt: null,
    });
    expect(result.value[101]).toEqual({
      name: 'Test',
      status: 'in_progress',
      conclusion: null,
      id: 7,
      startedAt: '2026-08-20T14:00:00Z',
    });
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

describe('GhCliGitHubProvider#createIssue', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-create-issue-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGhRule[], providerOptions: { timeoutMs?: number; maxBuffer?: number } = {}) {
    const fake = createFakeGh(tempDir, rules);
    const provider = new GhCliGitHubProvider({ env: fake.env(), ...providerOptions });
    return { fake, provider };
  }

  it('creates an issue through gh api -f fields and returns {number, url}', async () => {
    const { provider, fake } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/issues ',
        stdout: JSON.stringify({ number: 8, html_url: 'https://github.com/LeXwDeX/SpecGit/issues/8' }),
      },
    ]);
    const result = await provider.createIssue(REPO, 'Add strict delivery harness', 'Body with #4 ref');
    expect(result).toEqual({
      ok: true,
      value: { number: 8, url: 'https://github.com/LeXwDeX/SpecGit/issues/8' },
    });
    expect(readFakeGhCalls(fake.logPath)).toEqual([
      'api repos/LeXwDeX/SpecGit/issues -f title=Add strict delivery harness -f body=Body with #4 ref',
    ]);
  });

  it('fails closed with gh_transport when the response is not valid JSON', async () => {
    const { provider } = setup([{ match: '^api repos/LeXwDeX/SpecGit/issues ', stdout: 'not json' }]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('not valid JSON');
  });

  it('fails closed with gh_transport when the payload misses number or url', async () => {
    const { provider } = setup([
      { match: '^api repos/LeXwDeX/SpecGit/issues ', stdout: JSON.stringify({ number: 8 }) },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('unexpected issue payload');
  });

  it('classifies an HTTP 401 as gh_unauthenticated', async () => {
    const { provider } = setup([
      { match: '^api repos/LeXwDeX/SpecGit/issues ', exit: 1, stderr: 'gh: HTTP 401 (https://docs.github.com/rest)\n' },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_unauthenticated');
    expect(JSON.stringify(result)).not.toContain('HTTP 401');
  });

  it('classifies a server error as gh_transport with sanitized text', async () => {
    const { provider } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/issues ',
        exit: 1,
        stderr: '\u001b[31mgh: HTTP 500 uptime noise\u001b[0m\n',
      },
    ]);
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).not.toContain('\u001b');
    expect(result.message).toContain('HTTP 500');
  });

  it('fails closed with gh_missing when gh is not on PATH', async () => {
    const emptyBin = path.join(tempDir, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const provider = new GhCliGitHubProvider({ env: { PATH: emptyBin } });
    const result = await provider.createIssue(REPO, 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_missing');
  });

  it('refuses an empty title without invoking gh', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.createIssue(REPO, '   ', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(readFakeGhCalls(fake.logPath)).toEqual([]);
  });
});

describe('GhCliGitHubProvider#addIssueComment', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-issue-comment-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(rules: FakeGhRule[]) {
    const fake = createFakeGh(tempDir, rules);
    const provider = new GhCliGitHubProvider({ env: fake.env() });
    return { fake, provider };
  }

  it('posts a comment through gh api -f body and returns {url}', async () => {
    const { provider, fake } = setup([
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/8/comments ',
        stdout: JSON.stringify({
          html_url: 'https://github.com/LeXwDeX/SpecGit/issues/8#issuecomment-1',
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
      value: { url: 'https://github.com/LeXwDeX/SpecGit/issues/8#issuecomment-1' },
    });
    expect(readFakeGhCalls(fake.logPath)).toEqual([
      'api repos/LeXwDeX/SpecGit/issues/8/comments -f body=SpecGit delivery branch: `feat/8-x` (draft pull request #9).',
    ]);
  });

  it('fails closed with gh_transport when the payload misses the url', async () => {
    const { provider } = setup([
      { match: '^api repos/LeXwDeX/SpecGit/issues/8/comments ', stdout: JSON.stringify({ id: 1 }) },
    ]);
    const result = await provider.addIssueComment(REPO, 8, 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('unexpected issue-comment payload');
  });

  it('refuses an empty body without invoking gh', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.addIssueComment(REPO, 8, '   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(readFakeGhCalls(fake.logPath)).toEqual([]);
  });
});

describe('GhCliGitHubProvider#createDraftPr', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-create-pr-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(
    rules: FakeGhRule[],
    providerOptions: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
  ) {
    const fake = createFakeGh(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GhCliGitHubProvider({ env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }

  it('creates a draft PR and parses the printed URL for the number', async () => {
    const { provider, fake } = setup([
      { match: '^pr create ', stdout: 'https://github.com/LeXwDeX/SpecGit/pull/12\n' },
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
      value: { number: 12, url: 'https://github.com/LeXwDeX/SpecGit/pull/12' },
    });
    expect(readFakeGhCalls(fake.logPath)).toEqual([
      'pr create --draft --repo LeXwDeX/SpecGit --head feat/4-strict-delivery-harness --base main --title Strict delivery harness --body-file -',
    ]);
    expect(readFakeGhStdin(fake.logPath)).toEqual(['Closes #4\n\nDraft body']);
  });

  it('fails closed with gh_transport when gh prints no pull request URL', async () => {
    const { provider } = setup([{ match: '^pr create ', stdout: 'created something somewhere\n' }]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('did not report a pull request URL');
  });

  it('classifies a creation failure as gh_transport', async () => {
    const { provider } = setup([
      { match: '^pr create ', exit: 1, stderr: 'gh: Pull request creation failed (HTTP 502)\n' },
    ]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(result.message).toContain('HTTP 502');
  });

  it('classifies an auth-prompt failure as gh_unauthenticated', async () => {
    const { provider } = setup([
      {
        match: '^pr create ',
        exit: 1,
        stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\n',
      },
    ]);
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_unauthenticated');
  });

  it('kills a slow gh at the timeout and reports gh_timeout with attributed fix', async () => {
    const { provider } = setup([{ match: '^pr create ', delayMs: 5000, stdout: '' }], {
      timeoutMs: 250,
    });
    const started = Date.now();
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_timeout');
    expect(result.message).toContain('250 ms');
    // Attribution: the fix names all three likely causes and the knob.
    expect(result.fix).toContain('network');
    expect(result.fix).toContain('githubstatus');
    expect(result.fix).toContain('SPECGIT_GH_TIMEOUT_MS');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('SPECGIT_GH_TIMEOUT_MS raises the default timeout', async () => {
    const { provider } = setup(
      [
        {
          match: '^pr create ',
          delayMs: 5000,
          stdout: 'https://github.com/LeXwDeX/SpecGit/pull/42\n',
        },
      ],
      { env: { SPECGIT_GH_TIMEOUT_MS: '6000' } as NodeJS.ProcessEnv }
    );
    const result = await provider.createDraftPr(REPO, 'head', 'main', 'T', 'B');
    expect(result.ok).toBe(true);
  });

  it('refuses an empty head without invoking gh', async () => {
    const { provider, fake } = setup([]);
    const result = await provider.createDraftPr(REPO, '  ', 'main', 'T', 'B');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
    expect(readFakeGhCalls(fake.logPath)).toEqual([]);
  });
});

describe('GhCliGitHubProvider evidence completeness (issue #120, I3b)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-completeness-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(
    rules: FakeGhRule[],
    providerOptions: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
  ) {
    const fake = createFakeGh(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GhCliGitHubProvider({ env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }

  function searchPage(numbers: number[], overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      total_count: numbers.length,
      incomplete_results: false,
      items: numbers.map((n) => ({ number: n })),
      ...overrides,
    });
  }

  function checkRunPage(count: number): string {
    return JSON.stringify({
      total_count: count,
      check_runs: Array.from({ length: count }, (_, i) => ({
        name: `check-${i}`,
        status: 'completed',
        conclusion: 'success',
        id: i + 1,
        started_at: '2026-08-20T00:00:00Z',
      })),
    });
  }

  it('getOpenIssueNumbers paginates to exhaustion and returns the complete list', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => 101 + i);
    const { provider, fake } = setup([
      // Page-specific rules must precede the generic one: first match wins.
      { match: 'search/issues.*page=2', stdout: searchPage([42, 250]) },
      { match: 'search/issues', stdout: searchPage(page1) },
    ]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort((a, b) => a - b)).toEqual([42, ...page1, 250]);
    const searchCalls = readFakeGhCalls(fake.logPath).filter((c) => c.includes('search/issues'));
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]).toContain('page=1');
    expect(searchCalls[1]).toContain('page=2');
  });

  it('getOpenIssueNumbers fails closed (evidence_truncated) on GitHub incomplete_results', async () => {
    const { provider } = setup([
      {
        match: 'search/issues',
        stdout: searchPage([1, 2], { incomplete_results: true, total_count: 5000 }),
      },
    ]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
  });

  it('getOpenIssueNumbers fails closed at the search-result cap instead of silently truncating', async () => {
    const full = Array.from({ length: 100 }, (_, i) => 101 + i);
    const { provider, fake } = setup([{ match: 'search/issues', stdout: searchPage(full) }]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    // The cap is 10 pages of 100; an 11th call must never be attempted.
    expect(readFakeGhCalls(fake.logPath).filter((c) => c.includes('search/issues'))).toHaveLength(10);
  });

  it('getOpenIssueNumbers deduplicates a page-boundary shift between calls', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => 1 + i);
    const { provider } = setup([
      // #100 re-appears on page 2 (a shift between calls): one issue, once.
      { match: 'search/issues.*page=2', stdout: searchPage([100]) },
      { match: 'search/issues', stdout: searchPage(page1) },
    ]);
    const result = await provider.getOpenIssueNumbers(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(100);
  });

  function searchFactPage(
    items: Array<{ number: number; title?: string; body?: string | null }>,
    overrides: Record<string, unknown> = {}
  ): string {
    return JSON.stringify({
      total_count: items.length,
      incomplete_results: false,
      items,
      ...overrides,
    });
  }

  it('getOpenIssues paginates to exhaustion carrying titles and bodies, open issues only', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: 101 + i,
      title: `chore: filler ${101 + i}`,
      body: 'filler body',
    }));
    const page2 = [
      { number: 9, title: 'feat: alpha why', body: 'unrelated human body' },
      { number: 42, title: 'feat: alpha why', body: null },
    ];
    const { provider, fake } = setup([
      { match: 'search/issues.*page=2', stdout: searchFactPage(page2) },
      { match: 'search/issues', stdout: searchFactPage(page1) },
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
    // A null body is absence, never a string — and never a scaffold match.
    expect(result.value.find((f) => f.number === 42)).toEqual({
      number: 42,
      title: 'feat: alpha why',
    });
    const searchCalls = readFakeGhCalls(fake.logPath).filter((c) => c.includes('search/issues'));
    expect(searchCalls).toHaveLength(2);
    // The query pins the adoption boundary: issues, open state only — a
    // closed same-title issue is invisible to adoption by construction.
    expect(searchCalls[0]).toContain('is:issue+is:open');
  });

  it('getOpenIssues fails closed (evidence_truncated) on GitHub incomplete_results', async () => {
    const { provider } = setup([
      {
        match: 'search/issues',
        stdout: searchFactPage([{ number: 1, title: 'x' }], {
          incomplete_results: true,
          total_count: 5000,
        }),
      },
    ]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
  });

  it('getOpenIssues fails closed at the search-result cap instead of silently truncating', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      number: 101 + i,
      title: `chore: filler ${101 + i}`,
    }));
    const { provider, fake } = setup([{ match: 'search/issues', stdout: searchFactPage(full) }]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    expect(readFakeGhCalls(fake.logPath).filter((c) => c.includes('search/issues'))).toHaveLength(10);
  });

  it('getOpenIssues pins the probe call budget: a 250-issue scan is 3 search calls, zero per-issue GETs (#77)', async () => {
    const page = (from: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        number: from + i,
        title: `chore: filler ${from + i}`,
      }));
    const last = Array.from({ length: 50 }, (_, i) => ({
      number: 201 + i,
      title: `chore: filler ${201 + i}`,
    }));
    const { provider, fake } = setup([
      { match: 'search/issues.*page=3', stdout: searchFactPage(last) },
      { match: 'search/issues.*page=2', stdout: searchFactPage(page(101)) },
      { match: 'search/issues', stdout: searchFactPage(page(1)) },
    ]);
    const result = await provider.getOpenIssues(REPO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(250);
    const calls = readFakeGhCalls(fake.logPath);
    // Budget: exactly one call per 100-issue page — no per-issue lookups.
    expect(calls.filter((c) => c.includes('search/issues'))).toHaveLength(3);
    expect(calls.filter((c) => /api repos\/LeXwDeX\/SpecGit\/issues\/\d/.test(c))).toHaveLength(0);
  });

  it('getCheckRuns fails closed when the page cap is reached with full pages', async () => {
    const { provider, fake } = setup([{ match: 'check-runs', stdout: checkRunPage(100) }]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    expect(readFakeGhCalls(fake.logPath).filter((c) => c.includes('check-runs'))).toHaveLength(10);
  });

  it('getCheckRuns exhausts pages below the cap and returns every run', async () => {
    const { provider } = setup([
      { match: 'check-runs.*page=2', stdout: checkRunPage(3) },
      { match: 'check-runs', stdout: checkRunPage(100) },
    ]);
    const result = await provider.getCheckRuns(REPO, SHA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(103);
  });
});

describe('GhCliGitHubProvider#listOpenPrsByHead', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gh-list-prs-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function setup(
    rules: FakeGhRule[],
    providerOptions: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
  ) {
    const fake = createFakeGh(tempDir, rules);
    const { env: extraEnv, ...rest } = providerOptions;
    const provider = new GhCliGitHubProvider({ env: fake.env(extraEnv), ...rest });
    return { fake, provider };
  }


  it('lists open PRs through gh pr list with fixed flags', async () => {
    const { provider, fake } = setup([
      {
        match: '^pr list ',
        stdout: JSON.stringify([
          { number: 7, title: 'Delivery one', url: 'https://github.com/LeXwDeX/SpecGit/pull/7' },
        ]),
      },
    ]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/4-strict-delivery-harness');
    expect(result).toEqual({
      ok: true,
      value: [
        { number: 7, title: 'Delivery one', url: 'https://github.com/LeXwDeX/SpecGit/pull/7' },
      ],
    });
    expect(readFakeGhCalls(fake.logPath)).toEqual([
      'pr list --repo LeXwDeX/SpecGit --head feat/4-strict-delivery-harness --state open --json number,title,url --limit 30',
    ]);
  });

  it('returns an empty list when no PR matches', async () => {
    const { provider } = setup([{ match: '^pr list ', stdout: '[]\n' }]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/none');
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('fails closed with gh_transport on a non-array payload', async () => {
    const { provider } = setup([{ match: '^pr list ', stdout: '{"total": 0}\n' }]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
  });

  it('fails closed with gh_transport on invalid JSON', async () => {
    const { provider } = setup([{ match: '^pr list ', stdout: 'not json\n' }]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_transport');
  });

  it('classifies an HTTP 401 stderr as gh_unauthenticated', async () => {
    const { provider } = setup([
      { match: '^pr list ', exit: 1, stderr: 'gh: HTTP 401: Bad credentials\n' },
    ]);
    const result = await provider.listOpenPrsByHead(REPO, 'feat/x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('gh_unauthenticated');
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
