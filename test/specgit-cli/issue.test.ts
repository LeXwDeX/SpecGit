/**
 * `specgit issue` — one-command delivery bootstrap, focused tests with
 * injected ports. The human story: create/reuse N issues → branch →
 * draft PR closing every issue → record → commit → push, resumable.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeliveryBinding } from '../../src/record/schema.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { runIssue } from '../../src/cli/commands/issue.js';
import {
  makeCtx,
  makeGitFacts,
  makeGhProvider,
  sampleBinding,
  type GhScript,
  type GitWriteScript,
} from './helpers.js';

interface IssueHarness {
  createdIssues: Array<{ title: string; body: string }>;
  createdPrs: Array<{ head: string; base: string; title: string; body: string }>;
}

/** Remotely discoverable state for the exactly-once reconciliation probes. */
interface ReconcileScript {
  openIssueNumbers?: number[];
  openIssueNumbersFail?: { code: string; message: string };
  issueFacts?: Record<number, { title?: string; state?: 'open' | 'closed' }>;
  openPrs?: Array<{ number: number; title: string; url: string }>;
  openPrsFail?: { code: string; message: string };
}

function issueCtx(
  options: {
    facts?: Partial<GitFactsLike>;
    record?: DeliveryBinding;
    gh?: GhScript;
    writes?: GitWriteScript;
    reconcile?: ReconcileScript;
  } = {}
) {
  const harness: IssueHarness = { createdIssues: [], createdPrs: [] };
  const gh = makeGhProvider({
    createIssue: (_repo, title, body) => {
      harness.createdIssues.push({ title, body });
      return {
        ok: true,
        value: {
          number: 10 + harness.createdIssues.length,
          url: `https://github.com/LeXwDeX/SpecGit/issues/${10 + harness.createdIssues.length}`,
        },
      };
    },
    createDraftPr: (_repo, head, base, title, body) => {
      harness.createdPrs.push({ head, base, title, body });
      return {
        ok: true,
        value: { number: 42, url: 'https://github.com/LeXwDeX/SpecGit/pull/42' },
      };
    },
    ...(options.gh ?? {}),
  });
  // Exactly-once seams: reconciliation probes and the PR idempotency marker.
  // Defaults describe an empty remote so the plain flows stay deterministic.
  const reconcile = options.reconcile ?? {};
  gh.getOpenIssueNumbers = vi.fn(async () => {
    gh.calls.push('getOpenIssueNumbers');
    if (reconcile.openIssueNumbersFail) {
      return fail(reconcile.openIssueNumbersFail.code, reconcile.openIssueNumbersFail.message);
    }
    return ok(reconcile.openIssueNumbers ?? []);
  });
  gh.getIssue = vi.fn(async (_repo: unknown, n: number) => {
    gh.calls.push(`getIssue:${n}`);
    const fact = reconcile.issueFacts?.[n];
    return ok({
      number: n,
      state: fact?.state ?? 'open',
      pullRequest: false,
      ...(fact?.title !== undefined ? { title: fact.title } : {}),
    });
  });
  gh.listOpenPrsByHead = vi.fn(async (_repo: unknown, head: string) => {
    gh.calls.push(`listOpenPrsByHead:${head}`);
    if (reconcile.openPrsFail) {
      return fail(reconcile.openPrsFail.code, reconcile.openPrsFail.message);
    }
    return ok(reconcile.openPrs ?? []);
  });
  const t = makeCtx({
    facts: makeGitFacts((options.facts ?? {}) as Partial<GitFactsLike>),
    ...(options.record !== undefined ? { record: options.record } : {}),
    gh,
    ...(options.writes !== undefined ? { gitWrites: options.writes } : {}),
  });
  return { ...t, harness, gh };
}

/** Makes the next `failures` writeRecord calls throw, then delegate again. */
function failRecordWrites(t: ReturnType<typeof issueCtx>, failures: number): void {
  const original = t.recordPort.writeRecord;
  let failed = 0;
  t.recordPort.writeRecord = vi.fn(async (root: string, record: DeliveryBinding) => {
    failed += 1;
    if (failed <= failures) {
      throw new Error(' simulated disk full (ENOSPC)');
    }
    return original(root, record);
  });
}

type GitFactsLike = ReturnType<typeof makeGitFacts>;

function issuesOnly(overrides: Partial<DeliveryBinding> = {}): DeliveryBinding {
  const binding = sampleBinding({
    delivery: 'strict-delivery-harness',
    context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
    issues: [11, 12],
    ...overrides,
  });
  delete (binding as Partial<DeliveryBinding>).pr;
  return binding;
}

describe('specgit issue: usage', () => {
  it('without arguments and no record is a usage error (exit 2)', async () => {
    const t = issueCtx();
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_args_required');
  });

  it('rejects a whitespace-only title', async () => {
    const t = issueCtx();
    const outcome = await runIssue({ titles: ['   '] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_title_empty');
  });
});

describe('specgit issue: fresh bootstrap', () => {
  it('creates every title issue, derives branch/delivery, opens the draft PR, records, commits, pushes', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue(
      { titles: ['feat: strict delivery harness', 'fix: harden the evaluator'] },
      t.ctx
    );

    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(2);
    expect(t.harness.createdIssues[0].title).toBe('feat: strict delivery harness');
    expect(t.harness.createdIssues[0].body).toContain('## Why');
    expect(t.harness.createdIssues[0].body).toContain('## Why (required)');
    expect(t.harness.createdIssues[0].body).toContain('## Scope (optional)');
    expect(t.harness.createdIssues[0].body).toContain('## Acceptance (required)');
    expect(t.harness.createdIssues[0].body).toContain('`specgit finish` must exit 0');
    // branch <type>/<first#>-<slug> with the type from the conventional prefix
    expect(t.harness.createdPrs.length).toBe(1);
    expect(t.harness.createdPrs[0].head).toBe('feat/11-strict-delivery-harness');
    expect(t.harness.createdPrs[0].base).toBe('main');
    expect(t.harness.createdPrs[0].title).toBe('feat: strict delivery harness');
    expect(t.harness.createdPrs[0].body).toBe('Closes #11\nCloses #12\n');

    expect(t.gitPort.checkoutCalls).toEqual(['feat/11-strict-delivery-harness']);
    expect(t.gitPort.commitCalls.length).toBe(1);
    expect(t.gitPort.commitCalls[0].path).toBe('.specgit.yaml');
    expect(t.gitPort.pushCalls).toEqual(['feat/11-strict-delivery-harness']);

    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written).toMatchObject({
      version: 1,
      delivery: 'strict-delivery-harness',
      context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
      issues: [11, 12],
      pr: 42,
    });
    expect(outcome.state).toBe('bound');
    expect(outcome.human?.join('\n')).toContain('strict-delivery-harness');
  });

  it('rejects a title without a type prefix as a usage error', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['Add login flow'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_type_invalid');
    expect(outcome.errors?.[0]?.fix).toContain('feat');
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('rejects an unknown type prefix and lists the full whitelist', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['feature: add login'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_type_invalid');
    for (const type of ['security', 'deprecate', 'dogfood', 'revert', 'ci']) {
      expect(outcome.errors?.[0]?.fix).toContain(type);
    }
    expect(t.harness.createdIssues.length).toBe(0);
  });

  it('validates every title before creating any issue', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['feat: ok first why', 'bogus second why'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_type_invalid');
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('rejects a non-English title as a usage error', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['feat: 严格交付'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_title_not_english');
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('honors other conventional types (fix:)', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    await runIssue({ titles: ['fix: crash on save'] }, t.ctx);
    expect(t.harness.createdPrs[0].head).toBe('fix/11-crash-on-save');
  });

  it('accepts the extended whitelist types in branch names', async () => {
    for (const [title, head] of [
      ['security: harden token', 'security/11-harden-token'],
      ['deprecate: remove old flags', 'deprecate/11-remove-old-flags'],
      ['dogfood: use specgit itself', 'dogfood/11-use-specgit-itself'],
    ] as const) {
      const t = issueCtx({ facts: { branch: 'main' } });
      const outcome = await runIssue({ titles: [title] }, t.ctx);
      expect(outcome.exit).toBe(0);
      expect(t.harness.createdPrs[0].head).toBe(head);
    }
  });

  it('caps the slug at three ASCII words', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    await runIssue({ titles: ['feat: one two three four five'] }, t.ctx);
    expect(t.harness.createdPrs[0].head).toBe('feat/11-one-two-three');
  });

  it('falls back to issue<N> when the first title has no ASCII words', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['feat: !!!'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdPrs[0].head).toBe('feat/11-issue11');
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.delivery).toBe('issue11');
  });

  it('reuses existing issues given as pure numbers and creates the rest', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['4', 'feat: add telemetry'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(1);
    expect(t.harness.createdIssues[0].title).toBe('feat: add telemetry');
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([4, 11]);
    expect(t.harness.createdPrs[0].head).toBe('feat/4-add-telemetry');
    expect(t.harness.createdPrs[0].body).toBe('Closes #4\nCloses #11\n');
  });

  it('checks out and creates the delivery branch when not on it', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    await runIssue({ titles: ['feat: x'] }, t.ctx);
    expect(t.gitPort.checkoutCalls).toEqual(['feat/11-x']);
  });

  it('fails closed when issue creation is unauthenticated', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      gh: {
        createIssue: () => ({
          ok: false as const,
          code: 'gh_unauthenticated',
          message: 'GitHub CLI is not authenticated.',
          fix: 'Run "gh auth login" to authenticate.',
        }),
      },
    });
    const outcome = await runIssue({ titles: ['feat: x'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_unauthenticated');
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('keeps the issues-only record when PR creation fails (resumable)', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      gh: {
        createDraftPr: () => ({
          ok: false as const,
          code: 'gh_transport',
          message: 'GitHub CLI failed: boom',
        }),
      },
    });
    const outcome = await runIssue({ titles: ['feat: x'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_transport');
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11]);
    expect(written?.pr).toBeUndefined();
  });
});

describe('specgit issue: idempotent resume', () => {
  it('resumes after a failure between steps without creating issues again', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
    });
    const outcome = await runIssue(
      { titles: ['feat: strict delivery harness', 'Harden the evaluator'] },
      t.ctx
    );
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.harness.createdPrs.length).toBe(1);
    expect(t.harness.createdPrs[0].body).toBe('Closes #11\nCloses #12\n');
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.pr).toBe(42);
    expect(outcome.human?.join('\n').toLowerCase()).toContain('resumed');
  });

  it('resumes with no arguments when a record exists', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
  });

  it('refuses argument drift on resume (different count)', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
    });
    const outcome = await runIssue({ titles: ['feat: something else'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_resume_drift');
  });

  it('replaces a merged-delivery record instead of refusing (lifecycle)', async () => {
    // The record's PR is merged: completed history. A new issue run must
    // replace the record and bootstrap a fresh delivery.
    const mergedRecord = sampleBinding({
      delivery: 'strict-delivery-harness',
      context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
      issues: [11, 12],
      pr: 42,
    });
    const t = issueCtx({
      facts: { branch: 'feat/77-brand-new-work' },
      record: mergedRecord,
      gh: {
        getPr: () =>
          ok({
            number: 42,
            state: 'merged' as const,
            headBranch: 'feat/11-strict-delivery-harness',
            headSha: 'd'.repeat(40),
            baseBranch: 'main',
            body: 'Closes #11 Closes #12',
            mergeCommitSha: null,
          }),
      },
    });
    const outcome = await runIssue({ titles: ['feat: brand new work'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.map((i) => i.title)).toEqual(['feat: brand new work']);
    expect(t.harness.createdPrs).toHaveLength(1);
  });

  it('refuses numeric arguments that are not in the record', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
    });
    const outcome = await runIssue({ titles: ['11', '99'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_resume_drift');
  });

  it('is a healing no-op when the record is complete', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-x' },
      record: sampleBinding({
        delivery: 'x',
        context: { kind: 'branch', branch: 'feat/11-x' },
        issues: [11],
        pr: 42,
      }),
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdPrs.length).toBe(0);
    expect(t.gitPort.pushCalls).toEqual(['feat/11-x']);
  });
});

describe('specgit issue: fail-closed write steps', () => {
  it('branch checkout failure exits 3 with the git code', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      record: issuesOnly({ delivery: 'x', context: { kind: 'branch', branch: 'feat/11-x' }, issues: [11] }),
      writes: {
        checkoutOrCreateBranch: () => ({
          ok: false as const,
          code: 'git_branch_failed',
          message: 'git checkout failed: refuse',
        }),
      },
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('git_branch_failed');
  });

  it('commit failure exits 3', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-x' },
      record: issuesOnly({ delivery: 'x', context: { kind: 'branch', branch: 'feat/11-x' }, issues: [11] }),
      writes: {
        commitFile: () => ({
          ok: false as const,
          code: 'git_commit_failed',
          message: 'git commit failed: hook refused',
        }),
      },
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('git_commit_failed');
  });

  it('push failure exits 3 after the record is written (resumable)', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-x' },
      record: issuesOnly({ delivery: 'x', context: { kind: 'branch', branch: 'feat/11-x' }, issues: [11] }),
      writes: {
        pushBranch: () => ({
          ok: false as const,
          code: 'git_push_failed',
          message: 'git push failed: no access',
        }),
      },
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('git_push_failed');
    expect(t.recordPort.recordWrites.at(-1)?.record?.pr).toBe(42);
  });

  it('missing origin exits 3', async () => {
    const t = issueCtx({ facts: { originUrl: null } });
    const outcome = await runIssue({ titles: ['feat: x'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('no_origin');
  });
});

function mergedRecordCtx(args: { gh?: GhScript } = {}) {
  const mergedRecord = sampleBinding({
    delivery: 'strict-delivery-harness',
    context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
    issues: [11, 12],
    pr: 42,
  });
  return issueCtx({
    facts: { branch: 'feat/11-strict-delivery-harness' },
    record: mergedRecord,
    gh: {
      getPr: () =>
        ok({
          number: 42,
          state: 'merged' as const,
          headBranch: 'feat/11-strict-delivery-harness',
          headSha: 'd'.repeat(40),
          baseBranch: 'main',
          body: 'Closes #11 Closes #12',
          mergeCommitSha: null,
        }),
      ...(args.gh ?? {}),
    },
  });
}

describe('specgit issue: replacement validation is non-destructive', () => {
  it('never deletes a merged record for invalid replacement arguments (type)', async () => {
    const t = mergedRecordCtx();
    const outcome = await runIssue({ titles: ['bogus replacement'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_type_invalid');
    expect(t.recordPort.deletes).toEqual([]);
    expect(t.harness.createdIssues.length).toBe(0);
  });

  it('never deletes a merged record for invalid replacement arguments (empty)', async () => {
    const t = mergedRecordCtx();
    const outcome = await runIssue({ titles: ['   '] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_title_empty');
    expect(t.recordPort.deletes).toEqual([]);
  });

  it('keeps the merged record when no replacement arguments are given', async () => {
    const t = mergedRecordCtx();
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.recordPort.deletes).toEqual([]);
    expect(t.harness.createdIssues.length).toBe(0);
  });

  it('deletes the merged record only after replacement arguments validate', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/77-brand-new-work' },
      record: sampleBinding({
        delivery: 'strict-delivery-harness',
        context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
        issues: [11, 12],
        pr: 42,
      }),
      gh: {
        getPr: () =>
          ok({
            number: 42,
            state: 'merged' as const,
            headBranch: 'feat/11-strict-delivery-harness',
            headSha: 'd'.repeat(40),
            baseBranch: 'main',
            body: 'Closes #11 Closes #12',
            mergeCommitSha: null,
          }),
      },
    });
    const outcome = await runIssue({ titles: ['feat: brand new work'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.recordPort.deletes).toEqual(['/repo']);
    expect(t.harness.createdIssues.map((i) => i.title)).toEqual(['feat: brand new work']);
  });
});

describe('specgit issue: exactly-once issue creation (fault injection)', () => {
  it('persists each created issue incrementally, so a mid-loop failure resumes without duplicates', async () => {
    // Fault: the second createIssue fails after the first succeeded.
    let created = 0;
    const broken = issueCtx({
      facts: { branch: 'main' },
      gh: {
        createIssue: (_repo, title, body) => {
          created += 1;
          if (created === 2) {
            return { ok: false as const, code: 'gh_transport', message: 'GitHub CLI failed: boom' };
          }
          return {
            ok: true as const,
            value: { number: 11, url: 'https://github.com/LeXwDeX/SpecGit/issues/11' },
          };
        },
      },
    });
    const args = ['feat: alpha why', 'fix: beta why'];
    const first = await runIssue({ titles: args }, broken.ctx);
    expect(first.exit).toBe(3);
    // The durable partial record exists with exactly the first issue.
    const partial = broken.recordPort.recordWrites.at(-1)?.record;
    expect(partial?.issues).toEqual([11]);
    expect(partial?.pr).toBeUndefined();

    // Retry with the transport healed: only the second WHY is created.
    const healed = issueCtx({
      facts: { branch: 'main' },
      record: partial,
      gh: {
        createIssue: (_repo, title, body) => {
          healed.harness.createdIssues.push({ title, body });
          return {
            ok: true as const,
            value: { number: 12, url: 'https://github.com/LeXwDeX/SpecGit/issues/12' },
          };
        },
      },
    });
    const second = await runIssue({ titles: args }, healed.ctx);
    expect(second.exit).toBe(0);
    expect(healed.harness.createdIssues.map((i) => i.title)).toEqual(['fix: beta why']);
    const written = healed.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11, 12]);
    expect(healed.harness.createdPrs[0].body).toBe('Closes #11\nCloses #12\n');
  });

  it('reconciles a remotely created issue by title when the record write failed (lost durability)', async () => {
    // Fault: issue #11 was created, then writeRecord failed — no record on disk.
    const broken = issueCtx({ facts: { branch: 'main' } });
    failRecordWrites(broken, 1);
    const first = await runIssue({ titles: ['feat: alpha why'] }, broken.ctx);
    expect(first.exit).toBe(3);
    expect(first.errors?.[0]?.code).toBe('record_write_failed');
    expect(broken.harness.createdIssues.length).toBe(1);

    // Retry: the remote still has #11 with the exact title — adopt, never re-create.
    const healed = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssueNumbers: [11],
        issueFacts: { 11: { title: 'feat: alpha why' } },
      },
    });
    const second = await runIssue({ titles: ['feat: alpha why'] }, healed.ctx);
    expect(second.exit).toBe(0);
    expect(healed.harness.createdIssues.length).toBe(0);
    expect(healed.gh.calls).not.toContain('createIssue:feat: alpha why');
    const written = healed.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11]);
  });

  it('consumes the durable partial record even when the remote title drifted', async () => {
    // Partial record pins #11; a teammate renamed it remotely. The resume
    // must trust the durable binding for consumed arguments, not re-derive.
    const t = issueCtx({
      facts: { branch: 'main' },
      record: issuesOnly({
        delivery: 'alpha-why',
        context: { kind: 'branch', branch: 'feat/11-alpha-why' },
        issues: [11],
      }),
      reconcile: {
        openIssueNumbers: [11],
        issueFacts: { 11: { title: 'renamed by a teammate' } },
      },
      gh: {
        createIssue: (_repo, title, body) => {
          t.harness.createdIssues.push({ title, body });
          return {
            ok: true as const,
            value: { number: 12, url: 'https://github.com/LeXwDeX/SpecGit/issues/12' },
          };
        },
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why', 'fix: beta why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.map((i) => i.title)).toEqual(['fix: beta why']);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11, 12]);
  });

  it('adopts an open issue whose title matches exactly instead of creating a duplicate', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssueNumbers: [5, 11],
        issueFacts: {
          5: { title: 'chore: unrelated work' },
          11: { title: 'feat: alpha why' },
        },
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11]);
    expect(t.harness.createdPrs[0].body).toBe('Closes #11\n');
  });

  it('does not adopt a closed issue even when the title matches', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssueNumbers: [11],
        issueFacts: { 11: { title: 'feat: alpha why', state: 'closed' } },
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(1);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11]);
  });

  it('fails closed when the reconciliation probe cannot gather evidence', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssueNumbersFail: { code: 'gh_unreachable', message: 'search API down' },
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_unreachable');
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('skips the probe for purely numeric arguments (no title to reconcile)', async () => {
    const t = issueCtx({ facts: { branch: 'main' } });
    const outcome = await runIssue({ titles: ['4'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.gh.calls).not.toContain('getOpenIssueNumbers');
    expect(t.recordPort.recordWrites.at(-1)?.record?.issues).toEqual([4]);
  });
});

describe('specgit issue: exactly-once PR creation (fault injection)', () => {
  it('adopts the single open PR for the head branch instead of creating another', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
      reconcile: {
        openPrs: [{ number: 77, title: 'Delivery', url: 'https://github.com/LeXwDeX/SpecGit/pull/77' }],
      },
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdPrs.length).toBe(0);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.pr).toBe(77);
  });

  it('refuses with pr_ambiguous when several open PRs share the head branch', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
      reconcile: {
        openPrs: [
          { number: 77, title: 'one', url: 'https://github.com/LeXwDeX/SpecGit/pull/77' },
          { number: 78, title: 'two', url: 'https://github.com/LeXwDeX/SpecGit/pull/78' },
        ],
      },
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('pr_ambiguous');
    expect(outcome.errors?.[0]?.fix).toContain('specgit pr');
    expect(t.harness.createdPrs.length).toBe(0);
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('fails closed when the PR idempotency probe cannot gather evidence', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: issuesOnly(),
      reconcile: {
        openPrsFail: { code: 'gh_transport', message: 'GitHub CLI failed: boom' },
      },
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_transport');
    expect(t.harness.createdPrs.length).toBe(0);
  });
});

describe('specgit issue: partial-resume drift guards', () => {
  it('refuses a numeric argument that contradicts the consumed position', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      record: issuesOnly({
        delivery: 'alpha-why',
        context: { kind: 'branch', branch: 'feat/11-alpha-why' },
        issues: [11],
      }),
    });
    const outcome = await runIssue({ titles: ['99', 'fix: beta why'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_resume_drift');
    expect(t.harness.createdIssues.length).toBe(0);
  });

  it('continues a partial resume with numeric reuse arguments', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      record: issuesOnly({
        delivery: 'alpha-why',
        context: { kind: 'branch', branch: 'feat/11-alpha-why' },
        issues: [11],
      }),
    });
    const outcome = await runIssue({ titles: ['11', '99'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11, 99]);
  });
});
