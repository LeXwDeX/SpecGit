import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fail, ok, type Evidence } from '../../src/kernel/evidence.js';
import { DeliveryBindingSchema, type DeliveryBinding } from '../../src/record/schema.js';
import type { Policy } from '../../src/record/policy.js';
import type { GitFacts, GitPort } from '../../src/gitfacts/port.js';
import type { SpawnFn as GitSpawnFn } from '../../src/gitfacts/local.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { GhCliGitHubProvider, resolveNodeScriptCommand, type SpawnFn as GhSpawnFn } from '../../src/github/gh-cli.js';
import {
  evaluate,
  type EvaluateInput,
  type GateId,
  type Verdict,
} from '../../src/acceptance/evaluate.js';
import {
  MockGitHubProvider,
  makeCheckRun,
  makeIssueFact,
  makePrFact,
} from './helpers/mock-github.js';
import { createFakeGh } from './helpers/fake-gh.js';
import { git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const POLICY: Policy = { version: 1, required_checks: ['All checks passed'] };
const HEAD = 'b'.repeat(40);

class StubGitPort implements GitPort {
  constructor(private readonly f: GitFacts) {}

  async facts(): Promise<GitFacts> {
    return this.f;
  }
}

function facts(overrides: Partial<GitFacts> = {}): GitFacts {
  return {
    repo: true,
    toplevel: '/repo',
    branch: 'feat/123-login',
    headSha: HEAD,
    dirty: false,
    isLinkedWorktree: false,
    worktreeLabel: null,
    worktrees: [{ label: 'repo', branch: 'feat/123-login' }],
    originUrl: 'https://github.com/LeXwDeX/SpecGit.git',
    upstreamDrift: null,
    gitAvailable: true,
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}): DeliveryBinding {
  return DeliveryBindingSchema.parse({
    version: 1,
    delivery: 'add-login-flow',
    context: { kind: 'branch', branch: 'feat/123-login' },
    issues: [123],
    pr: 42,
    ...overrides,
  });
}

function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    root: ok('/repo'),
    record: ok(binding()),
    policy: ok(POLICY),
    git: new StubGitPort(facts()),
    gh: new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    }),
    ...overrides,
  };
}

function gate(verdict: Verdict, id: GateId) {
  const found = verdict.gates.find((g) => g.id === id);
  expect(found, `gate ${id}`).toBeTruthy();
  return found!;
}

describe('acceptance evaluator', () => {
  it('accepts an all-green delivery', async () => {
    const verdict = await evaluate(input());
    expect(verdict.accepted).toBe(true);
    expect(verdict.classification).toBe('accepted');
    expect(verdict.exitCode).toBe(0);
    expect(verdict.state).toBe('accepted');
    expect(verdict.complete).toBe(true);
    for (const g of verdict.gates) {
      expect(g.status).toBe('pass');
    }
    expect(verdict.evidence.repo).toBe('LeXwDeX/SpecGit');
    expect(verdict.evidence.prHead).toBe(HEAD);
  });

  it('reports local_head_stale as a warning only, never a gate', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: 'c'.repeat(40) })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(input({ gh }));
    expect(verdict.accepted).toBe(true);
    expect(verdict.warnings.map((w) => w.code)).toContain('local_head_stale');
  });

  const truthTable: Array<{
    name: string;
    input: () => EvaluateInput;
    gate: GateId;
    code: string;
    classification: 'rejected' | 'unknown';
    state?: Verdict['state'];
    detail?: (failure: { detail?: unknown }) => void;
  }> = [
    {
      name: 'record_missing',
      input: () => input({ record: fail('record_missing', 'No .specgit.yaml found.') }),
      gate: 'record',
      code: 'record_missing',
      classification: 'unknown',
      state: 'unbound',
    },
    {
      name: 'record_invalid',
      input: () => input({ record: fail('record_invalid', 'Corrupt record.') }),
      gate: 'record',
      code: 'record_invalid',
      classification: 'unknown',
      state: 'unknown',
    },
    {
      name: 'policy_missing',
      input: () => input({ policy: fail('policy_missing', 'No policy.yaml found.') }),
      gate: 'policy',
      code: 'policy_missing',
      classification: 'unknown',
    },
    {
      name: 'policy_invalid',
      input: () => input({ policy: fail('policy_invalid', 'required_checks must be non-empty.') }),
      gate: 'policy',
      code: 'policy_invalid',
      classification: 'unknown',
    },
    {
      name: 'issues_empty',
      input: () => input({ record: ok(binding({ issues: [] })) }),
      gate: 'completeness',
      code: 'issues_empty',
      classification: 'rejected',
      state: 'draft',
    },
    {
      name: 'pr_missing',
      input: () => input({ record: ok(binding({ pr: undefined })) }),
      gate: 'completeness',
      code: 'pr_missing',
      classification: 'rejected',
      state: 'draft',
    },
    {
      name: 'not_a_git_repo',
      input: () => input({ root: fail('not_a_git_repo', 'Not a git repository.') }),
      gate: 'context',
      code: 'not_a_git_repo',
      classification: 'unknown',
    },
    {
      name: 'git_unavailable',
      input: () => input({ git: new StubGitPort(facts({ gitAvailable: false, repo: false })) }),
      gate: 'context',
      code: 'git_unavailable',
      classification: 'unknown',
    },
    {
      name: 'no_commits',
      input: () => input({ git: new StubGitPort(facts({ headSha: null })) }),
      gate: 'context',
      code: 'no_commits',
      classification: 'unknown',
    },
    {
      name: 'detached_head',
      input: () => input({ git: new StubGitPort(facts({ branch: null })) }),
      gate: 'context',
      code: 'detached_head',
      classification: 'rejected',
    },
    {
      name: 'branch_mismatch',
      input: () => input({ git: new StubGitPort(facts({ branch: 'other-branch' })) }),
      gate: 'context',
      code: 'branch_mismatch',
      classification: 'rejected',
    },
    {
      name: 'worktree_mismatch (not a linked worktree)',
      input: () =>
        input({
          record: ok(
            binding({ context: { kind: 'worktree', label: '123-login', branch: 'feat/123-login' } })
          ),
          git: new StubGitPort(facts({ isLinkedWorktree: false })),
        }),
      gate: 'context',
      code: 'worktree_mismatch',
      classification: 'rejected',
    },
    {
      name: 'worktree_mismatch (label resolves to another branch)',
      input: () =>
        input({
          record: ok(
            binding({ context: { kind: 'worktree', label: '123-login', branch: 'feat/123-login' } })
          ),
          git: new StubGitPort(
            facts({
              isLinkedWorktree: true,
              worktreeLabel: '123-login',
              worktrees: [{ label: '123-login', branch: 'feat/something-else' }],
            })
          ),
        }),
      gate: 'context',
      code: 'worktree_mismatch',
      classification: 'rejected',
    },
    {
      name: 'no_origin',
      input: () => input({ git: new StubGitPort(facts({ originUrl: null })) }),
      gate: 'origin',
      code: 'no_origin',
      classification: 'rejected',
    },
    {
      name: 'origin_unresolvable',
      input: () =>
        input({ git: new StubGitPort(facts({ originUrl: 'https://gitlab.com/o/r.git' })) }),
      gate: 'origin',
      code: 'origin_unresolvable',
      classification: 'rejected',
    },
    {
      name: 'gh_missing',
      input: () =>
        input({
          gh: new MockGitHubProvider({ preflight: fail('gh_missing', 'gh not installed.') }),
        }),
      gate: 'provider',
      code: 'gh_missing',
      classification: 'unknown',
    },
    {
      name: 'gh_unauthenticated',
      input: () =>
        input({
          gh: new MockGitHubProvider({ preflight: fail('gh_unauthenticated', 'Not logged in.') }),
        }),
      gate: 'provider',
      code: 'gh_unauthenticated',
      classification: 'unknown',
    },
    {
      name: 'gh_transport (preflight)',
      input: () =>
        input({
          gh: new MockGitHubProvider({ preflight: fail('gh_transport', 'boom') }),
        }),
      gate: 'provider',
      code: 'gh_transport',
      classification: 'unknown',
    },
    {
      name: 'issue_not_found',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            issues: { 123: fail('issue_not_found', 'Issue #123 not found.') },
            pr: ok(makePrFact({ headSha: HEAD })),
            checkRuns: ok([makeCheckRun('All checks passed')]),
          }),
        }),
      gate: 'issues',
      code: 'issue_not_found',
      classification: 'rejected',
    },
    {
      name: 'issue_is_pull_request',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            issues: { 123: ok(makeIssueFact({ number: 123, pullRequest: true })) },
            pr: ok(makePrFact({ headSha: HEAD })),
            checkRuns: ok([makeCheckRun('All checks passed')]),
          }),
        }),
      gate: 'issues',
      code: 'issue_is_pull_request',
      classification: 'rejected',
    },
    {
      name: 'gh_transport (issue lookup)',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            issues: { 123: fail('gh_transport', 'network down') },
          }),
        }),
      gate: 'issues',
      code: 'gh_transport',
      classification: 'unknown',
    },
    {
      name: 'pr_not_found',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            pr: fail('pr_not_found', 'PR 42 not found.'),
            checkRuns: ok([makeCheckRun('All checks passed')]),
          }),
        }),
      gate: 'pr',
      code: 'pr_not_found',
      classification: 'rejected',
    },
    {
      name: 'pr_closed_unmerged',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            pr: ok(makePrFact({ state: 'closed', headSha: HEAD })),
            checkRuns: ok([makeCheckRun('All checks passed')]),
          }),
        }),
      gate: 'pr',
      code: 'pr_closed_unmerged',
      classification: 'rejected',
    },
    {
      name: 'pr_head_mismatch',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            pr: ok(makePrFact({ headBranch: 'some-other-branch', headSha: HEAD })),
            checkRuns: ok([makeCheckRun('All checks passed')]),
          }),
        }),
      gate: 'pr',
      code: 'pr_head_mismatch',
      classification: 'rejected',
    },
    {
      name: 'pr_repo_mismatch',
      input: () =>
        input({
          record: ok(binding({ pr: 'https://github.com/other/repo/pull/42' })),
          gh: new MockGitHubProvider({
            pr: ok(makePrFact({ headSha: HEAD })),
            checkRuns: ok([makeCheckRun('All checks passed')]),
          }),
        }),
      gate: 'pr',
      code: 'pr_repo_mismatch',
      classification: 'rejected',
    },
    {
      name: 'gh_transport (check runs)',
      input: () =>
        input({
          gh: new MockGitHubProvider({
            pr: ok(makePrFact({ headSha: HEAD })),
            checkRuns: fail('gh_transport', 'network down'),
          }),
        }),
      gate: 'checks',
      code: 'gh_transport',
      classification: 'unknown',
    },
  ];

  it.each(truthTable)('failure code: $name', async ({ input: makeInput, gate: gateId, code, classification, state }) => {
    const verdict = await evaluate(makeInput());
    expect(verdict.classification).toBe(classification);
    expect(verdict.exitCode).toBe(classification === 'rejected' ? 1 : 3);
    expect(verdict.accepted).toBe(false);
    const g = gate(verdict, gateId);
    expect(g.status).toBe('fail');
    expect(g.failures.map((f) => f.code)).toContain(code);
    if (state !== undefined) {
      expect(verdict.state).toBe(state);
    }
  });

  it('accepts a worktree-context delivery end to end', async () => {
    const verdict = await evaluate(
      input({
        record: ok(
          binding({ context: { kind: 'worktree', label: '123-login', branch: 'feat/123-login' } })
        ),
        git: new StubGitPort(
          facts({
            isLinkedWorktree: true,
            worktreeLabel: '123-login',
            worktrees: [{ label: '123-login', branch: 'feat/123-login' }],
          })
        ),
      })
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.state).toBe('accepted');
  });

  it('closing_refs_incomplete lists exactly the missing issue numbers', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD, body: 'Closes #123' })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({ record: ok(binding({ issues: [123, 124, 125] })), gh })
    );
    const g = gate(verdict, 'closing');
    expect(g.status).toBe('fail');
    const failure = g.failures.find((f) => f.code === 'closing_refs_incomplete');
    expect(failure).toBeTruthy();
    expect(failure!.detail).toEqual({ missing: [124, 125] });
    expect(verdict.classification).toBe('rejected');
  });

  it('enumerates every failing required check name in one gate', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([
        makeCheckRun('Test', { status: 'in_progress', conclusion: null }),
        makeCheckRun('Unrelated', { conclusion: 'failure' }),
      ]),
    });
    const verdict = await evaluate(
      input({
        policy: ok({ version: 1, required_checks: ['All checks passed', 'Test', 'Lint'] }),
        gh,
      })
    );
    const g = gate(verdict, 'checks');
    expect(g.status).toBe('fail');
    const byName = Object.fromEntries(
      g.failures.map((f) => [(f.detail as { name: string }).name, f.code])
    );
    expect(byName).toEqual({
      'All checks passed': 'checks_missing',
      Test: 'checks_pending',
      Lint: 'checks_missing',
    });
    expect(verdict.classification).toBe('rejected');
  });

  it('reports checks_failed with the failing conclusion', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed', { conclusion: 'failure' })]),
    });
    const verdict = await evaluate(input({ gh }));
    const g = gate(verdict, 'checks');
    expect(g.failures.map((f) => f.code)).toEqual(['checks_failed']);
    expect(g.failures[0].detail).toEqual({ name: 'All checks passed', conclusion: 'failure' });
  });

  it('short-circuits in gate order G1 through G10', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({ record: fail('record_missing', 'absent'), policy: fail('policy_missing', 'absent'), gh })
    );
    expect(gate(verdict, 'record').status).toBe('fail');
    expect(gate(verdict, 'policy').status).toBe('skipped');
    expect(gate(verdict, 'checks').status).toBe('skipped');
    expect(gh.calls).toEqual([]);
  });

  it('stops calling the provider once a deterministic gate fails', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({ git: new StubGitPort(facts({ branch: 'detached' })), gh })
    );
    expect(verdict.classification).toBe('rejected');
    expect(gh.calls).toEqual([]);
  });

  it('stops after local gates when no provider is supplied (status mode)', async () => {
    const verdict = await evaluate(input({ gh: undefined }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.classification).toBe('unknown');
    expect(verdict.exitCode).toBe(3);
    expect(verdict.complete).toBe(false);
    expect(verdict.state).toBe('bound');
    for (const id of ['provider', 'issues', 'pr', 'closing', 'checks'] as GateId[]) {
      expect(gate(verdict, id).status).toBe('skipped');
    }
    for (const id of ['record', 'policy', 'completeness', 'context', 'origin'] as GateId[]) {
      expect(gate(verdict, id).status).toBe('pass');
    }
  });

  it('resolves a PR URL ref matching origin and queries by number', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({ record: ok(binding({ pr: 'https://github.com/lexwdex/specgit/pull/42' })), gh })
    );
    expect(verdict.accepted).toBe(true);
    expect(gh.calls.some((c) => c === 'getPr:LeXwDeX/SpecGit#42')).toBe(true);
  });

  it('collects all failing issues within the issues gate', async () => {
    const gh = new MockGitHubProvider({
      issues: {
        123: fail('issue_not_found', 'Issue #123 not found.'),
        124: ok(makeIssueFact({ number: 124, pullRequest: true })),
      },
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({ record: ok(binding({ issues: [123, 124] })), gh })
    );
    const g = gate(verdict, 'issues');
    expect(g.failures.map((f) => f.code).sort()).toEqual([
      'issue_is_pull_request',
      'issue_not_found',
    ]);
  });
});

describe('acceptance evaluator evidence discipline', () => {
  let tempDir: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  const execFileAsync = promisify(execFile);

  const realSpawn: GitSpawnFn & GhSpawnFn = async (command, args, options) => {
    // Mirror the production spawn seam: a node-shebang gh command runs
    // through the current Node executable on every platform.
    const resolved = resolveNodeScriptCommand(command);
    const result = await execFileAsync(resolved.command, [...resolved.scriptArgs, ...args], {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: options.env,
      cwd: options.cwd,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };

  beforeEach(() => {
    tempDir = makeTempDir('specgit-evidence-');
    ({ root, env } = initRepo(tempDir));
    git(root, ['remote', 'add', 'origin', 'https://github.com/LeXwDeX/SpecGit.git'], env);
    fs.writeFileSync(path.join(root, 'tasks.md'), '- [x] every task complete\n');
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'add-login'), { recursive: true });
    fs.writeFileSync(path.join(root, 'openspec', 'changes', 'add-login', 'tasks.md'), '# done\n');
    fs.writeFileSync(path.join(root, 'openspec', 'changes', 'add-login', 'proposal.md'), '# done\n');
    fs.writeFileSync(path.join(root, 'openspec', 'changes', 'add-login', 'design.md'), '# done\n');
    fs.writeFileSync(path.join(root, 'openspec', 'changes', 'add-login', 'spec.md'), '# done\n');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('rejects despite legacy artifacts claiming completion; never reads artifacts; spawns only git/gh', async () => {
    const headSha = git(root, ['rev-parse', 'HEAD'], env).trim();
    const fake = createFakeGh(tempDir, [
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', stdout: 'ok\n' },
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/123$',
        stdout: JSON.stringify({ number: 123, state: 'open' }),
      },
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          merged_at: null,
          head: { ref: 'main', sha: headSha },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
      { match: 'check-runs', stdout: JSON.stringify({ total_count: 0, check_runs: [] }) },
    ]);

    const spawned: Array<{ command: string; args: string[] }> = [];
    const recordingSpawn: GitSpawnFn & GhSpawnFn = async (command, args, options) => {
      spawned.push({ command, args });
      return realSpawn(command, args, options);
    };

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');

    try {
      const verdict = await evaluate({
        root: ok(root),
        record: ok(binding({ context: { kind: 'branch', branch: 'main' } })),
        policy: ok(POLICY),
        git: new LocalGitAdapter({ spawnImpl: recordingSpawn }),
        gh: new GhCliGitHubProvider({
          env: fake.env({ PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}` }),
          spawnImpl: recordingSpawn,
        }),
      });

      expect(verdict.classification).toBe('rejected');
      expect(verdict.exitCode).toBe(1);
      const checksGate = gate(verdict, 'checks');
      expect(checksGate.failures.map((f) => f.code)).toEqual(['checks_missing']);

      const commands = new Set(spawned.map((s) => s.command));
      // git for local facts; the fake gh script (SPECGIT_GH seam) for
      // GitHub evidence — nothing else may ever be spawned.
      expect(commands.has('git')).toBe(true);
      for (const entry of spawned) {
        if (entry.command === 'git') continue;
        expect(entry.command).toMatch(/fake-gh\.cjs$/);
      }

      const artifactPattern = /(^|[\\/])(tasks|proposal|design|spec)\.md$/;
      const openspecPattern = /(^|[\\/])openspec([\\/]|$)/;
      for (const call of readFileSpy.mock.calls) {
        const target = String(call[0]);
        expect(target).not.toMatch(artifactPattern);
        expect(target).not.toMatch(openspecPattern);
      }
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
