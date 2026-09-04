import { describe, expect, it } from 'vitest';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { verifyGitlabCompletion, type GitlabCompletionIdentity } from '../../src/providers/gitlab/completion-context.js';
import { fail, ok } from '../../src/kernel/evidence.js';

const repo = { platform: 'gitlab' as const, owner: 'group', repo: 'project' };
const head = 'a'.repeat(40);
const approved = 'b'.repeat(40);
const identity: GitlabCompletionIdentity = { projectId: 9, pipelineId: 30, sourcePipelineId: 20, jobId: 301, pr: 42, headSha: head, checkoutSha: approved };
const job = (id: number, name: string, status: string) => ({ id, name, status, allow_failure: false, started_at: '2026-09-04T00:00:00Z' });

function fixture() {
  const data: Record<string, unknown> = {
    'projects/group%2Fproject': { id: 9, path_with_namespace: 'group/project', default_branch: 'main' },
    'projects/group%2Fproject/merge_requests/42': { iid: 42, sha: head, head_pipeline: { id: 20, project_id: 9, sha: head, status: 'success' } },
    'projects/9/merge_requests/42': { iid: 42, sha: head, source_project_id: 9, target_project_id: 9, head_pipeline: { id: 20, project_id: 9, sha: head, status: 'success' } },
    'projects/9/pipelines/30': { id: 30, project_id: 9, source: 'pipeline', ref: 'main', sha: approved, tag: false, status: 'running' },
    'projects/9/pipelines/30/jobs': [{ ...job(301, 'specgit-complete', 'running'), pipeline: { id: 30, project_id: 9, sha: approved } }],
    'projects/9/pipelines/30/trigger_jobs': [],
    'projects/9/pipelines/20': { id: 20, project_id: 9, source: 'merge_request_event', sha: head, status: 'success' },
    'projects/9/pipelines/20/jobs': [job(201, 'Build', 'success')],
    'projects/9/pipelines/20/trigger_jobs': [{ ...job(202, 'specgit-request-completion', 'success'), downstream_pipeline: { id: 30, project_id: 9, sha: approved, ref: 'main' } }],
  };
  const calls: string[] = [];
  const reads = {
    api: async (path: string) => { calls.push(path); return path in data ? ok(data[path]) : fail<unknown>('glab_transport', `Missing ${path}`); },
    list: async (path: string) => { calls.push(path); return Array.isArray(data[path]) ? ok(data[path] as unknown[]) : fail<unknown[]>('glab_transport', `Missing ${path}`); },
  };
  const provider = (completion: GitlabCompletionIdentity | undefined = identity) => new GlabProvider({ completion, spawnImpl: async (_command, args) => {
    const path = args.find((arg) => arg.startsWith('projects/'))?.split('?')[0] ?? '';
    calls.push(path);
    if (!(path in data)) throw new Error(`Missing test evidence ${path}`);
    return { stdout: JSON.stringify(data[path]), stderr: '' };
  } });
  return { data, calls, reads, provider };
}

describe('GitLab independently proven completion pipeline', () => {
  it('removes only its own pipeline wait while retaining the source bridge and business jobs', async () => {
    const f = fixture();
    expect(await verifyGitlabCompletion(repo, identity, f.reads)).toEqual(ok({ projectId: 9, pipelineId: 30 }));
    const result = await f.provider().getPrChecks(repo, 42);
    expect(result).toMatchObject({ ok: true, value: { headSha: head, pipelineStatus: 'success' } });
    if (!result.ok) return;
    expect(result.value.checks.map((check) => check.name)).toEqual(['Build', 'specgit-request-completion']);
  });

  it('ordinary CLI reads keep the completion downstream, even with completion-looking environment values', async () => {
    // No trusted context: the provider never reads these hints from env.
    const f = fixture();
    const provider = new GlabProvider({ env: { CI_PIPELINE_ID: '30', SPECGIT_PR: '42' }, spawnImpl: async (_command, args) => {
      const path = args.find((arg) => arg.startsWith('projects/'))?.split('?')[0] ?? '';
      return { stdout: JSON.stringify(f.data[path]), stderr: '' };
    } });
    const ordinary = await provider.getPrChecks(repo, 42);
    expect(ordinary).toMatchObject({ ok: true, value: { checks: expect.arrayContaining([
      expect.objectContaining({ name: 'downstream:9/30:pipeline', status: 'running' }),
    ]) } });
  });

  it('continues to require unrelated downstream failures and the original pipeline status', async () => {
    const f = fixture();
    (f.data['projects/9/pipelines/20/trigger_jobs'] as unknown[]).push({ ...job(203, 'other-deployment', 'success'), downstream_pipeline: { id: 40, project_id: 9 } });
    f.data['projects/9/pipelines/40'] = { id: 40, project_id: 9, sha: head, status: 'failed' };
    f.data['projects/9/pipelines/40/jobs'] = [job(401, 'Deploy', 'failed')];
    f.data['projects/9/pipelines/40/trigger_jobs'] = [];
    const mr = f.data['projects/group%2Fproject/merge_requests/42'] as { head_pipeline: { status: string } };
    mr.head_pipeline.status = 'failed';
    const result = await f.provider().getPrChecks(repo, 42);
    expect(result).toMatchObject({ ok: true, value: { pipelineStatus: 'failed', checks: expect.arrayContaining([
      expect.objectContaining({ name: 'downstream:9/40:Deploy', conclusion: 'failure' }),
    ]) } });
  });

  it.each([
    ['project identity', 'projects/group%2Fproject', { id: 10 }],
    ['default branch', 'projects/group%2Fproject', { default_branch: 'other' }],
    ['pipeline source', 'projects/9/pipelines/30', { source: 'web' }],
    ['pipeline project', 'projects/9/pipelines/30', { project_id: 10 }],
    ['pipeline revision', 'projects/9/pipelines/30', { sha: head }],
    ['pipeline tag', 'projects/9/pipelines/30', { tag: true }],
    ['forked MR', 'projects/9/merge_requests/42', { source_project_id: 10 }],
    ['stale MR head', 'projects/9/merge_requests/42', { sha: 'c'.repeat(40) }],
    ['superseded MR pipeline', 'projects/9/merge_requests/42', { head_pipeline: { id: 21, project_id: 9, sha: head } }],
    ['non-MR source', 'projects/9/pipelines/20', { source: 'push' }],
  ])('rejects forged %s before granting any wait exception', async (_name, path, patch) => {
    const f = fixture();
    f.data[path as string] = { ...(f.data[path as string] as object), ...patch as object };
    expect(await f.provider().getPrChecks(repo, 42)).toMatchObject({ ok: false, code: 'gitlab_completion_unverified' });
  });

  it.each(['extra business job', 'wrong executing job', 'extra downstream', 'missing relation', 'wrong relation revision'])('rejects %s', async (fault) => {
    const f = fixture();
    if (fault === 'extra business job') (f.data['projects/9/pipelines/30/jobs'] as unknown[]).push(job(302, 'Business', 'running'));
    if (fault === 'wrong executing job') ((f.data['projects/9/pipelines/30/jobs'] as Record<string, unknown>[])[0]).id = 302;
    if (fault === 'extra downstream') (f.data['projects/9/pipelines/30/trigger_jobs'] as unknown[]).push(job(303, 'Additional work', 'running'));
    if (fault === 'missing relation') f.data['projects/9/pipelines/20/trigger_jobs'] = [];
    if (fault === 'wrong relation revision') ((f.data['projects/9/pipelines/20/trigger_jobs'] as { downstream_pipeline: { sha: string } }[])[0]).downstream_pipeline.sha = head;
    expect(await f.provider().getPrChecks(repo, 42)).toMatchObject({ ok: false, code: 'gitlab_completion_unverified' });
  });

  it('refreshes proof for each merge checks read and refuses a changed relation', async () => {
    const f = fixture();
    const provider = f.provider();
    expect((await provider.getPrChecks(repo, 42)).ok).toBe(true);
    f.data['projects/9/pipelines/20/trigger_jobs'] = [];
    expect(await provider.getPrChecks(repo, 42)).toMatchObject({ ok: false, code: 'gitlab_completion_unverified' });
  });

  it('keeps missing platform evidence unknown instead of skipping the pipeline', async () => {
    const f = fixture();
    f.reads.list = async () => fail('evidence_truncated', 'Incomplete job evidence.');
    expect(await verifyGitlabCompletion(repo, identity, f.reads)).toMatchObject({ ok: false, code: 'evidence_truncated' });
  });

  it.each([
    { pipelineId: 20 }, { pipelineId: Number.NaN }, { jobId: 0 }, { checkoutSha: 'main' },
  ])('rejects invalid identity without contacting the platform: %j', async (patch) => {
    const f = fixture();
    expect(await verifyGitlabCompletion(repo, { ...identity, ...patch }, f.reads)).toMatchObject({ ok: false, code: 'gitlab_completion_unverified' });
    expect(f.calls).toHaveLength(0);
  });
});
