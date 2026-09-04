/**
 * End-to-end acceptance tests for the `specgit` CLI package.
 *
 * These run the real built CLI (`dist/cli/index.js` via `bin/specgit.js`)
 * against:
 *  - real local git (temp repos: both plain branch and linked-worktree modes),
 *  - a deterministic fake `gh` transport on PATH (rule-table driven),
 * deriving every verdict from the same evidence chain production uses.
 *
 * Proven here:
 *  - one PR can bind/close N issues (branch and worktree execution contexts),
 *  - successful / pending / failed / missing CI each drive the right verdict,
 *  - provider failures (transport error, unauthenticated, gh missing) fail
 *    closed with exit 3, never a false accept,
 *  - missing links (unclosed issues, nonexistent issue, foreign PR repo)
 *    reject with complete evidence,
 *  - spec/task/artifact files can never change acceptance (neither forge an
 *    accept nor block one).
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  bindDelivery,
  checkRunsJson,
  createFakeGh,
  emptyTimelineRule,
  gitOnlyPathDir,
  greenGhRules,
  initPolicy,
  issueJson,
  makeRepo,
  makeWorktree,
  OWNER,
  parseEnvelope,
  pileArtifacts,
  prJson,
  readFakeGhCalls,
  REQUIRED_CHECK,
  REPO,
  rmDir,
  specgit,
  type RunCLIResult,
} from './helpers.js';

const cleanupDirs: string[] = [];

// Every scenario in this file crosses real git and CLI process boundaries. Hosted
// Windows runs 33901785101 and 33906138650 independently exceeded the 10s unit
// budget; keep that default strict elsewhere and bound these subprocess cases at 30s.
const acceptanceIt = (name: string, run: () => Promise<void>): void => {
  it(name, { timeout: 30_000 }, run);
};

function track<T extends { dir?: string; mainDir?: string; worktreeDir?: string }>(
  fixture: T
): T {
  if (fixture.dir) cleanupDirs.push(fixture.dir);
  if (fixture.mainDir) cleanupDirs.push(fixture.mainDir);
  if (fixture.worktreeDir) cleanupDirs.push(fixture.worktreeDir);
  return fixture;
}

afterAll(() => {
  for (const dir of cleanupDirs) {
    rmDir(dir);
  }
});

async function acceptJson(
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<{ result: RunCLIResult; envelope: Record<string, any> }> {
  const result = await specgit(['accept', '--json'], { cwd, env });
  return { result, envelope: parseEnvelope(result) };
}

describe('e2e acceptance: one PR closes N issues (branch mode)', () => {
  acceptanceIt('accepts with exit 0: issues merge across binds, one PR closes all three', async () => {
    const repo = track(makeRepo('feat/one-pr-n-issues'));

    const gh = createFakeGh(repo.dir, greenGhRules({
      sha: repo.sha,
      branch: repo.branch,
      pr: 7,
      issues: [11, 12, 13],
      body: 'Closes #11, fixes #12\nResolves #13',
    }));

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'one-pr-n-issues', '--issue', '11'],
      gh.env()
    );
    await bindDelivery(repo.dir, ['--issue', '12', '--issue', '13', '--pr', '7'], gh.env());

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(0);
    expect(envelope.tool).toBe('specgit');
    expect(envelope.command).toBe('accept');
    expect(envelope.status).toBe('ok');
    expect(envelope.verdict.classification).toBe('accepted');
    expect(envelope.state).toBe('accepted');
    expect(envelope.verdict.evidence.issues).toEqual([11, 12, 13]);
    expect(envelope.verdict.evidence.pr).toBe(7);
    expect(envelope.verdict.evidence.context).toEqual({ kind: 'branch' });
    expect(envelope.verdict.evidence.branch).toBe(repo.branch);
    expect(envelope.verdict.evidence.headSha).toBe(repo.sha);

    const gates = envelope.verdict.gates as Array<{ id: string; status: string }>;
    expect(gates.map((gate) => gate.id)).toEqual([
      'record',
      'policy',
      'completeness',
      'context',
      'origin',
      'provider',
      'issues',
      'sequence',
      'pr',
      'closing',
      'checks',
    ]);
    for (const gate of gates) {
      expect(gate.status, `gate ${gate.id} should pass`).toBe('pass');
    }
  });

  acceptanceIt('uses one PR identity for N bound issues while checking each issue occupancy', async () => {
    const repo = track(makeRepo('feat/aggregate'));

    const gh = createFakeGh(repo.dir, greenGhRules({
      sha: repo.sha,
      branch: repo.branch,
      pr: 42,
      issues: [101, 102],
      body: 'Closes #101\nCloses #102',
    }));

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'aggregate', '--issue', '101', '--issue', '102', '--pr', '42'],
      gh.env()
    );
    const { result } = await acceptJson(repo.dir, gh.env());
    expect(result.exitCode).toBe(0);

    const calls = readFakeGhCalls(gh.logPath);
    // Approved-policy resolution and acceptance read the same bound PR;
    // issue cardinality must not introduce a separate PR per issue.
    const prReads = calls.filter((call) => /\/pulls\/[0-9]+$/.test(call));
    expect(prReads).toHaveLength(2);
    expect([...new Set(prReads)]).toEqual([`api repos/${OWNER}/${REPO}/pulls/42`]);
    for (const issue of [101, 102]) {
      expect(calls.filter((call) => call === `api repos/${OWNER}/${REPO}/issues/${issue}`)).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith(`api repos/${OWNER}/${REPO}/issues/${issue}/timeline?`))).toHaveLength(1);
    }
    expect(calls.filter((call) => call.includes('/check-runs'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('api '))).toHaveLength(8);
  });
});

describe('e2e acceptance: worktree mode', () => {
  acceptanceIt('accepts a linked-worktree delivery with exit 0 and records worktree identity', async () => {
    const wt = track(makeWorktree('feat/worktree-delivery'));

    const gh = createFakeGh(wt.mainDir, greenGhRules({
      sha: wt.sha,
      branch: wt.branch,
      pr: 9,
      issues: [21],
      body: 'Closes #21',
    }));

    await initPolicy(wt.worktreeDir, gh.env());
    await bindDelivery(
      wt.worktreeDir,
      ['--delivery', 'worktree-delivery', '--issue', '21', '--pr', '9'],
      gh.env()
    );

    const { result, envelope } = await acceptJson(wt.worktreeDir, gh.env());

    expect(result.exitCode).toBe(0);
    expect(envelope.verdict.classification).toBe('accepted');
    expect(envelope.verdict.evidence.context).toEqual({ kind: 'worktree' });
    expect(envelope.verdict.evidence.branch).toBe(wt.branch);

    const recordRaw = fs.readFileSync(path.join(wt.worktreeDir, '.specgit.yaml'), 'utf-8');
    expect(recordRaw).toContain('kind: worktree');
    expect(recordRaw).toContain(`label: ${wt.label}`);
    expect(recordRaw).toContain(`branch: ${wt.branch}`);

    expect(fs.existsSync(path.join(wt.mainDir, '.specgit.yaml'))).toBe(false);
  });

  acceptanceIt('rejects when the bound worktree record is evaluated from the wrong checkout', async () => {
    const wt = track(makeWorktree('feat/wt-context'));

    const gh = createFakeGh(wt.mainDir, greenGhRules({
      sha: wt.sha,
      branch: wt.branch,
      pr: 5,
      issues: [31],
      body: 'Closes #31',
    }));

    await initPolicy(wt.worktreeDir, gh.env());
    await bindDelivery(
      wt.worktreeDir,
      ['--delivery', 'wt-context', '--issue', '31', '--pr', '5'],
      gh.env()
    );

    // Replay the record into the main checkout, which is on branch 'main':
    // the live context cannot satisfy the bound worktree context.
    fs.copyFileSync(
      path.join(wt.worktreeDir, '.specgit.yaml'),
      path.join(wt.mainDir, '.specgit.yaml')
    );
    fs.mkdirSync(path.join(wt.mainDir, 'spec_git'), { recursive: true });
    fs.copyFileSync(
      path.join(wt.worktreeDir, 'spec_git', 'policy.yaml'),
      path.join(wt.mainDir, 'spec_git', 'policy.yaml')
    );

    const { result, envelope } = await acceptJson(wt.mainDir, gh.env());

    expect(result.exitCode).toBe(1);
    expect(envelope.verdict.classification).toBe('rejected');
    const codes = (envelope.errors as Array<{ code: string }>).map((error) => error.code);
    expect(codes.some((code) => code === 'branch_mismatch' || code === 'worktree_mismatch')).toBe(
      true
    );
  });
});

describe('e2e acceptance: CI evidence drives the verdict', () => {
  async function runWithChecks(
    checks: Array<{ name: string; status?: string; conclusion?: string | null }>
  ): Promise<{ result: RunCLIResult; envelope: Record<string, any> }> {
    const repo = track(makeRepo(`feat/ci-${checks[0]!.name.replace(/\W+/g, '-')}-${checks[0]!.status ?? checks[0]!.conclusion ?? 'ok'}`));

    const gh = createFakeGh(repo.dir, greenGhRules({
      sha: repo.sha,
      branch: repo.branch,
      pr: 3,
      issues: [51],
      body: 'Closes #51',
      checks,
    }));

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'ci-evidence', '--issue', '51', '--pr', '3'],
      gh.env()
    );
    return acceptJson(repo.dir, gh.env());
  }

  acceptanceIt('successful CI accepts (exit 0)', async () => {
    const { result, envelope } = await runWithChecks([{ name: REQUIRED_CHECK }]);
    expect(result.exitCode).toBe(0);
    expect(envelope.verdict.classification).toBe('accepted');
  });

  acceptanceIt('failed CI rejects (exit 1, checks_failed)', async () => {
    const { result, envelope } = await runWithChecks([
      { name: REQUIRED_CHECK, conclusion: 'failure' },
    ]);
    expect(result.exitCode).toBe(1);
    expect(envelope.verdict.classification).toBe('rejected');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'checks_failed'
    );
  });

  acceptanceIt('pending CI rejects (exit 1, checks_pending)', async () => {
    const { result, envelope } = await runWithChecks([
      { name: REQUIRED_CHECK, status: 'in_progress', conclusion: null },
    ]);
    expect(result.exitCode).toBe(1);
    expect(envelope.verdict.classification).toBe('rejected');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'checks_pending'
    );
  });

  acceptanceIt('a required check that never ran rejects (exit 1, checks_missing)', async () => {
    const { result, envelope } = await runWithChecks([
      { name: 'some-other-job', conclusion: 'success' },
    ]);
    expect(result.exitCode).toBe(1);
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'checks_missing'
    );
  });
});

describe('e2e acceptance: provider failures fail closed (exit 3)', () => {
  acceptanceIt('a gh transport error yields unknown, never an accept', async () => {
    const repo = track(makeRepo('feat/provider-down'));

    const gh = createFakeGh(repo.dir, [
      { match: '^--version$', stdout: 'gh version 2.60.0-fake\n' },
      { match: '^auth status', exit: 0, stdout: 'ok\n' },
      {
        match: '^api repos/',
        exit: 1,
        stderr: 'error: unexpected response: HTTP 502 upstream broken',
      },
    ]);

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'provider-down', '--issue', '61', '--pr', '4'],
      gh.env()
    );

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(3);
    expect(envelope.verdict.classification).toBe('unknown');
    expect(envelope.state).toBe('bound');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'gh_transport'
    );
  });

  acceptanceIt('an unauthenticated gh fails closed without leaking gh stderr (exit 3)', async () => {
    const repo = track(makeRepo('feat/no-auth'));

    const gh = createFakeGh(repo.dir, [
      { match: '^--version$', stdout: 'gh version 2.60.0-fake\n' },
      {
        match: '^auth status|^api repos/.*/pulls/4$',
        exit: 1,
        stderr: 'You are not logged into any GitHub hosts. TOKEN=ghs_supersecret\n',
      },
    ]);

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(repo.dir, ['--delivery', 'no-auth', '--issue', '62', '--pr', '4'], gh.env());

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(3);
    expect(envelope.verdict.classification).toBe('unknown');
    const errors = envelope.errors as Array<{ code: string }>;
    expect(errors.map((error) => error.code)).toContain('gh_unauthenticated');
    expect(result.stdout).not.toContain('ghs_supersecret');
    expect(result.stderr).not.toContain('ghs_supersecret');
  });

  acceptanceIt('a missing gh binary fails closed (exit 3)', async () => {
    const repo = track(makeRepo('feat/no-gh'));
    const gitOnly = gitOnlyPathDir(repo.dir);

    await initPolicy(repo.dir);
    await bindDelivery(repo.dir, ['--delivery', 'no-gh', '--issue', '63', '--pr', '4']);

    const { result, envelope } = await acceptJson(repo.dir, {
      PATH: gitOnly,
      Path: gitOnly,
    });

    expect(result.exitCode).toBe(3);
    expect(envelope.verdict.classification).toBe('unknown');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'gh_missing'
    );
  });
});

describe('e2e acceptance: missing links reject with complete evidence', () => {
  acceptanceIt('rejects when the PR body does not close every bound issue', async () => {
    const repo = track(makeRepo('feat/unclosed'));

    const gh = createFakeGh(repo.dir, greenGhRules({
      sha: repo.sha,
      branch: repo.branch,
      pr: 6,
      issues: [71, 72],
      body: 'Only closes #71 — the other issue is forgotten.',
    }));

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'unclosed', '--issue', '71', '--issue', '72', '--pr', '6'],
      gh.env()
    );

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(1);
    expect(envelope.verdict.classification).toBe('rejected');
    const closingGate = (envelope.verdict.gates as Array<{ id: string; status: string; failures: Array<{ code: string; detail?: unknown }> }>).find(
      (gate) => gate.id === 'closing'
    );
    expect(closingGate?.status).toBe('fail');
    const closingFailure = closingGate!.failures.find(
      (failure) => failure.code === 'closing_refs_incomplete'
    );
    expect(closingFailure).toBeDefined();
    expect(closingFailure!.detail).toEqual({ missing: [72] });
  });

  acceptanceIt('rejects when a bound issue does not exist (issue_not_found)', async () => {
    const repo = track(makeRepo('feat/ghost-issue'));

    const gh = createFakeGh(repo.dir, [
      { match: '^--version$', stdout: 'gh version 2.60.0-fake\n' },
      { match: '^auth status', exit: 0, stdout: 'ok\n' },
      {
        match: `^api repos/${OWNER}/${REPO}/issues/999$`,
        exit: 1,
        stderr: 'HTTP 404: Not Found',
      },
      {
        match: `^api repos/${OWNER}/${REPO}/pulls/8$`,
        stdout: prJson({ number: 8, branch: repo.branch, sha: repo.sha, body: 'Closes #999' }),
      },
      emptyTimelineRule(),
      {
        match: '^api repos/.+/check-runs',
        stdout: checkRunsJson([{ name: REQUIRED_CHECK }]),
      },
    ]);

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'ghost-issue', '--issue', '999', '--pr', '8'],
      gh.env()
    );

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(1);
    expect(envelope.verdict.classification).toBe('rejected');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'issue_not_found'
    );
  });

  acceptanceIt('rejects when a bound issue number is actually a pull request', async () => {
    const repo = track(makeRepo('feat/issue-is-pr'));

    const rules = greenGhRules({
      sha: repo.sha,
      branch: repo.branch,
      pr: 12,
      issues: [81],
      body: 'Closes #81',
    });
    const issueRuleIndex = rules.findIndex((rule) => rule.match.includes('/issues/81'));
    rules[issueRuleIndex] = {
      match: `^api repos/${OWNER}/${REPO}/issues/81$`,
      stdout: JSON.stringify({ number: 81, state: 'open', pull_request: { url: 'x' } }),
    };
    const gh = createFakeGh(repo.dir, rules);

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'issue-is-pr', '--issue', '81', '--pr', '12'],
      gh.env()
    );

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(1);
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'issue_is_pull_request'
    );
  });

  acceptanceIt('rejects a PR url bound from a different repository (pr_repo_mismatch)', async () => {
    const repo = track(makeRepo('feat/foreign-pr'));

    const gh = createFakeGh(repo.dir, [
      { match: '^--version$', stdout: 'gh version 2.60.0-fake\n' },
      { match: '^auth status', exit: 0, stdout: 'ok\n' },
      { match: `^api repos/${OWNER}/${REPO}/issues/91$`, stdout: issueJson(91) },
    ]);

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      [
        '--delivery',
        'foreign-pr',
        '--issue',
        '91',
        '--pr',
        'https://github.com/some-other/repo/pull/17',
      ],
      gh.env()
    );

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(1);
    expect(envelope.verdict.classification).toBe('rejected');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'pr_repo_mismatch'
    );
  });

  acceptanceIt('accept without any record fails closed (unbound, exit 3)', async () => {
    const repo = track(makeRepo('feat/unbound'));
    const gh = createFakeGh(repo.dir, [
      { match: '^--version$', stdout: 'gh version 2.60.0-fake\n' },
      { match: '^auth status', exit: 0, stdout: 'ok\n' },
    ]);
    await initPolicy(repo.dir, gh.env());

    const { result, envelope } = await acceptJson(repo.dir, gh.env());

    expect(result.exitCode).toBe(3);
    expect(envelope.state).toBe('unbound');
    expect(envelope.verdict.classification).toBe('unknown');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'record_missing'
    );
  });
});

describe('e2e acceptance: spec/task artifacts can never change acceptance', () => {
  acceptanceIt('fabricated done-tasks/spec files cannot forge acceptance (still rejected, exit 1)', async () => {
    const repo = track(makeRepo('feat/forge-attempt'));

    const failingChecks = checkRunsJson([
      { name: REQUIRED_CHECK, status: 'completed', conclusion: 'failure' },
    ]);
    const rules = [
      { match: '^--version$', stdout: 'gh version 2.60.0-fake\n' },
      { match: '^auth status', exit: 0, stdout: 'ok\n' },
      { match: `^api repos/${OWNER}/${REPO}/issues/111$`, stdout: issueJson(111) },
      {
        match: `^api repos/${OWNER}/${REPO}/pulls/13$`,
        stdout: prJson({ number: 13, branch: repo.branch, sha: repo.sha, body: 'Closes #111' }),
      },
      emptyTimelineRule(),
      { match: '^api repos/.+/check-runs', stdout: failingChecks },
    ];

    await initPolicy(repo.dir);
    await bindDelivery(repo.dir, ['--delivery', 'forge-attempt', '--issue', '111', '--pr', '13']);

    const before = await specgit(['accept', '--json'], {
      cwd: repo.dir,
      env: createFakeGh(repo.dir, rules).env(),
    });
    expect(before.exitCode).toBe(1);

    pileArtifacts(repo.dir);

    const after = await specgit(['accept', '--json'], {
      cwd: repo.dir,
      env: createFakeGh(repo.dir, rules).env(),
    });

    expect(after.exitCode).toBe(1);
    const beforeEnvelope = parseEnvelope(before);
    const afterEnvelope = parseEnvelope(after);
    expect(afterEnvelope.verdict.classification).toBe('rejected');
    expect(afterEnvelope.gates).toEqual(beforeEnvelope.gates);
    expect(JSON.stringify(afterEnvelope)).toContain('checks_failed');
  });

  acceptanceIt('fabricated artifacts cannot block a genuine acceptance (still exit 0)', async () => {
    const repo = track(makeRepo('feat/artifact-noise'));

    const gh = createFakeGh(repo.dir, greenGhRules({
      sha: repo.sha,
      branch: repo.branch,
      pr: 14,
      issues: [121],
      body: 'Closes #121',
    }));

    await initPolicy(repo.dir, gh.env());
    await bindDelivery(
      repo.dir,
      ['--delivery', 'artifact-noise', '--issue', '121', '--pr', '14'],
      gh.env()
    );

    const clean = await specgit(['accept', '--json'], { cwd: repo.dir, env: gh.env() });
    expect(clean.exitCode).toBe(0);

    pileArtifacts(repo.dir);

    const noisy = await specgit(['accept', '--json'], { cwd: repo.dir, env: gh.env() });
    expect(noisy.exitCode).toBe(0);
    expect(parseEnvelope(noisy).verdict.classification).toBe('accepted');
  });
});
