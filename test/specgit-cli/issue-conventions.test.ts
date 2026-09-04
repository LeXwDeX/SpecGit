import { describe, expect, it } from 'vitest';
import { runIssue } from '../../src/cli/commands/issue.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { makeCtx, makeGhProvider, sampleBinding, samplePolicy, type GhScript } from './helpers.js';
import type { Policy } from '../../src/record/policy.js';

function conventionCtx(policy: Policy | 'invalid', script: GhScript = {}) {
  const gh = makeGhProvider({
    createIssue: () => ok({ number: 11, url: 'https://github.com/LeXwDeX/SpecGit/issues/11' }),
    createDraftPr: () => ok({ number: 42, url: 'https://github.com/LeXwDeX/SpecGit/pull/42' }),
    listOpenPrsByHead: () => ok([]),
    ...script,
  });
  return { ...makeCtx({ policy, gh }), gh };
}

describe('issue project conventions (#407)', () => {
  it('refuses an invalid policy before creating or writing a delivery', async () => {
    const t = conventionCtx('invalid');
    const outcome = await runIssue({ titles: ['feat: valid input'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('policy_invalid');
    expect(t.gh.createIssue).not.toHaveBeenCalled();
    expect(t.recordPort.recordWrites).toEqual([]);
  });

  it('checks the configured title language before creating issues', async () => {
    const t = conventionCtx(samplePolicy({ language: 'zh', validation: { titles: true } }));
    const outcome = await runIssue({ titles: ['feat: english title'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(t.gh.createIssue).not.toHaveBeenCalled();
    expect(t.recordPort.recordWrites).toEqual([]);
  });

  it('checks every numeric reuse before any earlier new issue is created', async () => {
    const t = conventionCtx(samplePolicy({ language: 'en', validation: { titles: true } }), {
      getIssue: (_repo, number) => ok({ number, title: 'fix: 中文标题', state: 'open', pullRequest: false }),
    });
    const outcome = await runIssue({ titles: ['feat: new issue', '12'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(t.gh.createIssue).not.toHaveBeenCalled();
  });

  it('rejects a pool label outside configured vocabulary before creating issues', async () => {
    const t = conventionCtx(samplePolicy({ validation: { labels: 'kind' } }), {
      listRepoLabels: () => ok({ names: ['kind::feat', 'unapproved'] }),
    });
    const outcome = await runIssue({ titles: ['feat: new issue'], tags: 'kind::feat,unapproved' }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(t.gh.createIssue).not.toHaveBeenCalled();
  });

  it('checks adopted issue labels together with requested labels before mutation', async () => {
    const t = conventionCtx(samplePolicy({ validation: { labels: 'kind' } }), {
      getOpenIssues: () => ok([{ number: 12, title: 'fix: adopted issue' }]),
      getIssue: (_repo, number) => ok({ number, title: 'fix: adopted issue', state: 'open', pullRequest: false, labels: ['kind::docs'] }),
    });
    const outcome = await runIssue({ titles: ['fix: adopted issue'], tags: 'kind::fix' }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(t.gh.addIssueLabels).not.toHaveBeenCalled();
    expect(t.recordPort.recordWrites).toEqual([]);
  });

  it('requires explicit project labels when inferred kinds are outside project vocabulary', async () => {
    const policy = samplePolicy({ validation: { labels: 'project' }, tags: [{ name: 'priority::high' }] });
    const refused = conventionCtx(policy);
    expect((await runIssue({ titles: ['feat: new issue'] }, refused.ctx)).exit).toBe(2);
    expect(refused.gh.createIssue).not.toHaveBeenCalled();
    const accepted = conventionCtx(policy);
    expect((await runIssue({ titles: ['feat: new issue'], tags: 'priority::high' }, accepted.ctx)).exit).toBe(0);
    expect(accepted.gh.addIssueLabels).toHaveBeenCalledWith(expect.anything(), 11, ['priority::high']);
  });

  it('fails closed when adopted issue label evidence is missing', async () => {
    const t = conventionCtx(samplePolicy({ validation: { labels: 'kind' } }), {
      getIssue: (_repo, number) => ok({ number, title: 'feat: reused', state: 'open', pullRequest: false }),
    });
    const outcome = await runIssue({ titles: ['12'], delivery: 'reuse', tags: 'kind::feat' }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(t.recordPort.recordWrites).toEqual([]);
  });

  it('keeps inferred tagging failures fail closed when label validation is enabled', async () => {
    const t = conventionCtx(samplePolicy({ validation: { labels: 'kind' } }), {
      ensureRepoLabels: () => fail('gh_transport', 'labels unavailable'),
    });
    const outcome = await runIssue({ titles: ['feat: new issue'] }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_transport');
    expect(t.gh.createDraftPr).not.toHaveBeenCalled();
    expect(t.gitPort.pushCalls).toEqual([]);
  });

  it('checks the resulting labels when resuming a recorded delivery', async () => {
    const t = conventionCtx(samplePolicy({ validation: { labels: 'kind' } }), {
      getIssue: (_repo, number) => ok({ number, title: 'feat: original', state: 'open', pullRequest: false, labels: ['kind::fix'] }),
    });
    t.recordPort.readRecord = async () => ok(sampleBinding({ pr: undefined, issueKinds: [{ issue: 123, kind: 'kind::feat' }] }));
    const outcome = await runIssue({ titles: [] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(t.gh.addIssueLabels).not.toHaveBeenCalled();
    expect(t.gitPort.commitCalls).toEqual([]);
  });
});
