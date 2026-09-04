import { describe, expect, it, vi } from 'vitest';

import { evaluate } from '../../src/acceptance/evaluate.js';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { runPr } from '../../src/cli/commands/pr.js';
import { runCliWith } from '../../src/cli/index.js';
import type { Evidence } from '../../src/kernel/evidence.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import type { MergeChecksFact, PrFact } from '../../src/github/port.js';
import type { Policy } from '../../src/record/policy.js';
import type { RepoRef } from '../../src/gitfacts/origin.js';
import { makeCheckRun, makePrFact } from '../specgit/helpers/mock-forge.js';
import {
  makeCtx, makeGhProvider, makeGitFacts, parseStdoutJson, sampleBinding, samplePolicy,
} from './helpers.js';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const automation = { merge: true, target_branch: 'main', close_issues: true };

function mergeCtx(policy: Policy = samplePolicy({ automation })) {
  const remote = {
    pr: makePrFact({ headSha: HEAD, baseBranch: 'main', body: 'Closes #123\nCloses #124' }),
    checks: [makeCheckRun('All checks passed')],
    issues: new Map([[123, 'open'], [124, 'closed']]),
  };
  const gh = {
    ...makeGhProvider(),
    getPr: vi.fn(async (): Promise<Evidence<PrFact>> => ok({ ...remote.pr })),
    getIssue: vi.fn(async (_repo: RepoRef, number: number) => ok({
      number, state: remote.issues.get(number) === 'closed' ? 'closed' as const : 'open' as const,
      pullRequest: false,
    })),
    getCheckRuns: vi.fn(async () => ok(remote.checks)),
    getPrChecks: vi.fn(async (): Promise<Evidence<MergeChecksFact>> => ok({
      headSha: remote.pr.headSha, checks: remote.checks,
    })),
    mergePr: vi.fn(async (_repo: RepoRef, _number: number, _expectedHeadSha: string): Promise<Evidence<{ merged: boolean }>> => {
      remote.pr = { ...remote.pr, state: 'merged', mergeCommitSha: MERGE };
      return ok({ merged: true });
    }),
    closeIssue: vi.fn(async (_repo: RepoRef, number: number): Promise<Evidence<{ closed: boolean }>> => {
      remote.issues.set(number, 'closed');
      return ok({ closed: true });
    }),
  };
  const t = makeCtx({
    record: sampleBinding({ issues: [123, 124] }), policy, gh,
    facts: makeGitFacts({ headSha: HEAD }), evaluate,
  });
  t.gitPort.headContains = vi.fn(async () => ok({ contained: true }));
  return { ...t, gh, remote };
}

describe('specgit pr --merge: configured delivery automation (#382)', () => {
  it('refuses side effects without the policy opt-in', async () => {
    const t = mergeCtx(samplePolicy());
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(2);
    expect(result.errors?.[0].code).toBe('automation_disabled');
    expect(t.gh.getPr).not.toHaveBeenCalled();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
    expect(t.recordPort.recordWrites).toEqual([]);
  });

  it('merges the verified head and closes only open bound issues after remote confirmation', async () => {
    const t = mergeCtx();
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(0);
    expect(result.state).toBe('completed');
    expect(result.automation).toMatchObject({ status: 'completed', pr: 42, headSha: HEAD, closedIssues: [123] });
    expect(t.gh.mergePr).toHaveBeenCalledWith(
      { owner: 'LeXwDeX', repo: 'SpecGit', platform: 'github' }, 42, HEAD
    );
    expect(t.gh.closeIssue).toHaveBeenCalledTimes(1);
    expect(t.gh.closeIssue.mock.calls[0][1]).toBe(123);
    expect(t.remote.pr.state).toBe('merged');
    expect(t.remote.issues.get(123)).toBe('closed');
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
  });

  it('routes the existing pr command and emits one JSON automation result', async () => {
    const t = mergeCtx();
    expect(await runCliWith(['node', 'specgit', 'pr', '--merge', '--json'], t.ctx)).toBe(0);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.command).toBe('pr');
    expect(envelope.automation.status).toBe('completed');
  });

  it('refuses an explicit replacement reference and a mismatched target without side effects', async () => {
    const t = mergeCtx();
    expect((await runPr({ merge: true, ref: '99' }, t.ctx)).errors?.[0].code).toBe('automation_ref_conflict');
    t.remote.pr.baseBranch = 'release';
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.errors?.[0].code).toBe('automation_target_mismatch');
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it('keeps rejection by acceptance authoritative', async () => {
    const t = mergeCtx();
    t.remote.pr.body = 'Related to #123 and #124';
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.errors?.[0].code).toBe('closing_refs_incomplete');
    expect(t.gh.getPrChecks).not.toHaveBeenCalled();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it.each(['Closes #999', 'Closes other/repository#123'])('rejects extra automatic closing references: %s', async (extra) => {
    const t = mergeCtx();
    t.remote.pr.body += `\n${extra}`;
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.errors?.[0].code).toBe('automation_unbound_closing_refs');
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'in_progress', conclusion: null, expected: 'pending' },
    { status: 'completed', conclusion: 'failure', allowFailure: true, expected: 'blocked' },
    { status: 'completed', conclusion: 'neutral', expected: 'blocked' },
    { status: 'completed', conclusion: 'cancelled', expected: 'blocked' },
  ])('blocks executed optional CI with $status/$conclusion', async ({ expected, ...check }) => {
    const t = mergeCtx();
    t.remote.checks.push(makeCheckRun('Deploy', check));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.automation?.status).toBe(expected);
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it.each([
    { order: ['pending', 'failed'], code: 'automation_checks_pending', status: 'pending', message: "CI/CD check 'Waiting' is queued." },
    { order: ['failed', 'pending'], code: 'automation_checks_failed', status: 'blocked', message: "CI/CD check 'Broken' concluded failure." },
  ])('reports the first problem in mixed CI evidence: $order', async ({ order, code, status, message }) => {
    const t = mergeCtx();
    const problems = order.map((kind) => kind === 'pending'
      ? makeCheckRun('Waiting', { status: 'queued', conclusion: null })
      : makeCheckRun('Broken', { conclusion: 'failure' }));
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: [...t.remote.checks, ...problems] }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.errors?.[0]).toMatchObject({ code, message });
    expect(result.automation?.status).toBe(status);
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('reports missing required names before an optional failed check', async () => {
    const t = mergeCtx();
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: [makeCheckRun('Broken', { conclusion: 'failure' })] }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.errors?.[0]).toMatchObject({ code: 'automation_checks_missing', message: 'Required checks are missing: All checks passed.' });
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('requires executed evidence when every optional check is skipped', async () => {
    const t = mergeCtx(samplePolicy({ automation, required_checks: [] }));
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: [makeCheckRun('Optional', { conclusion: 'skipped' })] }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.errors?.[0]).toMatchObject({ code: 'automation_checks_missing', message: 'No executed CI/CD checks prove this head successful.' });
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('permits a platform-skipped optional job, but a required skipped job cannot pass', async () => {
    const t = mergeCtx();
    t.remote.checks.push(makeCheckRun('Optional deployment', { conclusion: 'skipped' }));
    expect((await runPr({ merge: true }, t.ctx)).exit).toBe(0);
    const required = mergeCtx();
    required.remote.checks = [makeCheckRun('All checks passed', { conclusion: 'skipped' })];
    expect((await runPr({ merge: true }, required.ctx)).exit).toBe(1);
    expect(required.gh.mergePr).not.toHaveBeenCalled();
  });

  it('rejects a required skip in all-CI evidence after acceptance has passed', async () => {
    const t = mergeCtx();
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: [makeCheckRun('All checks passed', { conclusion: 'skipped' })] }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.errors?.[0]).toMatchObject({ code: 'automation_checks_failed', message: "CI/CD check 'All checks passed' concluded skipped." });
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it.each([{ checks: [] }, { checks: [makeCheckRun('Other workflow')] }])('refuses missing required all-CI evidence', async ({ checks }) => {
    const t = mergeCtx();
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.errors?.[0].code).toBe('automation_checks_missing');
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('refuses an empty all-CI response even when policy requires no named checks', async () => {
    const t = mergeCtx(samplePolicy({ automation, required_checks: [] }));
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: [] }));
    expect((await runPr({ merge: true }, t.ctx)).exit).toBe(1);
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('rejects head changes during acceptance, all-CI collection, and the final PR read', async () => {
    const evaluated = mergeCtx();
    evaluated.gh.getPr.mockResolvedValueOnce(ok({ ...evaluated.remote.pr }));
    evaluated.remote.pr.headSha = 'c'.repeat(40);
    expect((await runPr({ merge: true }, evaluated.ctx)).errors?.[0].code).toBe('automation_head_changed');
    expect(evaluated.gh.getPrChecks).not.toHaveBeenCalled();

    const ci = mergeCtx();
    ci.gh.getPrChecks.mockResolvedValue(ok({ headSha: 'c'.repeat(40), checks: ci.remote.checks }));
    expect((await runPr({ merge: true }, ci.ctx)).errors?.[0].code).toBe('automation_head_changed');

    const last = mergeCtx();
    last.gh.getPrChecks.mockImplementation(async () => {
      last.remote.pr.headSha = 'c'.repeat(40);
      return ok({ headSha: HEAD, checks: last.remote.checks });
    });
    expect((await runPr({ merge: true }, last.ctx)).errors?.[0].code).toBe('automation_head_changed');
    for (const t of [evaluated, ci, last]) {
      expect(t.gh.mergePr).not.toHaveBeenCalled();
      expect(t.gh.closeIssue).not.toHaveBeenCalled();
    }
  });

  it('rejects a binding replacement after CI and before any mutation', async () => {
    const t = mergeCtx();
    t.gh.getPrChecks.mockImplementation(async () => {
      t.recordPort.readRecord = vi.fn(async () => ok(sampleBinding({ issues: [999] })));
      return ok({ headSha: HEAD, checks: t.remote.checks });
    });
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.errors?.[0].code).toBe('automation_binding_changed');
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it('does not close issues when the platform rejects the expected head or cannot confirm merging', async () => {
    const rejected = mergeCtx();
    rejected.gh.mergePr.mockResolvedValue(fail('gh_transport', 'head changed'));
    expect((await runPr({ merge: true }, rejected.ctx)).exit).toBe(3);
    expect(rejected.gh.closeIssue).not.toHaveBeenCalled();
    const unconfirmed = mergeCtx();
    unconfirmed.gh.mergePr.mockResolvedValue(ok({ merged: true }));
    const result = await runPr({ merge: true }, unconfirmed.ctx);
    expect(result.exit).toBe(1);
    expect(result.automation?.status).toBe('pending');
    expect(result.state).not.toBe('completed');
    expect(unconfirmed.gh.closeIssue).not.toHaveBeenCalled();
  });

  it('retries a partial issue-closure failure without repeating the merge or already closed issues', async () => {
    const t = mergeCtx();
    t.remote.issues.set(124, 'open');
    let failSecond = true;
    t.gh.closeIssue.mockImplementation(async (_repo, number) => {
      if (number === 124 && failSecond) return fail('gh_transport', 'temporary failure');
      t.remote.issues.set(number, 'closed');
      return ok({ closed: true });
    });
    const first = await runPr({ merge: true }, t.ctx);
    expect(first.exit).toBe(3);
    expect(first.automation).toMatchObject({ merged: true, status: 'unknown', closedIssues: [123] });
    failSecond = false;
    const second = await runPr({ merge: true }, t.ctx);
    expect(second.exit).toBe(0);
    expect(second.automation?.closedIssues).toEqual([124]);
    expect(t.gh.mergePr).toHaveBeenCalledTimes(1);
    expect(t.gh.closeIssue.mock.calls.map((call) => call[1])).toEqual([123, 124, 124]);
    expect(t.gitPort.headContains).toHaveBeenCalledWith('/repo', MERGE);
  });

  it('requires lineage and CI evidence again before closing an already-merged delivery', async () => {
    const t = mergeCtx();
    t.remote.pr = { ...t.remote.pr, state: 'merged', mergeCommitSha: MERGE };
    t.gitPort.headContains = vi.fn(async () => fail<{ contained: boolean }>('merged_lineage_unavailable', 'missing merge object'));
    const missingLineage = await runPr({ merge: true }, t.ctx);
    expect(missingLineage.exit).toBe(3);
    expect(missingLineage.nextActions).toMatchObject([{ code: 'merge_lineage', command: 'git fetch origin' }]);
    expect(missingLineage.human?.join('\n')).toContain("check out 'main'");
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
    t.gitPort.headContains = vi.fn(async () => ok({ contained: true }));
    t.gh.getPrChecks.mockResolvedValue(fail('gh_transport', 'CI unavailable'));
    expect((await runPr({ merge: true }, t.ctx)).exit).toBe(3);
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it('leaves issue closure to the platform when close_issues is disabled', async () => {
    const t = mergeCtx(samplePolicy({ automation: { ...automation, close_issues: false } }));
    expect((await runPr({ merge: true }, t.ctx)).exit).toBe(0);
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it('does not act on a replaced binding after the platform merges', async () => {
    const t = mergeCtx();
    t.gh.mergePr.mockImplementation(async () => {
      t.remote.pr = { ...t.remote.pr, state: 'merged', mergeCommitSha: MERGE };
      t.recordPort.readRecord = vi.fn(async () => ok(sampleBinding({ issues: [999] })));
      return ok({ merged: true });
    });
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.automation).toMatchObject({ status: 'blocked', merged: true });
    expect(result.errors?.[0].code).toBe('automation_binding_changed');
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it('never reports completion without issue-closure confirmation', async () => {
    const t = mergeCtx();
    t.gh.closeIssue.mockResolvedValue(ok({ closed: false }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(3);
    expect(result.state).not.toBe('completed');
    expect(result.automation).toMatchObject({ status: 'unknown', merged: true, closedIssues: [] });
  });

  it('localizes successful automation and hands off the next delivery', async () => {
    const t = mergeCtx(samplePolicy({ automation, language: 'zh' }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(0);
    expect(result.human?.join('\n')).toContain('已将 #42 合并到 main');
    expect(result.nextActions).toMatchObject([{ code: 'next_delivery', command: 'specgit issue "<type>: <title>"' }]);
  });

  it.each([
    ['success', 0, 'completed'], ['running', 1, 'pending'], ['failed', 1, 'blocked'], [undefined, 3, 'unknown'],
  ])('requires the whole GitLab head pipeline to succeed: %s', async (pipelineStatus, exit, status) => {
    const t = mergeCtx();
    t.ctx.parseRepoRef = () => ok({ owner: 'group/sub', repo: 'project', platform: 'gitlab' });
    t.gitPort.facts = vi.fn(async () => makeGitFacts({ originUrl: 'https://git.example.com/group/sub/project.git', headSha: HEAD }));
    t.ctx.evaluate = (input) => evaluate({ ...input, gitlabHost: 'git.example.com' });
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: t.remote.checks, pipelineStatus }));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(exit);
    expect(result.automation?.status).toBe(status);
    if (exit !== 0) {
      expect(t.gh.mergePr).not.toHaveBeenCalled();
      expect(t.gh.closeIssue).not.toHaveBeenCalled();
    }
  });

  it('allows bound GitLab qualified references and URLs at the configured port', async () => {
    const t = mergeCtx();
    t.ctx.parseRepoRef = () => ok({ owner: 'group/sub', repo: 'project', platform: 'gitlab' });
    t.gitPort.facts = vi.fn(async () => makeGitFacts({ originUrl: 'https://git.example.com:8443/group/sub/project.git', headSha: HEAD }));
    t.ctx.evaluate = (input) => evaluate({ ...input, gitlabHost: 'git.example.com:8443' });
    t.remote.pr.body = 'Closes group/sub/project#123\nCloses https://git.example.com:8443/group/sub/project/-/issues/124';
    t.gh.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks: t.remote.checks, pipelineStatus: 'success' }));
    expect((await runPr({ merge: true }, t.ctx)).exit).toBe(0);
  });

  it('refuses an allow-failure trigger even when ordinary jobs and the parent pipeline succeeded', async () => {
    const t = mergeCtx();
    t.ctx.parseRepoRef = () => ok({ owner: 'group/sub', repo: 'project', platform: 'gitlab' });
    t.gitPort.facts = vi.fn(async () => makeGitFacts({ originUrl: 'https://git.example.com/group/sub/project.git', headSha: HEAD }));
    t.ctx.evaluate = (input) => evaluate({ ...input, gitlabHost: 'git.example.com' });
    const provider = new GlabProvider({ hostname: 'git.example.com', spawnImpl: async (_command, args) => {
      const route = args.join(' ');
      const body = route.includes('/merge_requests/')
        ? { iid: 42, sha: HEAD, head_pipeline: { id: 20, project_id: 99, sha: HEAD, status: 'success' } }
        : route.includes('/trigger_jobs')
          ? [{ id: 2, name: 'deploy-child', status: 'failed', allow_failure: true, started_at: null, downstream_pipeline: null }]
          : [{ id: 1, name: 'All checks passed', status: 'success', allow_failure: false, started_at: null }];
      return { stdout: JSON.stringify(body), stderr: '' };
    } });
    t.gh.getPrChecks.mockImplementation(() => provider.getPrChecks({ owner: 'group/sub', repo: 'project', platform: 'gitlab' }, 42));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(1);
    expect(result.automation?.status).toBe('blocked');
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });

  it.each([
    ['success', 'success', 0], ['success', 'failed', 1], ['running', 'success', 1], ['failed', 'success', 1],
  ])('requires downstream pipeline %s and downstream job %s to pass', async (pipelineStatus, jobStatus, exit) => {
    const t = mergeCtx();
    t.ctx.parseRepoRef = () => ok({ owner: 'group/sub', repo: 'project', platform: 'gitlab' });
    t.gitPort.facts = vi.fn(async () => makeGitFacts({ originUrl: 'https://git.example.com/group/sub/project.git', headSha: HEAD }));
    t.ctx.evaluate = (input) => evaluate({ ...input, gitlabHost: 'git.example.com' });
    const provider = new GlabProvider({ hostname: 'git.example.com', spawnImpl: async (_command, args) => {
      const route = args.join(' ');
      let body: unknown;
      if (route.includes('/merge_requests/')) body = { iid: 42, sha: HEAD, head_pipeline: { id: 20, project_id: 99, sha: HEAD, status: 'success' } };
      else if (route.endsWith('/pipelines/30')) body = { id: 30, project_id: 100, sha: 'c'.repeat(40), status: pipelineStatus };
      else if (route.includes('/trigger_jobs')) body = route.includes('/30/') ? [] : [{
        id: 2, name: 'deploy-child', status: 'success', allow_failure: false, started_at: null,
        downstream_pipeline: { id: 30, project_id: 100 },
      }];
      else body = [{ id: 1, name: 'All checks passed', status: route.includes('/30/') ? jobStatus : 'success', allow_failure: true, started_at: null }];
      return { stdout: JSON.stringify(body), stderr: '' };
    } });
    t.gh.getPrChecks.mockImplementation(() => provider.getPrChecks({ owner: 'group/sub', repo: 'project', platform: 'gitlab' }, 42));
    const result = await runPr({ merge: true }, t.ctx);
    expect(result.exit).toBe(exit);
    if (exit !== 0) {
      expect(t.gh.mergePr).not.toHaveBeenCalled();
      expect(t.gh.closeIssue).not.toHaveBeenCalled();
    }
  });
});
