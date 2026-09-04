import { describe, expect, it } from 'vitest';

import { checksGate } from '../../src/acceptance/gates/checks-gate.js';
import { closingGate } from '../../src/acceptance/gates/closing-gate.js';
import { completenessGate } from '../../src/acceptance/gates/completeness-gate.js';
import { contextGate } from '../../src/acceptance/gates/context-gate.js';
import { contextGate as localContextGate } from '../../src/cli/gates.js';
import { issuesGate } from '../../src/acceptance/gates/issues-gate.js';
import { originGate } from '../../src/acceptance/gates/origin-gate.js';
import { policyGate } from '../../src/acceptance/gates/policy-gate.js';
import { prGate } from '../../src/acceptance/gates/pr-gate.js';
import { providerGate } from '../../src/acceptance/gates/provider-gate.js';
import { recordGate } from '../../src/acceptance/gates/record-gate.js';
import { sequenceGate } from '../../src/acceptance/gates/sequence-gate.js';
import type { GateContext, VerdictEvidence } from '../../src/acceptance/gates/types.js';
import type { GitFacts, GitPort } from '../../src/gitfacts/port.js';
import type { RepoRef } from '../../src/gitfacts/origin.js';
import type { CheckRunInfo, ForgeProvider, PrFact } from '../../src/github/port.js';
import { fail, ok, type Evidence } from '../../src/kernel/evidence.js';
import type { Policy } from '../../src/record/policy.js';
import type { DeliveryBinding } from '../../src/record/schema.js';

/**
 * Unit coverage for the gate modules (#276): every gate is exercised in
 * isolation, supplied only its own evidence through an explicit
 * `GateContext` — no gate's test runs another gate first.
 */

const BINDING: DeliveryBinding = {
  version: 1,
  delivery: 'test-delivery',
  context: { kind: 'branch', branch: 'feat/test' },
  issues: [12, 13],
  pr: 42,
};

const POLICY: Policy = { version: 1, required_checks: ['ci'] };

const REPO: RepoRef = { owner: 'acme', repo: 'web', platform: 'github' };

const FACTS: GitFacts = {
  repo: true,
  toplevel: '/repo',
  branch: 'feat/test',
  headSha: 'abc123',
  dirty: false,
  isLinkedWorktree: false,
  worktreeLabel: null,
  worktrees: [],
  originUrl: 'https://github.com/acme/web.git',
  upstreamDrift: null,
  gitAvailable: true,
};

const PR_FACT: PrFact = {
  number: 42,
  state: 'open',
  headBranch: 'feat/test',
  headSha: 'abc123',
  baseBranch: 'main',
  body: 'Closes #12\nCloses #13',
  draft: false,
  mergeCommitSha: null,
};

function freshEvidence(): VerdictEvidence {
  return {
    root: null,
    repo: null,
    delivery: null,
    branch: null,
    headSha: null,
    dirty: null,
    upstreamDrift: null,
    context: null,
    issues: null,
    pr: null,
    prHead: null,
  };
}

interface ContextOverrides {
  root?: Evidence<string>;
  record?: Evidence<DeliveryBinding>;
  policy?: Evidence<Policy>;
  git?: GitPort;
  gh?: ForgeProvider;
  gitlabHost?: string;
  binding?: DeliveryBinding | null;
  policyValue?: Policy | null;
  facts?: GitFacts | null;
  repoRef?: RepoRef | null;
  prFact?: PrFact | null;
}

function makeContext(overrides: ContextOverrides = {}): GateContext {
  const record = overrides.record ?? ok(BINDING);
  const policyEv = overrides.policy ?? ok(POLICY);
  return {
    input: {
      root: overrides.root ?? ok('/repo'),
      record,
      policy: policyEv,
      git: overrides.git ?? ({} as GitPort),
      ...(overrides.gh !== undefined ? { gh: overrides.gh } : {}),
      ...(overrides.gitlabHost !== undefined ? { gitlabHost: overrides.gitlabHost } : {}),
    },
    binding: 'binding' in overrides ? (overrides.binding ?? null) : record.ok ? record.value : null,
    policy:
      'policyValue' in overrides
        ? (overrides.policyValue ?? null)
        : policyEv.ok
          ? policyEv.value
          : null,
    evidence: freshEvidence(),
    warnings: [],
    facts: overrides.facts ?? null,
    mergedRecord: false,
    repoRef: overrides.repoRef ?? null,
    prFact: overrides.prFact ?? null,
  };
}

function gitStub(
  facts: GitFacts,
  headContains?: (root: string, sha: string) => Promise<Evidence<{ contained: boolean }>>
): GitPort {
  return {
    facts: async () => facts,
    headContains: headContains ?? (async () => ok({ contained: true })),
  } as unknown as GitPort;
}

function forgeStub(members: Partial<ForgeProvider>): ForgeProvider {
  return members as ForgeProvider;
}

function codes(failures: Array<{ code: string }>): string[] {
  return failures.map((f) => f.code);
}

describe('record gate', () => {
  it('fails with the record evidence code when the binding did not load', () => {
    const ctx = makeContext({ record: fail('record_missing', 'absent'), binding: null });
    const failures = recordGate(ctx);
    expect(codes(failures)).toEqual(['record_missing']);
    // #277: the reader's own account wins over the generic registry line.
    expect(failures[0].message).toBe('absent');
  });

  it('publishes the delivery, context, and issue evidence on a clean load', () => {
    const ctx = makeContext();
    expect(recordGate(ctx)).toEqual([]);
    expect(ctx.evidence.delivery).toBe('test-delivery');
    expect(ctx.evidence.context).toEqual({ kind: 'branch' });
    expect(ctx.evidence.issues).toEqual([12, 13]);
  });
});

describe('policy gate', () => {
  it('fails with the policy evidence code when the policy did not load', () => {
    const ctx = makeContext({ policy: fail('policy_missing', 'absent'), policyValue: null });
    expect(codes(policyGate(ctx))).toEqual(['policy_missing']);
  });

  it('passes when the policy loaded', () => {
    expect(policyGate(makeContext())).toEqual([]);
  });
});

describe('completeness gate', () => {
  it('collects both missing pieces when the binding is absent', () => {
    expect(codes(completenessGate(makeContext({ binding: null })))).toEqual([
      'issues_empty',
      'pr_missing',
    ]);
  });

  it('flags an empty issue list and a missing pr together', () => {
    const ctx = makeContext({ binding: { ...BINDING, issues: [], pr: undefined } });
    expect(codes(completenessGate(ctx))).toEqual(['issues_empty', 'pr_missing']);
  });

  it('passes a complete binding', () => {
    expect(completenessGate(makeContext())).toEqual([]);
  });
});

describe('context gate', () => {
  it('fails with the root evidence code when the root did not resolve', async () => {
    const ctx = makeContext({ root: fail('not_a_git_repo', 'no root') });
    expect(codes(await contextGate(ctx))).toEqual(['not_a_git_repo']);
  });

  it('fails git_unavailable, not_a_git_repo, and no_commits from the facts', async () => {
    expect(
      codes(await contextGate(makeContext({ git: gitStub({ ...FACTS, gitAvailable: false }) })))
    ).toEqual(['git_unavailable']);
    expect(
      codes(await contextGate(makeContext({ git: gitStub({ ...FACTS, repo: false }) })))
    ).toEqual(['not_a_git_repo']);
    expect(
      codes(await contextGate(makeContext({ git: gitStub({ ...FACTS, headSha: null }) })))
    ).toEqual(['no_commits']);
  });

  it('publishes the local evidence and passes on the bound branch', async () => {
    const ctx = makeContext({ git: gitStub(FACTS) });
    expect(await contextGate(ctx)).toEqual([]);
    expect(ctx.evidence.branch).toBe('feat/test');
    expect(ctx.evidence.headSha).toBe('abc123');
    expect(ctx.evidence.dirty).toBe(false);
    expect(ctx.facts).not.toBeNull();
  });

  it('fails detached_head when the facts have no branch', async () => {
    const ctx = makeContext({ git: gitStub({ ...FACTS, branch: null }) });
    expect(codes(await contextGate(ctx))).toEqual(['detached_head']);
  });

  it('fails branch_mismatch when no merged lineage can be asked', async () => {
    const ctx = makeContext({ git: gitStub({ ...FACTS, branch: 'main' }) });
    expect(codes(await contextGate(ctx))).toEqual(['branch_mismatch']);
  });

  it('accepts a merged record when HEAD contains the merge commit', async () => {
    const mergedPr: PrFact = { ...PR_FACT, state: 'merged', mergeCommitSha: 'deadbeef' };
    const ctx = makeContext({
      git: gitStub({ ...FACTS, branch: 'main' }),
      gh: forgeStub({ getPr: async () => ok(mergedPr) }),
      facts: null,
    });
    expect(await contextGate(ctx)).toEqual([]);
    expect(ctx.mergedRecord).toBe(true);
    expect(ctx.evidence.prHead).toBe('abc123');
  });

  it('fails merged_delivery_not_contained when HEAD lacks the anchor', async () => {
    const mergedPr: PrFact = { ...PR_FACT, state: 'merged', mergeCommitSha: 'deadbeef' };
    const ctx = makeContext({
      git: gitStub({ ...FACTS, branch: 'main' }, async () => ok({ contained: false })),
      gh: forgeStub({ getPr: async () => ok(mergedPr) }),
    });
    expect(codes(await contextGate(ctx))).toEqual(['merged_delivery_not_contained']);
  });

  it('fails closed when the merged PR reports no anchor', async () => {
    const mergedPr: PrFact = { ...PR_FACT, state: 'merged', mergeCommitSha: null };
    const ctx = makeContext({
      git: gitStub({ ...FACTS, branch: 'main' }),
      gh: forgeStub({ getPr: async () => ok(mergedPr) }),
    });
    expect(codes(await contextGate(ctx))).toEqual(['merged_lineage_unavailable']);
  });

  it('preserves the unknown provider failure when lineage cannot be determined', async () => {
    const ctx = makeContext({
      git: gitStub({ ...FACTS, branch: 'main' }),
      gh: forgeStub({ getPr: async () => fail('gh_transport', 'down') }),
    });
    expect(codes(await contextGate(ctx))).toEqual(['gh_transport']);
  });

  it.each<{
    name: string;
    context: DeliveryBinding['context'];
    facts: Partial<GitFacts>;
    expected: string[];
  }>([
    { name: 'matching branch', context: BINDING.context, facts: {}, expected: [] },
    { name: 'wrong branch', context: BINDING.context, facts: { branch: 'main' }, expected: ['branch_mismatch'] },
    ...[
      { name: 'matching worktree', facts: {}, expected: [] },
      { name: 'branch has priority over worktree', facts: { branch: 'main', worktreeLabel: 'wrong' }, expected: ['branch_mismatch'] },
      { name: 'main checkout', facts: { isLinkedWorktree: false }, expected: ['worktree_mismatch'] },
      { name: 'unknown checkout kind', facts: { isLinkedWorktree: null }, expected: ['worktree_mismatch'] },
      { name: 'wrong label', facts: { worktreeLabel: 'wrong' }, expected: ['worktree_mismatch'] },
      { name: 'missing worktree entry', facts: { worktrees: [] }, expected: ['worktree_mismatch'] },
      { name: 'label on another branch', facts: { worktrees: [{ label: 'wt-1', branch: 'other' }] }, expected: ['worktree_mismatch'] },
      { name: 'duplicate labels include correct pair', facts: { worktrees: [{ label: 'wt-1', branch: 'other' }, { label: 'wt-1', branch: 'feat/test' }] }, expected: [] },
    ].map((row) => ({
      ...row,
      context: { kind: 'worktree' as const, label: 'wt-1', branch: 'feat/test' },
      facts: { isLinkedWorktree: true, worktreeLabel: 'wt-1', worktrees: [{ label: 'wt-1', branch: 'feat/test' }], ...row.facts },
    })),
  ])('keeps local and acceptance context decisions aligned: $name', async ({ context, facts, expected }) => {
    const binding = { ...BINDING, context };
    const live = { ...FACTS, ...facts };
    expect(codes(localContextGate(binding, live).failures)).toEqual(expected);
    expect(codes(await contextGate(makeContext({ binding, git: gitStub(live) })))).toEqual(expected);
  });

  it('verifies the worktree context for worktree bindings', async () => {
    const worktreeBinding: DeliveryBinding = {
      ...BINDING,
      context: { kind: 'worktree', label: 'wt-1', branch: 'feat/test' },
    };
    const matching: GitFacts = {
      ...FACTS,
      isLinkedWorktree: true,
      worktreeLabel: 'wt-1',
      worktrees: [{ label: 'wt-1', branch: 'feat/test' }],
    };
    expect(
      await contextGate(makeContext({ binding: worktreeBinding, git: gitStub(matching) }))
    ).toEqual([]);
    const drifted = { ...matching, worktreeLabel: 'other' };
    expect(
      codes(await contextGate(makeContext({ binding: worktreeBinding, git: gitStub(drifted) })))
    ).toEqual(['worktree_mismatch']);
  });
});

describe('origin gate', () => {
  it('fails no_origin when the facts have no origin', () => {
    expect(codes(originGate(makeContext({ facts: { ...FACTS, originUrl: null } })))).toEqual([
      'no_origin',
    ]);
    expect(codes(originGate(makeContext({ facts: null })))).toEqual(['no_origin']);
  });

  it('fails origin_unresolvable on an unparseable origin', () => {
    const ctx = makeContext({ facts: { ...FACTS, originUrl: 'not a url at all' } });
    expect(codes(originGate(ctx))).toEqual(['origin_unresolvable']);
  });

  it('publishes the resolved ref and repo evidence', () => {
    const ctx = makeContext({ facts: FACTS });
    expect(originGate(ctx)).toEqual([]);
    expect(ctx.repoRef).toEqual(REPO);
    expect(ctx.evidence.repo).toBe('acme/web');
  });
});

describe('provider gate', () => {
  it('fails with the preflight code when the forge CLI is not ready', async () => {
    const ctx = makeContext({
      gh: forgeStub({ preflight: async () => fail('gh_unauthenticated', 'no auth', 'run gh auth login') }),
    });
    const failures = await providerGate(ctx);
    expect(codes(failures)).toEqual(['gh_unauthenticated']);
    // #277: the Evidence message and fix win; CODE_INFO is only the fallback.
    expect(failures[0].message).toBe('no auth');
    expect(failures[0].fix).toBe('run gh auth login');
  });

  it('warns but passes when the GitLab version is outside the verified window', async () => {
    const ctx = makeContext({
      gh: forgeStub({ preflight: async () => ok({ authenticated: true, versionUnverified: true }) }),
    });
    expect(await providerGate(ctx)).toEqual([]);
    expect(ctx.warnings.map((w) => w.code)).toEqual(['gitlab_version_unverified']);
  });

  it('passes a clean preflight without warnings', async () => {
    const ctx = makeContext({ gh: forgeStub({ preflight: async () => ok({ authenticated: true }) }) });
    expect(await providerGate(ctx)).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });
});

describe('issues gate', () => {
  const openIssue = { number: 12, state: 'open' as const, pullRequest: false };

  it('collects every missing issue', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      gh: forgeStub({ getIssue: async () => fail('issue_not_found', 'gone') }),
    });
    const failures = await issuesGate(ctx);
    expect(codes(failures)).toEqual(['issue_not_found', 'issue_not_found']);
    expect(failures.map((f) => f.detail)).toEqual([{ issue: 12 }, { issue: 13 }]);
  });

  it('short-circuits on a provider failure that is not a missing issue', async () => {
    const seen: number[] = [];
    const ctx = makeContext({
      repoRef: REPO,
      gh: forgeStub({
        getIssue: async (_repo, n) => {
          seen.push(n);
          return fail('gh_transport', 'down');
        },
      }),
    });
    expect(codes(await issuesGate(ctx))).toEqual(['gh_transport']);
    expect(seen).toEqual([12]);
  });

  it('flags a bound number that is a pull request', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      gh: forgeStub({
        getIssue: async (_repo, n) =>
          n === 13 ? ok({ ...openIssue, number: 13, pullRequest: true }) : ok(openIssue),
      }),
    });
    const failures = await issuesGate(ctx);
    expect(codes(failures)).toEqual(['issue_is_pull_request']);
  });

  it('passes when every bound issue exists', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      gh: forgeStub({ getIssue: async (_repo, n) => ok({ ...openIssue, number: n }) }),
    });
    expect(await issuesGate(ctx)).toEqual([]);
  });
});

describe('sequence gate', () => {
  it('passes without any provider call when ordered_issues is off', async () => {
    const ctx = makeContext({ repoRef: REPO, gh: forgeStub({}) });
    expect(await sequenceGate(ctx)).toEqual([]);
  });

  it('fails issue_out_of_order when an earlier issue is still open', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      policyValue: { ...POLICY, ordered_issues: true },
      gh: forgeStub({ getOpenIssueNumbers: async () => ok([3, 12, 13, 99]) }),
    });
    const failures = await sequenceGate(ctx);
    expect(codes(failures)).toEqual(['issue_out_of_order']);
    expect(failures[0].detail).toEqual({ earliestBound: 12, openEarlier: [3] });
  });

  it('passes when no open issue precedes the earliest bound issue', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      policyValue: { ...POLICY, ordered_issues: true },
      gh: forgeStub({ getOpenIssueNumbers: async () => ok([12, 13, 40]) }),
    });
    expect(await sequenceGate(ctx)).toEqual([]);
  });

  it('fails with the provider code when the open-issue scan fails', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      policyValue: { ...POLICY, ordered_issues: true },
      gh: forgeStub({ getOpenIssueNumbers: async () => fail('evidence_truncated', 'capped') }),
    });
    expect(codes(await sequenceGate(ctx))).toEqual(['evidence_truncated']);
  });
});

describe('pr gate', () => {
  it('fails pr_repo_mismatch for a bound URL from another repository', async () => {
    const ctx = makeContext({
      binding: { ...BINDING, pr: 'https://github.com/other/repo/pull/9' },
      repoRef: REPO,
      gh: forgeStub({}),
    });
    expect(codes(await prGate(ctx))).toEqual(['pr_repo_mismatch']);
  });

  it('fails pr_not_found when the provider cannot resolve the PR', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      gh: forgeStub({ getPr: async () => fail('pr_not_found', 'gone') }),
    });
    const failures = await prGate(ctx);
    expect(codes(failures)).toEqual(['pr_not_found']);
    expect(failures[0].detail).toEqual({ pr: 42 });
  });

  it('collects closed, draft, and head-mismatch findings together', async () => {
    const broken: PrFact = {
      ...PR_FACT,
      state: 'closed',
      draft: true,
      headBranch: 'other-branch',
    };
    const ctx = makeContext({ repoRef: REPO, gh: forgeStub({ getPr: async () => ok(broken) }) });
    expect(codes(await prGate(ctx))).toEqual([
      'pr_closed_unmerged',
      'pr_draft',
      'pr_head_mismatch',
    ]);
  });

  it('publishes the PR fact and evidence on a clean PR', async () => {
    const ctx = makeContext({ repoRef: REPO, gh: forgeStub({
      getPr: async () => ok(PR_FACT), listIssuePullRequests: async () => ok([]),
    }) });
    expect(await prGate(ctx)).toEqual([]);
    expect(ctx.prFact).toBe(PR_FACT);
    expect(ctx.evidence.pr).toBe(42);
    expect(ctx.evidence.prHead).toBe('abc123');
  });
});

describe('closing gate', () => {
  it('fails closing_refs_incomplete naming the missing issues', () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: { ...PR_FACT, body: 'Closes #12' },
    });
    const failures = closingGate(ctx);
    expect(codes(failures)).toEqual(['closing_refs_incomplete']);
    expect(failures[0].detail).toEqual({ missing: [13] });
  });

  it('passes when every bound issue is closed and warns nothing at parity', () => {
    const ctx = makeContext({ repoRef: REPO, prFact: PR_FACT, facts: FACTS });
    expect(closingGate(ctx)).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('warns local_head_stale when the local HEAD is not the PR head', () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      facts: { ...FACTS, headSha: 'older-local-head' },
    });
    expect(closingGate(ctx)).toEqual([]);
    expect(ctx.warnings.map((w) => w.code)).toEqual(['local_head_stale']);
  });
});

describe('checks gate', () => {
  function run(partial: Partial<CheckRunInfo>): CheckRunInfo {
    return {
      name: 'ci',
      status: 'completed',
      conclusion: 'success',
      id: 1,
      startedAt: '2026-01-01T00:00:00Z',
      ...partial,
    };
  }

  const greenForge = (runs: CheckRunInfo[]) =>
    forgeStub({ getCheckRuns: async () => ok(runs) });

  /** #315: a forge double that answers the evidence-anchor member. */
  const anchoredForge = (runs: CheckRunInfo[], anchoredAt: string | null) =>
    forgeStub({
      getCheckRuns: async () => ok(runs),
      getEvidenceAnchor: async () => ok({ anchoredAt }),
    });

  it('fails with the provider code when the check evidence fails', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      policyValue: POLICY,
      gh: forgeStub({ getCheckRuns: async () => fail('gh_transport', 'down') }),
    });
    expect(codes(await checksGate(ctx))).toEqual(['gh_transport']);
  });

  it('fails checks_missing when a required check never ran', async () => {
    const ctx = makeContext({ repoRef: REPO, prFact: PR_FACT, gh: greenForge([]) });
    const failures = await checksGate(ctx);
    expect(codes(failures)).toEqual(['checks_missing']);
    expect(failures[0].detail).toEqual({ name: 'ci' });
  });

  it('keeps the GitHub Actions wording on a GitHub origin', async () => {
    const ctx = makeContext({ repoRef: REPO, prFact: PR_FACT, gh: greenForge([]) });
    const failures = await checksGate(ctx);
    expect(failures[0].fix).toContain('GitHub Actions');
  });

  it('wording is GitLab-shaped on a declared GitLab origin (#269)', async () => {
    // The checks diagnostics must not say "GitHub Actions" on a declared
    // GitLab origin: the platform's CI is not GitHub Actions, and the
    // prose misdirects the repair.
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: greenForge([]),
      gitlabHost: 'git.ycgame.com',
    });
    const failures = await checksGate(ctx);
    expect(codes(failures)).toEqual(['checks_missing']);
    expect(failures[0].message).not.toContain('GitHub Actions');
    expect(failures[0].fix).not.toContain('GitHub Actions');
  });

  it('fails checks_pending naming the live status', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: greenForge([run({ status: 'in_progress', conclusion: null })]),
    });
    const failures = await checksGate(ctx);
    expect(codes(failures)).toEqual(['checks_pending']);
    expect(failures[0].message).toContain('[check: ci, status: in_progress]');
  });

  it('fails checks_failed naming the conclusion', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: greenForge([run({ conclusion: 'failure' })]),
    });
    const failures = await checksGate(ctx);
    expect(codes(failures)).toEqual(['checks_failed']);
    expect(failures[0].message).toContain('[check: ci, conclusion: failure]');
  });

  it('passes a failed allow_failure job but not any other conclusion', async () => {
    const allowed = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: greenForge([run({ conclusion: 'failure', allowFailure: true })]),
    });
    expect(await checksGate(allowed)).toEqual([]);
    const cancelled = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: greenForge([run({ conclusion: 'cancelled', allowFailure: true })]),
    });
    expect(codes(await checksGate(cancelled))).toEqual(['checks_failed']);
  });

  it('judges re-runs by the latest started_at, ties by the higher id', async () => {
    const latestGreen = [
      run({ id: 1, conclusion: 'failure', startedAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, conclusion: 'success', startedAt: '2026-01-01T01:00:00Z' }),
    ];
    expect(
      await checksGate(makeContext({ repoRef: REPO, prFact: PR_FACT, gh: greenForge(latestGreen) }))
    ).toEqual([]);
    const tieBrokenById = [
      run({ id: 5, conclusion: 'failure', startedAt: '2026-01-01T01:00:00Z' }),
      run({ id: 9, conclusion: 'success', startedAt: '2026-01-01T01:00:00Z' }),
    ];
    expect(
      await checksGate(
        makeContext({ repoRef: REPO, prFact: PR_FACT, gh: greenForge(tieBrokenById) })
      )
    ).toEqual([]);
  });

  it('orders equivalent instants by parsed time, not ISO string shape', async () => {
    const runs = [
      run({ id: 1, conclusion: 'success', startedAt: '2026-01-01T15:30:00Z' }),
      run({ id: 2, conclusion: 'failure', startedAt: '2026-01-01T15:00:00-01:00' }),
    ];
    expect(
      codes(await checksGate(makeContext({ repoRef: REPO, prFact: PR_FACT, gh: greenForge(runs) })))
    ).toEqual(['checks_failed']);
  });

  // #315: anchored check freshness — a required check's acceptance
  // evidence is its truth run started at or after the delivery's
  // evidence anchor (the instant it became reviewable). These tests
  // pin the provider-neutral contract; the GitHub event behind the
  // anchor is an adapter concern and never appears here.

  it('pends a truth run that wholly predates the evidence anchor (#315)', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([run({ startedAt: '2026-01-15T00:00:00Z' })], '2026-02-01T00:00:00Z'),
    });
    const failures = await checksGate(ctx);
    expect(codes(failures)).toEqual(['checks_pending']);
    expect(failures[0].message).toBe(
      "A required check's truth run predates the evidence anchor [check: ci, started: 2026-01-15T00:00:00Z, anchor: 2026-02-01T00:00:00Z]"
    );
    expect(failures[0].fix).toContain('re-run');
    expect(failures[0].detail).toEqual({
      name: 'ci',
      startedAt: '2026-01-15T00:00:00Z',
      anchoredAt: '2026-02-01T00:00:00Z',
    });
  });

  it('pends a stale truth run regardless of its conclusion (#315)', async () => {
    const succeeded = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [run({ conclusion: 'success', startedAt: '2026-01-15T00:00:00Z' })],
        '2026-02-01T00:00:00Z'
      ),
    });
    expect(codes(await checksGate(succeeded))).toEqual(['checks_pending']);
    const failed = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [run({ conclusion: 'failure', startedAt: '2026-01-15T00:00:00Z' })],
        '2026-02-01T00:00:00Z'
      ),
    });
    // Stale dominates: the failure is reported as pending-stale, never
    // as checks_failed — the stale run is not conclusion evidence.
    expect(codes(await checksGate(failed))).toEqual(['checks_pending']);
  });

  it('accepts a truth run that starts at or after the anchor — the boundary is inclusive (#315)', async () => {
    const atBoundary = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([run({ startedAt: '2026-02-01T00:00:00Z' })], '2026-02-01T00:00:00Z'),
    });
    expect(await checksGate(atBoundary)).toEqual([]);
    const afterBoundary = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([run({ startedAt: '2026-02-01T00:00:01Z' })], '2026-02-01T00:00:00Z'),
    });
    expect(await checksGate(afterBoundary)).toEqual([]);
  });

  it('judges freshness by the truth run: a stale failed rerun plus a fresh success passes (#315)', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [
          run({ id: 3, conclusion: 'failure', startedAt: '2026-01-15T00:00:00Z' }),
          run({ id: 4, conclusion: 'success', startedAt: '2026-02-02T00:00:00Z' }),
        ],
        '2026-02-01T00:00:00Z'
      ),
    });
    expect(await checksGate(ctx)).toEqual([]);
  });

  it('treats a null started_at as oldest under an enforced anchor (#315)', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([run({ startedAt: null })], '2026-02-01T00:00:00Z'),
    });
    expect(codes(await checksGate(ctx))).toEqual(['checks_pending']);
  });

  it('fails toward stale on an unparseable anchor — the boundary never silently lifts (#315)', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([run({ startedAt: '2026-02-02T00:00:00Z' })], 'not-a-timestamp'),
    });
    expect(codes(await checksGate(ctx))).toEqual(['checks_pending']);
  });

  it('a null anchor is no boundary — the verdict keeps its pre-#315 shape', async () => {
    const green = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([run({ startedAt: '2026-01-01T00:00:00Z' })], null),
    });
    expect(await checksGate(green)).toEqual([]);
    const failed = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [run({ conclusion: 'failure', startedAt: '2026-01-01T00:00:00Z' })],
        null
      ),
    });
    expect(codes(await checksGate(failed))).toEqual(['checks_failed']);
    const pending = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [run({ status: 'in_progress', conclusion: null, startedAt: '2026-01-01T00:00:00Z' })],
        null
      ),
    });
    const failures = await checksGate(pending);
    expect(codes(failures)).toEqual(['checks_pending']);
    expect(failures[0].message).toContain('[check: ci, status: in_progress]');
  });

  it('a fact that omits anchoredAt behaves as no boundary (#315)', async () => {
    // A sloppy provider fact (field absent) must not crash or enforce.
    const sloppyFact = {} as unknown as { anchoredAt: string | null };
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: forgeStub({
        getCheckRuns: async () => ok([run({ startedAt: '2026-01-01T00:00:00Z' })]),
        getEvidenceAnchor: async () => ok(sloppyFact),
      }),
    });
    expect(await checksGate(ctx)).toEqual([]);
  });

  it('a provider double without the member behaves as no boundary (#315)', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: forgeStub({ getCheckRuns: async () => ok([run({ startedAt: '2026-01-01T00:00:00Z' })]) }),
    });
    expect(await checksGate(ctx)).toEqual([]);
  });

  it('fails closed with the provider code when the anchor evidence fails (#315)', async () => {
    const ctx = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: forgeStub({
        getCheckRuns: async () => ok([run({ startedAt: '2026-02-02T00:00:00Z' })]),
        getEvidenceAnchor: async () => fail('gh_transport', 'down'),
      }),
    });
    expect(codes(await checksGate(ctx))).toEqual(['gh_transport']);
  });

  it('keeps checks_missing and allow_failure intact under an enforced anchor (#315)', async () => {
    const missing = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge([], '2026-02-01T00:00:00Z'),
    });
    expect(codes(await checksGate(missing))).toEqual(['checks_missing']);
    const allowed = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [run({ conclusion: 'failure', allowFailure: true, startedAt: '2026-02-02T00:00:00Z' })],
        '2026-02-01T00:00:00Z'
      ),
    });
    expect(await checksGate(allowed)).toEqual([]);
    const cancelled = makeContext({
      repoRef: REPO,
      prFact: PR_FACT,
      gh: anchoredForge(
        [run({ conclusion: 'cancelled', allowFailure: true, startedAt: '2026-02-02T00:00:00Z' })],
        '2026-02-01T00:00:00Z'
      ),
    });
    expect(codes(await checksGate(cancelled))).toEqual(['checks_failed']);
  });
});
