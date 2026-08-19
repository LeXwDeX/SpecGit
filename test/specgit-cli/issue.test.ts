/**
 * `specgit issue` — one-command delivery bootstrap, focused tests with
 * injected ports. The human story: create/reuse N issues → branch →
 * draft PR closing every issue → record → commit → push, resumable.
 */

import { describe, expect, it } from 'vitest';
import type { DeliveryBinding } from '../../src/record/schema.js';
import { ok } from '../../src/kernel/evidence.js';
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

function issueCtx(
  options: {
    facts?: Partial<GitFactsLike>;
    record?: DeliveryBinding;
    gh?: GhScript;
    writes?: GitWriteScript;
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
  const t = makeCtx({
    facts: makeGitFacts((options.facts ?? {}) as Partial<GitFactsLike>),
    ...(options.record !== undefined ? { record: options.record } : {}),
    gh,
    ...(options.writes !== undefined ? { gitWrites: options.writes } : {}),
  });
  return { ...t, harness, gh };
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
