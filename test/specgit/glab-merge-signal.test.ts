import { describe, expect, it } from 'vitest';
import { resolveGitlabMergeSignal } from '../../src/providers/gitlab/merge-signal.js';

const repo = { platform: 'gitlab' as const, owner: 'group', repo: 'project' };
const merge = 'a'.repeat(40);
const head = 'b'.repeat(40);

describe('GitLab target merge signals', () => {
  it.each(['merge_commit_sha', 'squash_commit_sha', 'sha'])('resolves a confirmed %s merge through authenticated request detail', (field) => {
    const result = resolveGitlabMergeSignal(repo, merge, 'preview', (path) => path.includes('?')
      ? [{ iid: 42, state: 'merged', target_branch: 'preview' }]
      : { iid: 42, state: 'merged', target_branch: 'preview', sha: head, [field]: merge });
    expect(result).toEqual({ pr: 42, headSha: field === 'sha' ? merge : head });
  });
  it('ignores ordinary pushes and a historical request that did not introduce this merge', () => {
    expect(resolveGitlabMergeSignal(repo, merge, 'preview', () => [])).toBeUndefined();
    expect(resolveGitlabMergeSignal(repo, merge, 'preview', (path) => path.includes('?')
      ? [{ iid: 42, state: 'merged', target_branch: 'preview' }]
      : { iid: 42, state: 'merged', target_branch: 'preview', sha: head, merge_commit_sha: head })).toBeUndefined();
  });
  it('reads all pages and rejects ambiguous or incomplete commit associations', () => {
    const seen: string[] = [];
    const read = (path: string) => {
      seen.push(path);
      if (path.endsWith('&page=1')) return Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, state: 'open' }));
      if (path.endsWith('&page=2')) return [{ iid: 101, state: 'merged', target_branch: 'preview' }];
      return { iid: 101, state: 'merged', target_branch: 'preview', sha: head, merge_commit_sha: merge };
    };
    expect(resolveGitlabMergeSignal(repo, merge, 'preview', read)?.pr).toBe(101);
    expect(seen).toHaveLength(3);
    expect(() => resolveGitlabMergeSignal(repo, merge, 'preview', () => Array.from({ length: 100 }, (_, i) => ({ iid: i + 1 })))).toThrow(/incomplete/);
    expect(() => resolveGitlabMergeSignal(repo, merge, 'preview', (path) => path.includes('?')
      ? [1, 2].map((iid) => ({ iid, state: 'merged', target_branch: 'preview' }))
      : { iid: Number(path.split('/').at(-1)), state: 'merged', target_branch: 'preview', sha: head, merge_commit_sha: merge })).toThrow(/multiple/);
  });
  it('rejects malformed input before reading the platform', () => {
    expect(() => resolveGitlabMergeSignal(repo, '--all', 'preview', () => { throw new Error('unexpected read'); })).toThrow(/Invalid GitLab/);
  });
});
