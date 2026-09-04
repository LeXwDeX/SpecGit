import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { evaluate } from '../../src/acceptance/evaluate.js';
import { matchesBoundRequest, runRemoteDelivery } from '../../src/automation/remote-delivery.js';
import { workflowRequestNumber } from '../../src/automation/remote-entry.js';
import { completionWorkflowYaml, gitlabRoutingWorkflowYaml } from '../../src/cli/completion-workflow.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeCheckRun, makePrFact } from '../specgit/helpers/mock-forge.js';
import { makeCtx, makeGhProvider, makeGitFacts, sampleBinding, samplePolicy } from './helpers.js';

const HEAD = 'a'.repeat(40);
const repo = { platform: 'github' as const, owner: 'LeXwDeX', repo: 'SpecGit' };
function fixture(platform: 'github' | 'gitlab' = 'github') {
  let pr = makePrFact({ headSha: HEAD, body: 'Closes #123' });
  let closed = false;
  const checks = [makeCheckRun('All checks passed')];
  const forge = {
    ...makeGhProvider(),
    getPr: vi.fn(async () => ok(pr)),
    getIssue: vi.fn(async (_repo: unknown, number: number) => ok({ number, pullRequest: false, state: closed ? 'closed' as const : 'open' as const })),
    getCheckRuns: vi.fn(async () => ok(checks)),
    getPrChecks: vi.fn(async () => ok({ headSha: HEAD, checks, ...(platform === 'gitlab' ? { pipelineStatus: 'success' } : {}) })),
    mergePr: vi.fn(async () => { pr = { ...pr, state: 'merged', mergeCommitSha: 'b'.repeat(40) }; return ok({ merged: true }); }),
    closeIssue: vi.fn(async () => { closed = true; return ok({ closed: true }); }),
  };
  const record = sampleBinding();
  const t = makeCtx({ record, policy: samplePolicy({ automation: { merge: true, target_branch: 'main', close_issues: true } }),
    gh: forge, evaluate, facts: makeGitFacts({ headSha: HEAD }) });
  vi.mocked(t.gitPort.headContains).mockResolvedValue(ok({ contained: true }));
  return { ...t, forge, record, setPr: (value: typeof pr) => { pr = value; } };
}

describe('trusted remote delivery continuation', () => {
  it('retains an identified merged request when workflow_run omits its PR list, then verifies closure', async () => {
    const f = fixture();
    const pr = workflowRequestNumber([], 42);
    expect(pr).toBe(42);
    expect(workflowRequestNumber([], Number.NaN)).toBeUndefined();
    expect(workflowRequestNumber([{ number: 43 }], 42)).toBe(43);
    f.setPr(makePrFact({ headSha: HEAD, state: 'merged', mergeCommitSha: 'b'.repeat(40), body: 'Closes #123' }));
    const result = await runRemoteDelivery({ repo, pr: pr!, headSha: HEAD, record: f.record }, f.ctx);
    expect(result.state).toBe('completed');
    expect(f.forge.mergePr).not.toHaveBeenCalled();
    expect(f.forge.getPr).toHaveBeenCalled();
    expect(f.forge.closeIssue).toHaveBeenCalledOnce();
  });
  it('accepts existing numeric and same-project URL bindings without accepting another repository', () => {
    expect(matchesBoundRequest(sampleBinding({ pr: '42' }), repo, 42)).toBe(true);
    expect(matchesBoundRequest(sampleBinding({ pr: 'https://github.com/LeXwDeX/SpecGit/pull/42' }), repo, 42)).toBe(true);
    expect(matchesBoundRequest(sampleBinding({ pr: 'https://github.com/elsewhere/project/pull/42' }), repo, 42)).toBe(false);
  });
  it('waits for current-head CI then merges and verifies all issue closures without another invocation', async () => {
    const f = fixture();
    f.forge.getPrChecks.mockResolvedValueOnce(ok({ headSha: HEAD, checks: [makeCheckRun('All checks passed', { status: 'in_progress', conclusion: null })] }));
    const sleep = vi.fn(async () => undefined);
    const result = await runRemoteDelivery({ repo, pr: 42, headSha: HEAD, record: f.record }, f.ctx, { sleep });
    expect(result.state).toBe('completed');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(f.forge.mergePr).toHaveBeenCalledTimes(1);
    expect(f.forge.getIssue.mock.calls.length).toBeGreaterThan(2);
  });
  it('rejects a stale event before merge, issue closure, or repair issue creation', async () => {
    const f = fixture();
    const result = await runRemoteDelivery({ repo, pr: 42, headSha: 'c'.repeat(40), record: f.record }, f.ctx);
    expect(result.errors?.[0].code).toBe('automation_head_changed');
    expect(f.forge.mergePr).not.toHaveBeenCalled();
    expect(f.forge.closeIssue).not.toHaveBeenCalled();
    expect(f.forge.calls.some((call) => call.startsWith('createIssue'))).toBe(false);
  });
  it('tracks two independent current check failures even while a sibling is pending', async () => {
    const f = fixture();
    const checks = [
      makeCheckRun('All checks passed', { status: 'in_progress', conclusion: null }),
      makeCheckRun('Lint', { source: 'app:1', conclusion: 'failure' }),
      makeCheckRun('Tests', { source: 'app:1', conclusion: 'failure' }),
    ];
    f.forge.getCheckRuns.mockResolvedValue(ok(checks));
    f.forge.getPrChecks.mockResolvedValue(ok({ headSha: HEAD, checks }));
    let nextIssue = 200;
    vi.mocked(f.forge.createIssue).mockImplementation(async () => ok({ number: nextIssue++, url: 'https://github.com/LeXwDeX/SpecGit/issues/200' }));
    const result = await runRemoteDelivery({ repo, pr: 42, headSha: HEAD, record: f.record }, f.ctx);
    expect(result.exit).toBe(1);
    expect(result.errors).toMatchObject([
      { code: 'checks_failed', target: 'github:app:1:Lint' },
      { code: 'checks_failed', target: 'github:app:1:Tests' },
    ]);
    expect(f.forge.createIssue).toHaveBeenCalledTimes(2);
    const bodies = vi.mocked(f.forge.createIssue).mock.calls.map((call) => call[2]);
    expect(bodies[0].split('\n')[0]).not.toBe(bodies[1].split('\n')[0]);
    expect(f.forge.mergePr).not.toHaveBeenCalled();
  });
  it('does not turn a draft or waiting pipeline into repair work', async () => {
    const f = fixture();
    f.setPr(makePrFact({ headSha: HEAD, draft: true }));
    const result = await runRemoteDelivery({ repo, pr: 42, headSha: HEAD, record: f.record }, f.ctx);
    expect(result.errors?.[0].code).toBe('pr_draft');
    expect(f.forge.mergePr).not.toHaveBeenCalled();
  });
  it('uses the same executor for the GitLab forge and requires pipeline success', async () => {
    const f = fixture('gitlab');
    f.ctx.parseRepoRef = () => ok({ ...repo, platform: 'gitlab' });
    const result = await runRemoteDelivery({ repo: { ...repo, platform: 'gitlab' }, pr: 42, headSha: HEAD, record: f.record }, f.ctx);
    expect(result.state).toBe('completed');
    expect(f.forge.mergePr).toHaveBeenCalledTimes(1);
  });
});

describe('completion workflow trust boundary', () => {
  it('preserves ordinary business CI and routes only an independent default-branch continuation', () => {
    const workflow = parse(gitlabRoutingWorkflowYaml({ defaultBranch: 'main', version: '2.0.0', selfHosted: false, platform: 'gitlab' }));
    const [business, completion] = workflow.include;
    expect(business.local).toBe('/.gitlab/specgit-business.yml');
    expect(business.rules[0].when).toBe('never');
    expect(business.rules[1]).toEqual({ when: 'always' });
    expect(completion.local).toBe('/.gitlab/specgit-complete.yml');
    expect(business.rules[0].if).toBe(completion.rules[0].if);
    expect(completion.rules[0].if).toContain('$CI_COMMIT_BRANCH == "main"');
    expect(completion.rules[0].if).toContain('$CI_PIPELINE_SOURCE == "pipeline"');
    expect(completion.rules[0].if).toContain('$SPECGIT_SOURCE_PROJECT == $CI_PROJECT_ID');
    expect(workflow.workflow).toBeUndefined();
    const handoff = workflow['specgit-request-completion'];
    expect(handoff.rules[0]).toEqual({ if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: 'always' });
    expect(handoff.trigger.branch).toBe('main');
    expect(handoff.trigger.strategy).toBeUndefined();
    expect(handoff.script).toBeUndefined();
    expect(handoff.trigger.forward.pipeline_variables).toBe(false);
  });
  it('keeps privileged execution on the default branch, outside PR-head checks', () => {
    const text = completionWorkflowYaml({ defaultBranch: 'main', version: '2.0.0', selfHosted: true });
    const workflow = parse(text);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.workflow_run).toEqual({ workflows: ['SpecGit Acceptance'], types: ['completed'] });
    expect(workflow.jobs.complete.if).toContain('refs/heads/main');
    expect(workflow.jobs.complete.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.complete.concurrency.group).toContain('needs.identify.outputs.pr');
    const checkouts = workflow.jobs.complete.steps.filter((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts.every((step: { with: { ref: string; 'persist-credentials': boolean } }) => step.with.ref === '${{ github.sha }}' && step.with['persist-credentials'] === false)).toBe(true);
    expect(text).toContain('PRODUCT_CHANGE !== \'true\'');
    expect(text).toContain('runtime_upgrade_required');
    expect(text).not.toContain('pull_request_target');
  });
  it('does not compile an adopting project or silently use an old runtime', () => {
    const text = completionWorkflowYaml({ defaultBranch: 'Dev', version: '2.0.0', selfHosted: false });
    expect(text).toContain('specgit@2.0.0');
    expect(text).toContain('REMOTE_DELIVERY_PROTOCOL !== 1');
    expect(text).not.toContain('pnpm');
    expect(text).not.toContain("['run', 'build']");
  });
  it('provides a separately serialized GitLab default-branch runner', () => {
    const workflow = parse(completionWorkflowYaml({ defaultBranch: 'main', version: '2.0.0', selfHosted: false, platform: 'gitlab' }));
    expect(workflow['specgit-complete'].resource_group).toBe('specgit-complete-$SPECGIT_PR');
    expect(workflow['specgit-complete'].rules[0].if).toContain('$CI_COMMIT_BRANCH == "main"');
    expect(workflow['specgit-complete'].script.join('\n')).toContain('remote-entry.js');
  });
});
