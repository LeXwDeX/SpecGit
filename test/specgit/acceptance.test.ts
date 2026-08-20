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
import { createFakeGh, type FakeGhRule } from './helpers/fake-gh.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const POLICY: Policy = { version: 1, required_checks: ['All checks passed'] };
const HEAD = 'b'.repeat(40);
// GitHub's merge_commit_sha: a base-branch commit under every merge method,
// deliberately distinct from both the local HEAD and the PR head SHA.
const MERGE_SHA = 'm'.repeat(40);

type ContainmentScript = (sha: string) => Evidence<{ contained: boolean }>;

class StubGitPort implements GitPort {
  readonly headContainsCalls: string[] = [];

  constructor(
    private readonly f: GitFacts,
    // Fail-closed default: a merged-record test that does not pin lineage
    // evidence cannot accidentally pass as contained.
    private readonly containment: ContainmentScript = () =>
      fail('merged_lineage_unavailable', 'headContains not configured in stub')
  ) {}

  async facts(): Promise<GitFacts> {
    return this.f;
  }

  async headContains(_root: string, sha: string): Promise<Evidence<{ contained: boolean }>> {
    this.headContainsCalls.push(sha);
    return this.containment(sha);
  }

  async checkoutOrCreateBranch(): Promise<never> {
    throw new Error('write operations are not part of the evaluation contract');
  }

  async commitFile(): Promise<never> {
    throw new Error('write operations are not part of the evaluation contract');
  }

  async pushBranch(): Promise<never> {
    throw new Error('write operations are not part of the evaluation contract');
  }

  async remoteDefaultBranch(): Promise<never> {
    throw new Error('write operations are not part of the evaluation contract');
  }

  async hooksPath(): Promise<never> {
    throw new Error('write operations are not part of the evaluation contract');
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

  it('ordered_issues rejects when a smaller open issue exists (issue_out_of_order)', async () => {
    const gh = new MockGitHubProvider({
      issues: {
        122: ok(makeIssueFact({ number: 122, state: 'open' })),
        123: ok(makeIssueFact({ number: 123 })),
      },
      openIssueNumbers: ok([122, 200]),
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({
        gh,
        policy: ok({ version: 1, required_checks: ['All checks passed'], ordered_issues: true }),
      })
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.exitCode).toBe(1);
    const seq = gate(verdict, 'sequence');
    expect(seq.status).toBe('fail');
    expect(seq.failures[0].code).toBe('issue_out_of_order');
    expect(JSON.stringify(seq.failures[0].detail)).toContain('122');
  });

  it('ordered_issues passes when every smaller issue is closed', async () => {
    const gh = new MockGitHubProvider({
      openIssueNumbers: ok([123, 200]),
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({
        gh,
        policy: ok({ version: 1, required_checks: ['All checks passed'], ordered_issues: true }),
      })
    );
    expect(verdict.accepted).toBe(true);
    expect(gate(verdict, 'sequence').status).toBe('pass');
  });

  it('ordered_issues off (default) never queries open issues', async () => {
    const gh = new MockGitHubProvider({
      openIssueNumbers: ok([1, 2, 3]),
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(input({ gh }));
    expect(verdict.accepted).toBe(true);
    expect(gh.calls).not.toContain('getOpenIssueNumbers:LeXwDeX/SpecGit');
    // The gate passes vacuously: the verdict must stay complete without it.
    const seq = verdict.gates.find((g) => g.id === 'sequence');
    expect(seq?.status).toBe('pass');
  });

  it('sequence gate degrades to unknown (exit 3) when the open-issue list is truncated (#120, I3b)', async () => {
    const gh = new MockGitHubProvider({
      openIssueNumbers: fail('evidence_truncated', 'GitHub reported incomplete search results.'),
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const verdict = await evaluate(
      input({
        gh,
        policy: ok({ version: 1, required_checks: ['All checks passed'], ordered_issues: true }),
      })
    );
    expect(verdict.classification).toBe('unknown');
    expect(verdict.exitCode).toBe(3);
    const seq = gate(verdict, 'sequence');
    expect(seq.status).toBe('fail');
    expect(seq.failures[0].code).toBe('evidence_truncated');
  });

  it('checks gate degrades to unknown (exit 3) when the check-run list is truncated (#120, I3b)', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: fail('evidence_truncated', 'Check-run pagination hit its cap.'),
    });
    const verdict = await evaluate(input({ gh }));
    expect(verdict.classification).toBe('unknown');
    expect(verdict.exitCode).toBe(3);
    const checks = gate(verdict, 'checks');
    expect(checks.status).toBe('fail');
    expect(checks.failures[0].code).toBe('evidence_truncated');
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

  it('accepts a merged-delivery record on main instead of branch_mismatch', async () => {
    // The record binds feat/123-login but we are on main, and the bound PR
    // is merged: completed history, not a mismatch — but only once local
    // HEAD is proven to contain the merged delivery (the merge commit).
    // The trailing gates run against the merged PR's evidence.
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ state: 'merged', mergeCommitSha: MERGE_SHA })),
      checkRuns: ok([makeCheckRun('All checks passed')]),
    });
    const git = new StubGitPort(facts({ branch: 'main' }), () => ok({ contained: true }));
    const verdict = await evaluate(input({ git, gh }));
    expect(verdict.accepted).toBe(true);
    expect(verdict.exitCode).toBe(0);
    expect(git.headContainsCalls).toEqual([MERGE_SHA]);
    expect(verdict.warnings.map((w) => w.code)).toContain('record_of_merged_delivery');
  });

  it('keeps branch_mismatch when the bound PR is open, not merged', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ state: 'open' })),
    });
    const verdict = await evaluate(
      input({ git: new StubGitPort(facts({ branch: 'main' })), gh })
    );
    expect(verdict.classification).toBe('rejected');
    const context = verdict.gates.find((g) => g.id === 'context');
    expect(context?.failures.map((f) => f.code)).toEqual(['branch_mismatch']);
  });

  it('keeps branch_mismatch when the provider cannot confirm the merge (fail-closed)', async () => {
    const gh = new MockGitHubProvider({
      pr: fail('gh_transport', 'network down'),
    });
    const verdict = await evaluate(
      input({ git: new StubGitPort(facts({ branch: 'main' })), gh })
    );
    const context = verdict.gates.find((g) => g.id === 'context');
    expect(context?.failures.map((f) => f.code)).toEqual(['branch_mismatch']);
  });

  describe('merged-delivery lineage (issue #64)', () => {
    // Historical acceptance must prove that local HEAD contains the actual
    // merged delivery. GitHub reports one strategy-invariant anchor: the
    // merge_commit_sha, which after a merge is a commit on the base branch
    // for merge commits, squashes, and rebases alike. Containment of that
    // anchor in local HEAD is the lineage proof.

    it('contains: historical acceptance only after proving the merge commit is contained by local HEAD', async () => {
      const gh = new MockGitHubProvider({
        pr: ok(makePrFact({ state: 'merged', mergeCommitSha: MERGE_SHA })),
        checkRuns: ok([makeCheckRun('All checks passed')]),
      });
      // Keyed by sha: only the merge anchor resolves; asking for any other
      // sha (e.g. the PR head) is unavailable evidence.
      const git = new StubGitPort(facts({ branch: 'main' }), (sha) =>
        sha === MERGE_SHA
          ? ok({ contained: true })
          : fail('merged_lineage_unavailable', `unexpected lineage query for ${sha}`)
      );
      const verdict = await evaluate(input({ git, gh }));
      expect(verdict.classification).toBe('accepted');
      expect(verdict.accepted).toBe(true);
      expect(verdict.exitCode).toBe(0);
      expect(verdict.state).toBe('accepted');
      expect(git.headContainsCalls).toEqual([MERGE_SHA]);
      expect(gate(verdict, 'context').status).toBe('pass');
      expect(verdict.warnings.map((w) => w.code)).toContain('record_of_merged_delivery');
    });

    it('does-not-contain: rejects when the merge commit is locally known but not in HEAD history', async () => {
      const gh = new MockGitHubProvider({
        pr: ok(makePrFact({ state: 'merged', mergeCommitSha: MERGE_SHA })),
        checkRuns: ok([makeCheckRun('All checks passed')]),
      });
      const git = new StubGitPort(facts({ branch: 'main' }), () => ok({ contained: false }));
      const verdict = await evaluate(input({ git, gh }));
      expect(verdict.classification).toBe('rejected');
      expect(verdict.accepted).toBe(false);
      expect(verdict.exitCode).toBe(1);
      expect(verdict.state).toBe('rejected');
      const context = gate(verdict, 'context');
      expect(context.status).toBe('fail');
      expect(context.failures.map((f) => f.code)).toEqual(['merged_delivery_not_contained']);
      expect(context.failures[0].detail).toEqual({ mergeCommitSha: MERGE_SHA, headSha: HEAD });
      // No historical green without the proof.
      expect(verdict.warnings.map((w) => w.code)).not.toContain('record_of_merged_delivery');
    });

    it('unavailable evidence (local): fails closed to unknown when lineage cannot be resolved', async () => {
      const gh = new MockGitHubProvider({
        pr: ok(makePrFact({ state: 'merged', mergeCommitSha: MERGE_SHA })),
        checkRuns: ok([makeCheckRun('All checks passed')]),
      });
      // The merge commit is unknown to the local object store (never
      // fetched): the lineage question has no answer, so no verdict.
      const git = new StubGitPort(facts({ branch: 'main' }), () =>
        fail('merged_lineage_unavailable', 'not a valid object name')
      );
      const verdict = await evaluate(input({ git, gh }));
      expect(verdict.classification).toBe('unknown');
      expect(verdict.accepted).toBe(false);
      expect(verdict.exitCode).toBe(3);
      expect(verdict.state).toBe('bound');
      const context = gate(verdict, 'context');
      expect(context.failures.map((f) => f.code)).toEqual(['merged_lineage_unavailable']);
      expect(git.headContainsCalls).toEqual([MERGE_SHA]);
    });

    it('unavailable evidence (provider): a merged PR without merge_commit_sha never falls back to the PR head', async () => {
      // GitHub guarantees merge_commit_sha once merged; its absence is an
      // evidence gap. The PR head is definitionally absent from the base
      // under squash and rebase, so it can never anchor containment.
      const gh = new MockGitHubProvider({
        pr: ok(makePrFact({ state: 'merged', mergeCommitSha: null, headSha: 'a'.repeat(40) })),
        checkRuns: ok([makeCheckRun('All checks passed')]),
      });
      // The stub would answer "contained" for any sha it is asked about —
      // the evaluator must not ask, because there is no anchor to ask with.
      const git = new StubGitPort(facts({ branch: 'main' }), () => ok({ contained: true }));
      const verdict = await evaluate(input({ git, gh }));
      expect(verdict.classification).toBe('unknown');
      expect(verdict.exitCode).toBe(3);
      expect(git.headContainsCalls).toEqual([]);
      const context = gate(verdict, 'context');
      expect(context.failures.map((f) => f.code)).toEqual(['merged_lineage_unavailable']);
    });

    it('keeps evidence-kind passthrough when git itself is unavailable mid-lineage', async () => {
      const gh = new MockGitHubProvider({
        pr: ok(makePrFact({ state: 'merged', mergeCommitSha: MERGE_SHA })),
      });
      const git = new StubGitPort(facts({ branch: 'main' }), () =>
        fail('git_unavailable', 'The git executable could not be found.')
      );
      const verdict = await evaluate(input({ git, gh }));
      expect(verdict.classification).toBe('unknown');
      expect(verdict.exitCode).toBe(3);
      const context = gate(verdict, 'context');
      expect(context.failures.map((f) => f.code)).toEqual(['git_unavailable']);
    });
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

  it('presents checks_pending as transient and retryable while staying exit 1', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed', { status: 'in_progress', conclusion: null })]),
    });
    const verdict = await evaluate(input({ gh }));
    const g = gate(verdict, 'checks');
    expect(g.failures.map((f) => f.code)).toEqual(['checks_pending']);
    // #68: pending is honestly labeled transient and retryable, never a
    // repair demand, and never reclassified (factual, exit 1 preserved).
    expect(g.failures[0].message).toMatch(/transient/i);
    expect(g.failures[0].fix).toMatch(/again|retry/i);
    expect(g.failures[0].fix).not.toMatch(/fix the check/i);
    expect(verdict.classification).toBe('rejected');
    expect(verdict.exitCode).toBe(1);
  });

  it('names the maintainer-approval path when a check concluded action_required', async () => {
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([makeCheckRun('All checks passed', { conclusion: 'action_required' })]),
    });
    const verdict = await evaluate(input({ gh }));
    const g = gate(verdict, 'checks');
    expect(g.failures.map((f) => f.code)).toEqual(['checks_failed']);
    // #71 diagnostics: action_required means the run never started; the
    // honest fix is approval (bot-pushed head), not "repair the check".
    expect(g.failures[0].message).toMatch(/action_required/);
    expect(g.failures[0].fix).toMatch(/approv/i);
    expect(verdict.classification).toBe('rejected');
    expect(verdict.exitCode).toBe(1);
  });

  it('reads the latest-by-started_at run as the truth run (old-green/new-red, #119)', async () => {
    // Re-runs keep every same-name run in the Checks API. The truth run
    // is the latest by started_at (docs/reference.md, Checks G11): an
    // old green followed by a new red must fail, whatever the array order.
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([
        makeCheckRun('All checks passed', {
          conclusion: 'success',
          startedAt: '2026-08-20T13:00:00Z',
          id: 1,
        }),
        makeCheckRun('All checks passed', {
          conclusion: 'failure',
          startedAt: '2026-08-20T14:00:00Z',
          id: 2,
        }),
      ]),
    });
    const verdict = await evaluate(input({ gh }));
    const g = gate(verdict, 'checks');
    expect(g.failures.map((f) => f.code)).toEqual(['checks_failed']);
    expect(g.failures[0].detail).toEqual({ name: 'All checks passed', conclusion: 'failure' });
    expect(verdict.classification).toBe('rejected');
    expect(verdict.exitCode).toBe(1);
  });

  it('accepts when the latest-by-started_at run is green (old-red/new-green, #119)', async () => {
    // First-match would read the stale red run and reject a delivery
    // whose latest evidence is green: position in the response is not
    // evidence, started_at is.
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([
        makeCheckRun('All checks passed', {
          conclusion: 'failure',
          startedAt: '2026-08-20T13:00:00Z',
          id: 1,
        }),
        makeCheckRun('All checks passed', {
          conclusion: 'success',
          startedAt: '2026-08-20T14:00:00Z',
          id: 2,
        }),
      ]),
    });
    const verdict = await evaluate(input({ gh }));
    expect(gate(verdict, 'checks').status).toBe('pass');
    expect(verdict.accepted).toBe(true);
  });

  it('reports checks_pending when only the truth run is still in flight (#119)', async () => {
    // The older run is completed green, the latest-by-started_at run is
    // in_progress: the honest verdict is pending (transient, retryable),
    // never acceptance on stale evidence.
    const gh = new MockGitHubProvider({
      pr: ok(makePrFact({ headSha: HEAD })),
      checkRuns: ok([
        makeCheckRun('All checks passed', {
          conclusion: 'success',
          startedAt: '2026-08-20T13:00:00Z',
          id: 1,
        }),
        makeCheckRun('All checks passed', {
          status: 'in_progress',
          conclusion: null,
          startedAt: '2026-08-20T14:00:00Z',
          id: 2,
        }),
      ]),
    });
    const verdict = await evaluate(input({ gh }));
    const g = gate(verdict, 'checks');
    expect(g.failures.map((f) => f.code)).toEqual(['checks_pending']);
    expect(verdict.classification).toBe('rejected');
  });

  it('breaks started_at ties by the higher check-run id, order-independent (#119)', async () => {
    // Same started_at across re-runs: the higher id is the newer run.
    // Both array orders must accept — the tiebreak never trusts position.
    for (const runs of [
      [
        makeCheckRun('All checks passed', {
          conclusion: 'failure',
          startedAt: '2026-08-20T14:00:00Z',
          id: 1,
        }),
        makeCheckRun('All checks passed', {
          conclusion: 'success',
          startedAt: '2026-08-20T14:00:00Z',
          id: 11,
        }),
      ],
      [
        makeCheckRun('All checks passed', {
          conclusion: 'success',
          startedAt: '2026-08-20T14:00:00Z',
          id: 11,
        }),
        makeCheckRun('All checks passed', {
          conclusion: 'failure',
          startedAt: '2026-08-20T14:00:00Z',
          id: 1,
        }),
      ],
    ]) {
      const gh = new MockGitHubProvider({
        pr: ok(makePrFact({ headSha: HEAD })),
        checkRuns: ok(runs),
      });
      const verdict = await evaluate(input({ gh }));
      expect(gate(verdict, 'checks').status).toBe('pass');
      expect(verdict.accepted).toBe(true);
    }
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
    // The one sanctioned early call: classifying a branch mismatch as
    // merged-history requires exactly one getPr; everything else must not
    // run after the deterministic failure.
    expect(gh.calls).toEqual(['getPr:LeXwDeX/SpecGit#42']);
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

describe('sequence gate consumes the complete open-issue list (issue #120)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-seq-complete-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function searchPage(numbers: number[], overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      total_count: numbers.length,
      incomplete_results: false,
      items: numbers.map((n) => ({ number: n })),
      ...overrides,
    });
  }

  it('an earlier open issue on page 2 rejects the delivery instead of false-accepting', async () => {
    // >100 open issues: page 1 holds 151..250 (nothing precedes the bound
    // issue #150); the truth — open issue #42 — lives on page 2. A provider
    // that stops after one page hands the sequence gate an invisible list
    // and the verdict can exit 0 over a violated ordered_issues policy.
    const page1 = Array.from({ length: 100 }, (_, i) => 151 + i);
    const fake = createFakeGh(tempDir, [
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', stdout: 'Logged in to github.com\n' },
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/150$',
        stdout: JSON.stringify({ number: 150, state: 'open' }),
      },
      { match: 'search/issues.*page=2', stdout: searchPage([42]) },
      { match: 'search/issues', stdout: searchPage(page1) },
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          merged_at: null,
          head: { ref: 'feat/123-login', sha: HEAD },
          base: { ref: 'main' },
          body: 'Closes #150',
        }),
      },
      {
        match: 'check-runs',
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [
            {
              name: 'All checks passed',
              status: 'completed',
              conclusion: 'success',
              id: 1,
              started_at: '2026-08-20T00:00:00Z',
            },
          ],
        }),
      },
    ]);

    const verdict = await evaluate(
      input({
        record: ok(binding({ issues: [150] })),
        policy: ok({ version: 1, required_checks: ['All checks passed'], ordered_issues: true }),
        gh: new GhCliGitHubProvider({ env: fake.env() }),
      })
    );

    expect(verdict.classification).toBe('rejected');
    expect(verdict.exitCode).toBe(1);
    const seq = gate(verdict, 'sequence');
    expect(seq.status).toBe('fail');
    expect(seq.failures[0].code).toBe('issue_out_of_order');
    expect(JSON.stringify(seq.failures[0].detail)).toContain('42');
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

describe('merged-delivery lineage against real git (issue #64)', () => {
  let tempDir: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  const execFileAsync = promisify(execFile);

  const realSpawn: GitSpawnFn & GhSpawnFn = async (command, args, options) => {
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
    tempDir = makeTempDir('specgit-lineage-');
    ({ root, env } = initRepo(tempDir));
    // The merged-record rescue resolves the repo from the local origin
    // before asking gh about the bound PR.
    git(root, ['remote', 'add', 'origin', 'https://github.com/LeXwDeX/SpecGit.git'], env);
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  interface DeliveryHistory {
    headSha: string;
    mergeCommitSha: string;
  }

  /**
   * Builds the local aftermath of one GitHub merge strategy. The delivery
   * branch feat/123-login carries one commit; the checked-out main branch
   * ends up containing the merged delivery through a real merge commit,
   * a squashed commit, or a rebased commit — the three ways GitHub lands
   * a PR. `mergeCommitSha` is what GitHub would report as
   * merge_commit_sha: the base-branch commit the strategy produced.
   */
  function landDelivery(style: 'merge' | 'squash' | 'rebase'): DeliveryHistory {
    git(root, ['checkout', '-b', 'feat/123-login'], env);
    const headSha = commitFile(root, 'delivery.txt', 'delivered\n', env);
    git(root, ['checkout', 'main'], env);
    if (style === 'merge') {
      git(root, ['merge', '--no-ff', '-m', 'Merge pull request #42', 'feat/123-login'], env);
    } else if (style === 'squash') {
      git(root, ['merge', '--squash', 'feat/123-login'], env);
      git(root, ['commit', '-m', 'add-login-flow (#42)'], env);
    } else {
      git(root, ['checkout', 'feat/123-login'], env);
      git(root, ['rebase', 'main'], env);
      git(root, ['checkout', 'main'], env);
      git(root, ['merge', '--ff-only', 'feat/123-login'], env);
    }
    const mergeCommitSha = git(root, ['rev-parse', 'HEAD'], env).trim();
    return { headSha, mergeCommitSha };
  }

  function mergedGhRules(history: DeliveryHistory, mergeCommitSha: string | null): FakeGhRule[] {
    return [
      { match: '^--version$', stdout: 'gh version 2.60.0\n' },
      { match: '^auth status$', stdout: 'Logged in to github.com\n' },
      {
        match: '^api repos/LeXwDeX/SpecGit/issues/123$',
        stdout: JSON.stringify({ number: 123, state: 'closed' }),
      },
      {
        match: '^api repos/LeXwDeX/SpecGit/pulls/42$',
        stdout: JSON.stringify({
          number: 42,
          state: 'closed',
          merged_at: '2026-01-02T03:04:05Z',
          merge_commit_sha: mergeCommitSha,
          head: { ref: 'feat/123-login', sha: history.headSha },
          base: { ref: 'main' },
          body: 'Closes #123',
        }),
      },
      {
        match: '^api repos/LeXwDeX/SpecGit/commits/[0-9a-f]+/check-runs',
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [{ name: 'All checks passed', status: 'completed', conclusion: 'success' }],
        }),
      },
    ];
  }

  async function evaluateMerged(
    history: DeliveryHistory,
    mergeCommitSha: string | null
  ): Promise<{ verdict: Verdict; lineageCalls: string[][] }> {
    const fake = createFakeGh(tempDir, mergedGhRules(history, mergeCommitSha));
    const lineageCalls: string[][] = [];
    const recordingSpawn: GitSpawnFn & GhSpawnFn = async (command, args, options) => {
      if (command === 'git' && args.includes('merge-base')) {
        lineageCalls.push(args);
      }
      return realSpawn(command, args, options);
    };
    const verdict = await evaluate({
      root: ok(root),
      record: ok(binding()),
      policy: ok(POLICY),
      git: new LocalGitAdapter({ spawnImpl: recordingSpawn }),
      gh: new GhCliGitHubProvider({
        env: fake.env({ PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}` }),
        spawnImpl: recordingSpawn,
      }),
    });
    return { verdict, lineageCalls };
  }

  it.each(['merge', 'squash', 'rebase'] as const)(
    'contains: accepts the merged record on main after a real %s landing',
    async (style) => {
      const history = landDelivery(style);
      const { verdict, lineageCalls } = await evaluateMerged(history, history.mergeCommitSha);
      expect(verdict.classification).toBe('accepted');
      expect(verdict.exitCode).toBe(0);
      expect(gate(verdict, 'context').status).toBe('pass');
      expect(verdict.warnings.map((w) => w.code)).toContain('record_of_merged_delivery');
      // The proof ran against the strategy-invariant base-branch anchor.
      expect(lineageCalls).toEqual([
        ['-C', root, 'merge-base', '--is-ancestor', history.mergeCommitSha, 'HEAD'],
      ]);
    }
  );

  it('does-not-contain: rejects when the merge commit exists locally outside HEAD history', async () => {
    // The PR merged on a parallel local line; checked-out main predates it:
    // the merge commit is known to the object store yet not contained.
    git(root, ['checkout', '-b', 'feat/123-login'], env);
    const headSha = commitFile(root, 'delivery.txt', 'delivered\n', env);
    git(root, ['checkout', '-b', 'parallel', 'main'], env);
    git(root, ['merge', '--no-ff', '-m', 'Merge pull request #42', 'feat/123-login'], env);
    const mergeCommitSha = git(root, ['rev-parse', 'HEAD'], env).trim();
    git(root, ['checkout', 'main'], env);

    const { verdict } = await evaluateMerged({ headSha, mergeCommitSha }, mergeCommitSha);
    expect(verdict.classification).toBe('rejected');
    expect(verdict.exitCode).toBe(1);
    expect(verdict.accepted).toBe(false);
    const context = gate(verdict, 'context');
    expect(context.failures.map((f) => f.code)).toEqual(['merged_delivery_not_contained']);
  });

  it('unavailable evidence: fails closed when the merge commit was never fetched locally', async () => {
    const history = landDelivery('merge');
    const neverFetched = 'e'.repeat(40);
    const { verdict } = await evaluateMerged(history, neverFetched);
    expect(verdict.classification).toBe('unknown');
    expect(verdict.exitCode).toBe(3);
    expect(verdict.accepted).toBe(false);
    const context = gate(verdict, 'context');
    expect(context.failures.map((f) => f.code)).toEqual(['merged_lineage_unavailable']);
  });
});
