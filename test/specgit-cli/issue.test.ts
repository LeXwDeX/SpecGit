/**
 * `specgit issue` — one-command delivery bootstrap, focused tests with
 * injected ports. The human story: create/reuse N issues → branch →
 * draft PR closing every issue → record → commit → push, resumable.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeliveryBinding } from '../../src/record/schema.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import type { PrSummary } from '../../src/github/port.js';
import { renderPrScaffold } from '../../src/github/pr-scaffold.js';
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
  openIssues?: Array<{ number: number; title?: string; body?: string }>;
  openIssuesFail?: { code: string; message: string };
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
  type OpenIssueScript = NonNullable<ReconcileScript['openIssues']>;
  gh.getOpenIssues = vi.fn(async () => {
    gh.calls.push('getOpenIssues');
    if (reconcile.openIssuesFail) {
      return fail<OpenIssueScript>(reconcile.openIssuesFail.code, reconcile.openIssuesFail.message);
    }
    return ok(reconcile.openIssues ?? []);
  });
  gh.listOpenPrsByHead = vi.fn(async (_repo: unknown, head: string) => {
    gh.calls.push(`listOpenPrsByHead:${head}`);
    if (reconcile.openPrsFail) {
      return fail<PrSummary[]>(reconcile.openPrsFail.code, reconcile.openPrsFail.message);
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
    // #87: the draft body is the deterministic scaffold — closing refs
    // for every bound issue first, then the advisory sections.
    expect(t.harness.createdPrs[0].body).toBe(renderPrScaffold([11, 12]));
    for (const section of ['## Why', '## What changed', '## Evidence', '## Checklist']) {
      expect(t.harness.createdPrs[0].body).toContain(section);
    }
    expect(t.harness.createdPrs[0].body.startsWith('Closes #11\nCloses #12\n')).toBe(true);

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
    expect(t.harness.createdPrs[0].body).toBe(renderPrScaffold([4, 11]));
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
    expect(t.harness.createdPrs[0].body).toBe(renderPrScaffold([11, 12]));
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
            draft: false,
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

  it('is a healing no-op when the record is complete and its PR is live', async () => {
    const t = issueCtx({
      facts: { branch: 'feat/11-x' },
      record: sampleBinding({
        delivery: 'x',
        context: { kind: 'branch', branch: 'feat/11-x' },
        issues: [11],
        pr: 42,
      }),
      gh: {
        // A complete record is only healable once its PR is proven live
        // (not merged): the mergedness probe is part of the resume.
        getPr: () =>
          ok({
            number: 42,
            state: 'open' as const,
            headBranch: 'feat/11-x',
            headSha: 'a'.repeat(40),
            baseBranch: 'main',
            body: 'Closes #11\n',
            mergeCommitSha: null,
            draft: false,
          }),
      },
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
          draft: false,
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

  it('refuses a no-args resume of a merged delivery instead of resurrecting it (lifecycle)', async () => {
    // #75: the record's PR is merged — completed history. No-args resume
    // must never re-create, commit, or push the branch GitHub deleted on
    // merge; the decision is a usage diagnostic naming the way forward.
    const t = mergedRecordCtx();
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_delivery_merged');
    expect(outcome.errors?.[0]?.fix).toContain('specgit unbind --yes');
    expect(outcome.errors?.[0]?.fix).toContain('specgit issue');
    expect(t.recordPort.deletes).toEqual([]);
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.harness.createdPrs.length).toBe(0);
    expect(t.gitPort.checkoutCalls).toEqual([]);
    expect(t.gitPort.commitCalls).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
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
            draft: false,
          }),
      },
    });
    const outcome = await runIssue({ titles: ['feat: brand new work'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.recordPort.deletes).toEqual(['/repo']);
    expect(t.harness.createdIssues.map((i) => i.title)).toEqual(['feat: brand new work']);
  });
});

describe('specgit issue: mergedness probe fails closed (provider failure)', () => {
  function prProbeFailsCtx() {
    return issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record: sampleBinding({
        delivery: 'strict-delivery-harness',
        context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
        issues: [11, 12],
        pr: 42,
      }),
      gh: {
        getPr: () => fail('gh_transport', 'GitHub CLI failed: network down'),
      },
    });
  }

  it('keeps the record and refuses to resume when the probe fails (no args)', async () => {
    // Fail-closed: without the PR fact, resume would guess "not merged"
    // and could re-push a merged delivery's branch. Exit 3, record kept,
    // no git side effects (#75).
    const t = prProbeFailsCtx();
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_transport');
    expect(t.recordPort.deletes).toEqual([]);
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.gitPort.checkoutCalls).toEqual([]);
    expect(t.gitPort.commitCalls).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
  });

  it('keeps the record when the probe fails with replacement arguments present', async () => {
    // Replacement requires proof of merge; resume requires proof of life.
    // Neither is knowable — the record survives untouched, nothing is
    // created, and the provider error surfaces verbatim.
    const t = prProbeFailsCtx();
    const outcome = await runIssue({ titles: ['feat: next why'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_transport');
    expect(t.recordPort.deletes).toEqual([]);
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.gitPort.checkoutCalls).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
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
    expect(healed.harness.createdPrs[0].body).toBe(renderPrScaffold([11, 12]));
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
      reconcile: { openIssues: [{ number: 11, title: 'feat: alpha why' }] },
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
        openIssues: [{ number: 11, title: 'renamed by a teammate' }],
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
        openIssues: [
          { number: 5, title: 'chore: unrelated work' },
          { number: 11, title: 'feat: alpha why' },
        ],
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11]);
    expect(t.harness.createdPrs[0].body).toBe(renderPrScaffold([11]));
  });

  it('never adopts an issue the open-issues evidence does not carry (closed issues are invisible)', async () => {
    // The probe reads only open issues (the provider search pins
    // `is:issue+is:open`); a closed issue with the same title is not
    // evidence, so the title argument creates fresh — never binds history.
    const t = issueCtx({ facts: { branch: 'main' }, reconcile: { openIssues: [] } });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(1);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([11]);
  });

  // The deterministic issue body specgit writes on creation — the
  // boundary marker that disambiguates a same-title collision (#77).
  const scaffoldBody = (title: string): string =>
    [
      '## Why (required)',
      title,
      '',
      '## Scope (optional)',
      '',
      '## Acceptance (required)',
      'The delivery pull request closes this issue; `specgit finish` must exit 0.',
      '',
    ].join('\n');

  it('diagnoses an unresolved same-title collision instead of silently adopting (exit 2)', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssues: [
          { number: 5, title: 'feat: alpha why', body: 'someone else typed the same title' },
          { number: 9, title: 'feat: alpha why', body: 'another unrelated body' },
        ],
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_title_ambiguous');
    expect(outcome.errors?.[0]?.message).toContain('#5');
    expect(outcome.errors?.[0]?.message).toContain('#9');
    expect(outcome.errors?.[0]?.fix).toContain('specgit issue');
    // Zero side effects: ambiguity is a usage diagnostic, never a binding.
    expect(t.harness.createdIssues.length).toBe(0);
    expect(t.harness.createdPrs.length).toBe(0);
    expect(t.recordPort.recordWrites.length).toBe(0);
    expect(t.gitPort.checkoutCalls.length + t.gitPort.commitCalls.length + t.gitPort.pushCalls.length).toBe(0);
  });

  it('still diagnoses when every same-title candidate carries the scaffold body', async () => {
    // Two specgit-created duplicates of one WHY is not resumable state to
    // heal silently — the human decides which number is the delivery.
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssues: [
          { number: 5, title: 'feat: alpha why', body: scaffoldBody('feat: alpha why') },
          { number: 9, title: 'feat: alpha why', body: scaffoldBody('feat: alpha why') },
        ],
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_title_ambiguous');
    expect(t.harness.createdIssues.length).toBe(0);
  });

  it('adopts the sole same-title candidate carrying the deterministic scaffold body (#77)', async () => {
    // A human issue shares the title with a previously created-but-unrecorded
    // specgit issue. The scaffold body is the boundary that proves ownership.
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssues: [
          { number: 5, title: 'feat: alpha why', body: 'an unrelated human issue' },
          { number: 9, title: 'feat: alpha why', body: scaffoldBody('feat: alpha why') },
        ],
      },
    });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([9]);
    expect(t.harness.createdPrs[0].body).toBe(renderPrScaffold([9]));
  });

  it('adopts beyond the first search page and stays inside the call budget (>100 open issues)', async () => {
    // 150 open issues; the adoptable title rides #137 — beyond the old
    // single-page blind spot. One title-carrying scan replaces the per-issue
    // probe calls entirely (#77 trust/coverage/cost facets).
    const openIssues = Array.from({ length: 150 }, (_, i) => ({
      number: i + 1,
      title: i === 136 ? 'feat: alpha why' : `chore: filler why ${i + 1}`,
    }));
    const t = issueCtx({ facts: { branch: 'main' }, reconcile: { openIssues } });
    const outcome = await runIssue({ titles: ['feat: alpha why'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues.length).toBe(0);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.issues).toEqual([137]);
    // Call budget: exactly one title-carrying scan, zero per-issue lookups.
    expect(t.gh.calls.filter((c) => c === 'getOpenIssues')).toHaveLength(1);
    expect(t.gh.calls.filter((c) => c.startsWith('getIssue:'))).toHaveLength(0);
  });

  it('fails closed when the reconciliation probe cannot gather evidence', async () => {
    const t = issueCtx({
      facts: { branch: 'main' },
      reconcile: {
        openIssuesFail: { code: 'gh_unreachable', message: 'search API down' },
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
    expect(t.gh.calls).not.toContain('getOpenIssues');
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

describe('specgit issue: complete-record argument drift (P1 regression)', () => {
  // A live complete record — every bound issue recorded AND the PR bound —
  // is a finished bootstrap. Extra arguments are drift: usage exit 2 with
  // zero side effects (no probes, no creates, byte-identical record).
  function completeRecordCtx() {
    const record = sampleBinding({
      delivery: 'strict-delivery-harness',
      context: { kind: 'branch', branch: 'feat/11-strict-delivery-harness' },
      issues: [11, 12],
      pr: 42,
    });
    const t = issueCtx({
      facts: { branch: 'feat/11-strict-delivery-harness' },
      record,
      gh: {
        getPr: () =>
          ok({
            number: 42,
            state: 'open' as const,
            headBranch: 'feat/11-strict-delivery-harness',
            headSha: 'a'.repeat(40),
            baseBranch: 'main',
            body: 'Closes #11\nCloses #12\n',
            mergeCommitSha: null,
            draft: false,
          }),
      },
    });
    return { t, record };
  }

  /** Creation-path probe and create calls — must stay empty on drift. */
  function creationPathCalls(calls: string[]): string[] {
    return calls.filter(
      (c) =>
        c === 'getOpenIssues' ||
        c.startsWith('getIssue:') ||
        c.startsWith('createIssue') ||
        c.startsWith('listOpenPrsByHead') ||
        c.startsWith('createDraftPr')
    );
  }

  async function expectZeroSideEffects(
    t: ReturnType<typeof issueCtx>,
    record: DeliveryBinding
  ): Promise<void> {
    expect(creationPathCalls(t.gh.calls)).toEqual([]);
    expect(t.harness.createdIssues).toEqual([]);
    expect(t.harness.createdPrs).toEqual([]);
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.recordPort.deletes).toEqual([]);
    expect(t.gitPort.checkoutCalls).toEqual([]);
    expect(t.gitPort.commitCalls).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
    // Byte-identical .specgit.yaml: nothing was rewritten, and reading the
    // record back yields the identical binding.
    const reread = await t.recordPort.readRecord('/repo');
    expect(reread.ok && JSON.stringify(reread.value)).toBe(JSON.stringify(record));
  }

  it('refuses a numeric-extra argument on a live complete record with zero side effects', async () => {
    const { t, record } = completeRecordCtx();
    const outcome = await runIssue({ titles: ['11', '12', '99'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_resume_drift');
    await expectZeroSideEffects(t, record);
  });

  it('refuses a title-extra argument on a live complete record with zero side effects', async () => {
    const { t, record } = completeRecordCtx();
    const outcome = await runIssue(
      { titles: ['feat: alpha why', 'fix: beta why', 'chore: gamma why'] },
      t.ctx
    );
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_resume_drift');
    await expectZeroSideEffects(t, record);
  });

  it('keeps the exact-count numeric resume of a complete record a healing no-op', async () => {
    const { t } = completeRecordCtx();
    const outcome = await runIssue({ titles: ['11', '12'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(creationPathCalls(t.gh.calls)).toEqual([]);
    expect(t.harness.createdIssues).toEqual([]);
    expect(t.harness.createdPrs).toEqual([]);
  });

  it('still continues a partial record (no PR bound) with extra arguments', async () => {
    // Legitimate partial records keep healing: the gate is record.pr ===
    // undefined, so a crash between issue creation and PR opening resumes.
    const t = issueCtx({
      facts: { branch: 'feat/11-alpha-why' },
      record: issuesOnly({
        delivery: 'alpha-why',
        context: { kind: 'branch', branch: 'feat/11-alpha-why' },
        issues: [11],
      }),
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
    expect(written?.pr).toBe(42);
  });
});
