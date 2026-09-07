import { describe, expect, it } from 'vitest';
import { resolveGitlabMergeSignal } from '../../src/providers/gitlab/merge-signal.js';
import { fail, ok } from '../../src/kernel/evidence.js';

const repo = { platform: 'gitlab' as const, owner: 'group', repo: 'project' };
const merge = 'a'.repeat(40);
const head = 'b'.repeat(40);
const candidate = { iid: 42, state: 'merged', target_branch: 'preview' };

describe('GitLab target merge signals', () => {
  it.each(['merge_commit_sha', 'squash_commit_sha', 'sha'])('resolves a confirmed %s identity for subsequent policy verification', async (field) => {
    expect(await resolveGitlabMergeSignal(repo, merge, 'preview', {
      list: async () => ok([candidate]), api: async () => ok({ ...candidate, sha: head, [field]: merge }),
    })).toEqual(ok({ pr: 42, headSha: field === 'sha' ? merge : head }));
  });
  it('ignores ordinary pushes and historical requests that did not introduce this merge', async () => {
    expect(await resolveGitlabMergeSignal(repo, merge, 'preview', { list: async () => ok([]), api: async () => ok({}) })).toEqual(ok(undefined));
    expect(await resolveGitlabMergeSignal(repo, merge, 'preview', {
      list: async () => ok([candidate]), api: async () => ok({ ...candidate, sha: head, merge_commit_sha: head }),
    })).toEqual(ok(undefined));
  });
  it('preserves incomplete evidence and rejects ambiguous commit associations', async () => {
    expect(await resolveGitlabMergeSignal(repo, merge, 'preview', {
      list: async () => fail('evidence_truncated', 'incomplete'), api: async () => ok({}),
    })).toMatchObject({ ok: false, code: 'evidence_truncated' });
    expect(await resolveGitlabMergeSignal(repo, merge, 'preview', {
      list: async () => ok([1, 2].map((iid) => ({ ...candidate, iid }))),
      api: async (path) => ok({ ...candidate, iid: Number(path.split('/').at(-1)), sha: head, merge_commit_sha: merge }),
    })).toMatchObject({ ok: false, message: expect.stringContaining('multiple') });
  });
  it('rejects malformed input before reading the platform', async () => {
    const unexpected = async () => { throw new Error('unexpected read'); };
    expect(await resolveGitlabMergeSignal(repo, '--all', 'preview', { api: unexpected, list: unexpected })).toMatchObject({ ok: false });
  });
});
