/**
 * The DeliveryBootstrap module (#278): the tail chain of `specgit
 * issue` — checkout, commit binding, push head, bind PR, commit
 * record, push — exists as an ordered list of steps, each carrying its
 * precondition and operation. Reordering is a
 * change to the list; resume from any partial state converges without
 * repeating a completed step.
 */

import { describe, expect, it, vi } from 'vitest';

import { fail, ok } from '../../src/kernel/evidence.js';
import type { DeliveryBinding } from '../../src/record/schema.js';
import type { PrSummary } from '../../src/github/port.js';
import { runIssue } from '../../src/cli/commands/issue.js';
import { errorDiagnostic } from '../../src/cli/output.js';
import {
  BOOTSTRAP_STEPS,
  runBootstrapSteps,
  type BootstrapStep,
} from '../../src/cli/commands/bootstrap.js';
import { makeCtx, makeGitFacts, makeGhProvider, sampleBinding } from './helpers.js';

const CHAIN_ORDER = [
  'checkout',
  'commit-binding',
  'push-head',
  'bind-pr',
  'commit-record',
  'push-record-commit',
] as const;

describe('the bootstrap chain is data (#278)', () => {
  it('lists exactly the documented steps, in order', () => {
    expect(BOOTSTRAP_STEPS.map((step) => step.id)).toEqual([...CHAIN_ORDER]);
  });

  it('every step has a unique identity', () => {
    const ids = BOOTSTRAP_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('push-head runs before bind-pr: both platforms refuse a PR for an unpushed head (#270)', () => {
    const ids = BOOTSTRAP_STEPS.map((step) => step.id);
    expect(ids.indexOf('push-head')).toBeLessThan(ids.indexOf('bind-pr'));
  });

  it('commit-binding runs before push-head and bind-pr: a PR whose head adds no commit over the base is refused (#323)', () => {
    // Live failure on #317 and #321: pushing the bare branch left it at
    // the base SHA, and GitHub rejected createDraftPr with "No commits
    // between main and <branch>". The binding must be IN git before the
    // branch is pushed for PR creation.
    const ids = BOOTSTRAP_STEPS.map((step) => step.id);
    expect(ids.indexOf('commit-binding')).toBeLessThan(ids.indexOf('push-head'));
    expect(ids.indexOf('commit-binding')).toBeLessThan(ids.indexOf('bind-pr'));
    // The PR number the bind step persists rides a second carrying
    // commit after the bind.
    expect(ids.indexOf('bind-pr')).toBeLessThan(ids.indexOf('commit-record'));
  });

});

describe('runBootstrapSteps runner semantics', () => {
  const repo = { owner: 'LeXwDeX', repo: 'SpecGit', platform: 'github' } as const;

  function deps() {
    const t = makeCtx({ facts: makeGitFacts({ branch: 'main' }) });
    return {
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en' as const,
      record: sampleBinding(),
      firstTitle: null,
      facts: makeGitFacts({ branch: 'main' }),
    };
  }

  function probeStep(
    id: BootstrapStep['id'],
    log: string[],
    overrides: Partial<Pick<BootstrapStep, 'precondition'>> = {}
  ): BootstrapStep {
    return {
      id,
      precondition: overrides.precondition ?? (() => true),
      run: async ({ state }) => {
        log.push(id);
        return { record: state.record };
      },
    };
  }

  it('runs every applicable step in list order', async () => {
    const log: string[] = [];
    const outcome = await runBootstrapSteps(
      [probeStep('checkout', log), probeStep('push-head', log), probeStep('bind-pr', log)],
      deps()
    );
    expect('exit' in outcome).toBe(false);
    expect(log).toEqual(['checkout', 'push-head', 'bind-pr']);
  });

  it('skips a step whose precondition is false', async () => {
    const log: string[] = [];
    await runBootstrapSteps(
      [
        probeStep('checkout', log, { precondition: () => false }),
        probeStep('push-head', log),
      ],
      deps()
    );
    expect(log).toEqual(['push-head']);
  });

  it('halts on the first failure; later steps never run', async () => {
    const log: string[] = [];
    const failing: BootstrapStep = {
      id: 'push-head',
      precondition: () => true,
      run: async () => ({
        exit: 3,
        errors: [errorDiagnostic('git_push_failed', 'git push failed')],
      }),
    };
    const outcome = await runBootstrapSteps(
      [probeStep('checkout', log), failing, probeStep('bind-pr', log)],
      deps()
    );
    expect('exit' in outcome && outcome.exit).toBe(3);
    expect(log).toEqual(['checkout']);
  });
});

describe('per-step resume converges without repeating completed steps', () => {
  const BRANCH = 'feat/11-strict-delivery-harness';

  function completeRecord(): DeliveryBinding {
    return sampleBinding({
      delivery: 'strict-delivery-harness',
      context: { kind: 'branch', branch: BRANCH },
      issues: [11, 12],
      pr: 42,
    });
  }

  const openPrFact = (number = 42) =>
    ok({
      number,
      state: 'open' as const,
      headBranch: BRANCH,
      headSha: 'a'.repeat(40),
      baseBranch: 'main',
      body: 'Closes #11\nCloses #12',
      mergeCommitSha: null,
      draft: false,
    });

  function resumeCtx(options: {
    branch: string;
    record: DeliveryBinding;
    openPrs?: PrSummary[];
    pushFail?: boolean;
  }) {
    const gh = makeGhProvider({
      getPr: () => openPrFact(),
      createDraftPr: () => ok({ number: 43, url: 'https://example.test/pr/43' }),
    });
    gh.listOpenPrsByHead = vi.fn(async (_repo: unknown, head: string) => {
      gh.calls.push(`listOpenPrsByHead:${head}`);
      return ok(options.openPrs ?? []);
    });
    const writes = options.pushFail
      ? { pushBranch: () => fail<{ pushed: boolean }>('git_push_failed', 'git push failed: network down') }
      : {};
    const t = makeCtx({
      facts: makeGitFacts({ branch: options.branch }),
      record: options.record,
      gh,
      gitWrites: writes,
    });
    return { ...t, gh };
  }

  it('complete record on the delivery branch: no checkout, no issue or PR work — only healing pushes', async () => {
    const t = resumeCtx({ branch: BRANCH, record: completeRecord() });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit, JSON.stringify(outcome)).toBe(0);
    // Checkout resume marker held: the live branch is the delivery branch.
    expect(t.gitPort.checkoutCalls).toEqual([]);
    // Issues step consumed everything: no creation or adoption probes.
    expect(t.gh.calls.filter((c) => c.startsWith('createIssue'))).toEqual([]);
    expect(t.gh.calls.filter((c) => c.startsWith('getOpenIssues'))).toEqual([]);
    // PR resume marker held: record.pr is set — no discovery, no
    // creation, no repeated traceability comments.
    expect(t.gh.calls.filter((c) => c.startsWith('listOpenPrsByHead'))).toEqual([]);
    expect(t.gh.calls.filter((c) => c.startsWith('createDraftPr'))).toEqual([]);
    expect(t.gh.calls.filter((c) => c.startsWith('addIssueComment'))).toEqual([]);
    // The marker-less healing steps re-run and converge: push ×2, and
    // each of the two record-commit positions probes the (clean) tree,
    // committing nothing.
    expect(t.gitPort.pushCalls).toEqual([BRANCH, BRANCH]);
    expect(t.gitPort.commitCalls.length).toBe(2);
  });

  it('complete record off the delivery branch: checkout runs exactly once, the PR step still skips', async () => {
    const t = resumeCtx({ branch: 'main', record: completeRecord() });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit, JSON.stringify(outcome)).toBe(0);
    expect(t.gitPort.checkoutCalls).toEqual([BRANCH]);
    expect(t.gh.calls.filter((c) => c.startsWith('listOpenPrsByHead'))).toEqual([]);
    expect(t.gh.calls.filter((c) => c.startsWith('createDraftPr'))).toEqual([]);
  });

  it('record without a PR: the bind step adopts the open PR for the head instead of creating one', async () => {
    const partial = completeRecord();
    delete (partial as Partial<DeliveryBinding>).pr;
    const t = resumeCtx({
      branch: BRANCH,
      record: partial,
      openPrs: [{ number: 42, title: 'feat: strict delivery harness', url: 'https://example.test/pr/42' }],
    });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit, JSON.stringify(outcome)).toBe(0);
    expect(t.gh.calls.filter((c) => c.startsWith('createDraftPr'))).toEqual([]);
    expect(t.gh.calls.filter((c) => c.startsWith('listOpenPrsByHead'))).toEqual([
      `listOpenPrsByHead:${BRANCH}`,
    ]);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.pr).toBe(42);
  });

  it('a fresh delivery has the binding committed BEFORE PR creation is attempted (#323)', async () => {
    // The live failure this pins: GitHub refuses createDraftPr with
    // "No commits between" when the head branch holds nothing beyond
    // the base. At the moment of PR creation at least one carrying
    // commit (the binding) must already exist.
    const partial = completeRecord();
    delete (partial as Partial<DeliveryBinding>).pr;
    const t = resumeCtx({ branch: BRANCH, record: partial });
    const inner = (t.gh.createDraftPr as typeof t.gh.createDraftPr).bind(t.gh);
    let commitsAtCreation = -1;
    t.gh.createDraftPr = vi.fn(async (...args: Parameters<typeof t.gh.createDraftPr>) => {
      commitsAtCreation = t.gitPort.commitCalls.length;
      return inner(...args);
    }) as typeof t.gh.createDraftPr;
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit, JSON.stringify(outcome)).toBe(0);
    expect(t.gh.calls.filter((c) => c.startsWith('createDraftPr'))).toHaveLength(1);
    expect(commitsAtCreation).toBeGreaterThanOrEqual(1);
  });

  it('a failed step halts the chain before later steps run (push failure never reaches PR binding)', async () => {
    const partial = completeRecord();
    delete (partial as Partial<DeliveryBinding>).pr;
    const t = resumeCtx({ branch: BRANCH, record: partial, pushFail: true });
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('git_push_failed');
    expect(t.gh.calls.filter((c) => c.startsWith('listOpenPrsByHead'))).toEqual([]);
    expect(t.gh.calls.filter((c) => c.startsWith('createDraftPr'))).toEqual([]);
  });

  it('returns the actual transport diagnostic and heals from the persisted PR after a final push failure (#415)', async () => {
    const record = completeRecord();
    delete record.pr;
    let pushes = 0;
    const t = resumeCtx({ branch: BRANCH, record });
    t.ctx.git.pushBranch = vi.fn(async () => {
      pushes += 1;
      return pushes === 2
        ? fail<{ pushed: boolean }>('git_remote_rejected', 'The remote rejected the final push.', 'Retry the push.')
        : ok({ pushed: true });
    });
    const first = await runIssue({}, t.ctx);
    expect(first.exit).toBe(3);
    expect(first.errors?.[0]).toMatchObject({
      code: 'git_remote_rejected', message: 'The remote rejected the final push.', fix: 'Retry the push.',
    });
    const persisted = t.recordPort.recordWrites.at(-1)?.record;
    expect(persisted?.pr).toBe(43);
    if (persisted === undefined) throw new Error('The PR binding must be durable before the final push.');
    const healed = resumeCtx({ branch: BRANCH, record: persisted });
    healed.gh.getPr = vi.fn(async () => openPrFact(43));
    const second = await runIssue({}, healed.ctx);
    expect(second.exit).toBe(0);
    expect(healed.gh.createDraftPr).not.toHaveBeenCalled();
    expect(healed.gh.listOpenPrsByHead).not.toHaveBeenCalled();
    expect(healed.gitPort.checkoutCalls).toEqual([]);
    expect(healed.gitPort.pushCalls).toEqual([BRANCH, BRANCH]);
  });
});
