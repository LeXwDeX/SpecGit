import { describe, expect, it, vi } from 'vitest';
import { ensureFailureIssues } from '../../src/automation/failure-issues.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { makeGhProvider, samplePolicy } from '../specgit-cli/helpers.js';
import { makePrFact } from './helpers/mock-forge.js';
import type { OpenIssueFact } from '../../src/github/port.js';

const repo = { owner: 'owner', repo: 'repo', platform: 'github' as const };
const pr = makePrFact({ number: 42, headSha: 'a'.repeat(40), draft: false });
function fixture() {
  const issues: OpenIssueFact[] = [];
  const gh = { ...makeGhProvider(),
    getPr: vi.fn(async () => ok(pr)),
    getOpenIssues: vi.fn(async () => ok([...issues])),
    createIssue: vi.fn(async (_repo, title: string, body: string) => {
      const number = 200 + issues.length;
      issues.push({ number, title, body });
      return ok({ number, url: 'https://github.com/owner/repo/issues/' + number });
    }),
    addIssueComment: vi.fn(async () => ok({ url: 'https://github.com/comment' })),
  };
  const input = { repo, pr, issueNumbers: [10], delivery: 'login-recovery', policy: samplePolicy(),
    failures: [{ code: 'test_failure', message: 'A regression assertion failed.', evidenceUrl: 'https://github.com/owner/repo/actions/runs/1' }] };
  return { gh, input, issues };
}
describe('failed PR repair issue lifecycle', () => {
  it('creates and reconciles a repair with only the six capabilities it consumes', async () => {
    const t = fixture();
    const forge = {
      getPr: t.gh.getPr,
      getOpenIssues: t.gh.getOpenIssues,
      ensureRepoLabels: t.gh.ensureRepoLabels,
      createIssue: t.gh.createIssue,
      addIssueLabels: t.gh.addIssueLabels,
      addIssueComment: t.gh.addIssueComment,
    };
    expect(await ensureFailureIssues(t.input, forge)).toEqual(ok({ issues: [200] }));
    expect(await ensureFailureIssues(t.input, forge)).toEqual(ok({ issues: [200] }));
    expect(t.issues).toHaveLength(1);
    expect(t.issues[0].body).toContain('Related PR: #42');
  });
  it('fills required project template delivery content and preserves repair identity on retry', async () => {
    const t = fixture();
    t.input.policy = samplePolicy({ templates: { issue: {
      title: 'fix: repair {{delivery}}',
      body: '## Delivery\n{{delivery}}\n## Evidence\n{{body}}', required_sections: ['Delivery', 'Evidence'],
    } } });
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.issues[0].title).toBe('fix: repair login-recovery');
    expect(t.issues[0].body).toContain('## Delivery\nlogin-recovery\n');
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.gh.createIssue).toHaveBeenCalledOnce();
  });
  it('creates a traceable issue and reuses it for the same unresolved cause across heads', async () => {
    const t = fixture();
    const first = await ensureFailureIssues(t.input, t.gh);
    expect(first).toEqual(ok({ issues: [200] }));
    expect(t.issues[0].body).toContain('Related PR: #42');
    expect(t.issues[0].body).toContain('#10');
    expect(t.issues[0].body).toContain(pr.headSha);
    expect(t.issues[0].body).toContain('## Acceptance');
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(first);
    expect(t.gh.createIssue).toHaveBeenCalledTimes(1);
    expect(t.gh.addIssueComment).toHaveBeenCalled();
    expect(t.gh.closeIssue).not.toHaveBeenCalled();
  });
  it('creates separate repair issues for independent failure causes', async () => {
    const t = fixture();
    t.input.failures.push({ code: 'typecheck_failure', message: 'Type mismatch.', evidenceUrl: 'https://github.com/run/2' });
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200, 201] }));
  });
  it('keeps two failing checks distinct even when they share the same diagnostic code', async () => {
    const t = fixture();
    const failures = [
      { code: 'checks_failed', target: 'actions:linux', message: 'Linux regression.' },
      { code: 'checks_failed', target: 'actions:windows', message: 'Windows regression.' },
    ];
    expect(await ensureFailureIssues({ ...t.input, failures }, t.gh)).toEqual(ok({ issues: [200, 201] }));
    expect(await ensureFailureIssues({ ...t.input, failures }, t.gh)).toEqual(ok({ issues: [200, 201] }));
    expect(t.gh.createIssue).toHaveBeenCalledTimes(2);
  });
  it('does not create repair issues for draft, pending or superseded evidence', async () => {
    const t = fixture();
    expect(await ensureFailureIssues({ ...t.input, pr: { ...pr, draft: true } }, t.gh)).toEqual(ok({ issues: [] }));
    expect(await ensureFailureIssues({ ...t.input, failures: [{ code: 'automation_checks_pending', message: 'queued' }] }, t.gh)).toEqual(ok({ issues: [] }));
    t.gh.getPr.mockResolvedValue(ok({ ...pr, headSha: 'b'.repeat(40) }));
    expect(await ensureFailureIssues(t.input, t.gh)).toMatchObject({ ok: false, code: 'failure_head_changed' });
    expect(t.gh.createIssue).not.toHaveBeenCalled();
  });
  it('fails closed on an unavailable tracker', async () => {
    const t = fixture();
    t.gh.getOpenIssues.mockResolvedValueOnce(fail('offline', 'Tracker unavailable.'));
    expect(await ensureFailureIssues(t.input, t.gh)).toMatchObject({ ok: false, code: 'offline' });
    expect(t.gh.createIssue).not.toHaveBeenCalled();
  });
  it('uses the project title language and validated label vocabulary', async () => {
    const t = fixture();
    t.input.policy = samplePolicy({ language: 'zh', validation: { titles: true, labels: 'kind' } });
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.issues[0].title).toMatch(/修复/);
    expect(t.gh.addIssueLabels).toHaveBeenCalledWith(repo, 200, ['kind::fix']);
  });
  it('uses a sole project label without forcing the built-in vocabulary', async () => {
    const t = fixture();
    t.input.policy = samplePolicy({ validation: { labels: 'project' }, tags: [{ name: 'module::auth' }] });
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.gh.addIssueLabels).toHaveBeenCalledWith(repo, 200, ['module::auth']);
  });
  it('uses explicitly selected repair labels when a project has multiple choices', async () => {
    const t = fixture();
    t.input.policy = samplePolicy({ validation: { labels: 'project' },
      tags: [{ name: 'module::auth' }, { name: 'module::billing' }],
      automation: { merge: false, repair_labels: ['module::auth'] },
    });
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.gh.addIssueLabels).toHaveBeenCalledWith(repo, 200, ['module::auth']);
  });
  it('reuses a created repair issue when labels fail, then completes its labels on retry', async () => {
    const t = fixture();
    const apply = vi.spyOn(t.gh, 'addIssueLabels');
    apply.mockResolvedValueOnce(fail('gh_transport', 'HTTP 403: Resource not accessible by integration'));
    expect(await ensureFailureIssues(t.input, t.gh)).toMatchObject({ ok: false, code: 'gh_transport' });
    expect(t.issues).toHaveLength(1);
    expect(t.gh.addIssueComment).not.toHaveBeenCalled();

    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.gh.createIssue).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(repo, 200, ['kind::fix']);
    expect(t.gh.addIssueComment).toHaveBeenCalledOnce();
  });

  it('reuses a remotely created repair issue after a lost creation response', async () => {
    const t = fixture();
    const create = t.gh.createIssue.getMockImplementation()!;
    t.gh.createIssue.mockImplementationOnce(async (...args) => {
      await create(...args);
      return fail('transport_lost', 'Creation response was lost.');
    });
    expect(await ensureFailureIssues(t.input, t.gh)).toMatchObject({ ok: false, code: 'transport_lost' });
    expect(t.issues).toHaveLength(1);
    expect(await ensureFailureIssues(t.input, t.gh)).toEqual(ok({ issues: [200] }));
    expect(t.gh.createIssue).toHaveBeenCalledTimes(1);
  });

});
