import { describe, expect, it, vi } from 'vitest';
import { resolveEffectivePolicy } from '../../src/record/effective-policy.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { GhCliGitHubProvider } from '../../src/providers/github/gh-cli.js';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { fail, ok, type Evidence } from '../../src/kernel/evidence.js';
import { makeGitFacts, sampleBinding, samplePolicy } from '../specgit-cli/helpers.js';
import { makePrFact } from './helpers/mock-forge.js';
import { createFakeGh } from './helpers/fake-gh.js';
import { createFakeGlab } from './helpers/fake-glab.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const SHA = 'a'.repeat(40);
function fixture(content: string | null) {
  return {
    root: '/repo', record: ok(sampleBinding()),
    git: {
      facts: vi.fn(async () => makeGitFacts()),
      remoteDefaultBranch: vi.fn(async () => ok('main')),
      readFileAtRemoteRef: vi.fn(async (): Promise<Evidence<{ sha: string; content: string | null }>> => ok({ sha: SHA, content })),
      readFileBeforeMerge: vi.fn(async () => ok({ sha: SHA, content })),
    },
    forge: { getPr: vi.fn(async () => ok(makePrFact({ baseBranch: 'Dev' }))) },
    parseRepoRef: () => ok({ platform: 'github' as const, owner: 'o', repo: 'r' }),
    readCandidate: vi.fn(async () => ok(samplePolicy({ required_checks: [], automation: { merge: true, target_branch: 'Dev' } }))),
  };
}

describe('approved policy resolution', () => {
  it('rejects a foreign bound PR before consulting that repository for policy', async () => {
    const f = fixture('version: 1\nrequired_checks: []');
    f.record = ok(sampleBinding({ pr: 'https://github.com/other/repository/pull/42' }));
    expect(await resolveEffectivePolicy(f)).toMatchObject({ ok: false, code: 'pr_repo_mismatch' });
    expect(f.forge.getPr).not.toHaveBeenCalled();
  });
  it('rejects a same-path GitHub PR URL on a GitLab origin before provider lookup', async () => {
    const f = fixture('version: 1\nrequired_checks: []');
    f.record = ok(sampleBinding({ pr: 'https://github.com/g/r/pull/42' }));
    const result = await resolveEffectivePolicy({
      ...f,
      parseRepoRef: () => ok({ platform: 'gitlab', owner: 'g', repo: 'r' }),
    });
    expect(result).toMatchObject({ ok: false, code: 'pr_repo_mismatch' });
    expect(f.forge.getPr).not.toHaveBeenCalled();
  });
  it('uses the approved base rules rather than the proposed weaker policy', async () => {
    const f = fixture('version: 1\nrequired_checks: [Review]\nautomation:\n  merge: false\n');
    expect(await resolveEffectivePolicy(f)).toEqual(ok({ source: 'approved', branch: 'Dev', sha: SHA,
      policy: { version: 1, required_checks: ['Review'], automation: { merge: false } } }));
    expect(f.readCandidate).not.toHaveBeenCalled();
    expect(f.git.readFileAtRemoteRef).toHaveBeenCalledWith('/repo', 'Dev', 'spec_git/policy.yaml');
  });
  it('allows a proven first adoption to be evaluated but never to authorize its own merge', async () => {
    const f = fixture(null);
    expect(await resolveEffectivePolicy(f)).toMatchObject({ ok: true, value: { source: 'adoption' } });
    expect(await resolveEffectivePolicy({ ...f, requireApproved: true })).toMatchObject({ ok: false, code: 'policy_approval_required' });
  });
  it('does not interpret unavailable objects or invalid approved data as first adoption', async () => {
    const f = fixture('version: 999\nrequired_checks: []');
    expect(await resolveEffectivePolicy(f)).toMatchObject({ ok: false, code: 'policy_invalid' });
    f.git.readFileAtRemoteRef.mockImplementation(async () => fail('policy_ref_unavailable', 'missing object'));
    expect(await resolveEffectivePolicy(f)).toMatchObject({ ok: false, code: 'policy_ref_unavailable' });
    expect(f.readCandidate).not.toHaveBeenCalled();
  });
  it('resolves the same approved policy seam for a GitLab target', async () => {
    const f = fixture('version: 1\nrequired_checks: [Pipeline]');
    const result = await resolveEffectivePolicy({ ...f, parseRepoRef: () => ok({ platform: 'gitlab', owner: 'g', repo: 'r' }) });
    expect(result).toMatchObject({ ok: true, value: { policy: { required_checks: ['Pipeline'] } } });
    expect(f.forge.getPr).toHaveBeenCalledWith({ platform: 'gitlab', owner: 'g', repo: 'r' }, 42);
  });
});

describe('read-only committed policy reader', () => {
  it.each([
    ['github', 'squash'], ['github', 'rebase'], ['github', 'fast-forward'],
    ['gitlab', 'squash'], ['gitlab', 'rebase'], ['gitlab', 'fast-forward'],
  ] as const)('proves %s target authorization through a real %s history', async (platform, strategy) => {
    const directory = makeTempDir('specgit-policy-strategy-');
    try {
      const { root, env } = initRepo(directory);
      const original = 'version: 1\nrequired_checks: [Review]\nautomation:\n  merge: false\n  close_issues: true\n  target_branch: main\n';
      const approved = commitFile(root, 'spec_git/policy.yaml', original, env);
      git(root, ['checkout', '-b', 'delivery'], env);
      commitFile(root, 'feature.txt', 'delivery\n', env);
      if (strategy === 'rebase') {
        git(root, ['checkout', 'main'], env);
        commitFile(root, 'unrelated.txt', 'target advanced\n', env);
        git(root, ['checkout', 'delivery'], env);
        git(root, ['rebase', 'main'], env);
      }
      const head = git(root, ['rev-parse', 'HEAD'], env).trim();
      git(root, ['checkout', 'main'], env);
      if (strategy === 'squash') {
        git(root, ['merge', '--squash', 'delivery'], env);
        git(root, ['commit', '-m', 'squash delivery'], env);
      } else git(root, ['merge', '--ff-only', 'delivery'], env);
      const merged = git(root, ['rev-parse', 'HEAD'], env).trim();
      const adapter = new LocalGitAdapter({ env });
      const repo = { platform, owner: 'o', repo: 'r' };
      git(root, ['remote', 'add', 'origin', `https://${platform}.com/o/r.git`], env);
      const payload = platform === 'github'
        ? { number: 42, state: 'closed', merged_at: '2026-09-07T00:00:00Z', draft: false,
          head: { ref: 'delivery', sha: head }, base: { ref: 'main', sha: approved }, merge_commit_sha: merged }
        : { iid: 42, state: 'merged', draft: false, source_branch: 'delivery', target_branch: 'main', sha: head,
          merge_commit_sha: null, squash_commit_sha: strategy === 'squash' ? merged : null,
          diff_refs: { head_sha: head, start_sha: approved } };
      const rules = [{ match: platform === 'github' ? '/pulls/42$' : '/merge_requests/42$', stdout: JSON.stringify(payload) }];
      const forge = platform === 'github'
        ? new GhCliGitHubProvider({ env: createFakeGh(directory, rules).env() })
        : new GlabProvider({ hostname: 'gitlab.com', env: createFakeGlab(directory, rules).env() });
      expect(await resolveEffectivePolicy({ root, record: ok(sampleBinding()), git: adapter, forge,
        parseRepoRef: () => ok(repo), requireApproved: true, readCandidate: async () => { throw new Error('Candidate cannot authorize itself'); } }))
        .toMatchObject({ ok: true, value: { source: 'approved', sha: approved, policy: { automation: { close_issues: true, merge: false } } } });
      expect(await adapter.readFileBeforeMerge(root, merged, head, 'spec_git/policy.yaml', approved)).toEqual(ok({ sha: approved, content: original }));
      expect(await adapter.readFileBeforeMerge(root, merged, head, 'spec_git/policy.yaml')).toMatchObject({ ok: false, code: 'policy_history_unavailable' });
      expect(await adapter.readFileBeforeMerge(root, merged, head, 'spec_git/policy.yaml', merged)).toMatchObject({ ok: false, code: 'policy_history_unavailable' });
      expect(await adapter.readFileBeforeMerge(root, merged, head, 'spec_git/policy.yaml', 'f'.repeat(40))).toMatchObject({ ok: false, code: 'policy_history_unavailable' });
      expect(git(root, ['status', '--porcelain'], env)).toBe('');
    } finally { rmDir(directory); }
  });
  it.each([false, true])('rejects changed target policy even when subsequently restored: %s', async (restore) => {
    const directory = makeTempDir('specgit-policy-changed-');
    try {
      const { root, env } = initRepo(directory);
      const original = 'version: 1\nrequired_checks: [Review]\n';
      const approved = commitFile(root, 'spec_git/policy.yaml', original, env);
      commitFile(root, 'spec_git/policy.yaml', 'version: 1\nrequired_checks: []\n', env);
      if (restore) commitFile(root, 'spec_git/policy.yaml', original, env);
      const head = commitFile(root, 'feature.txt', 'delivery\n', env);
      expect(await new LocalGitAdapter({ env }).readFileBeforeMerge(root, head, head, 'spec_git/policy.yaml', approved))
        .toMatchObject({ ok: false, code: 'policy_history_unavailable' });
    } finally { rmDir(directory); }
  });
  it('recovers only the proved original target parent after a real two-parent merge', async () => {
    const directory = makeTempDir('specgit-policy-history-');
    try {
      const { root, env } = initRepo(directory);
      const original = 'version: 1\nrequired_checks: [Review]\nautomation:\n  merge: true\n  target_branch: main\n';
      const approved = commitFile(root, 'spec_git/policy.yaml', original, env);
      git(root, ['checkout', '-b', 'delivery'], env);
      const head = commitFile(root, 'spec_git/policy.yaml', 'version: 1\nrequired_checks: []\nautomation:\n  merge: false\n', env);
      git(root, ['checkout', 'main'], env);
      git(root, ['merge', '--no-ff', 'delivery', '-m', 'merge delivery'], env);
      const merged = git(root, ['rev-parse', 'HEAD'], env).trim();
      const adapter = new LocalGitAdapter({ env });
      expect(await adapter.readFileBeforeMerge(root, merged, head, 'spec_git/policy.yaml')).toEqual(ok({ sha: approved, content: original }));
      expect(await adapter.readFileBeforeMerge(root, merged, approved, 'spec_git/policy.yaml')).toMatchObject({ ok: false, code: 'policy_history_unavailable' });
      expect(await adapter.readFileBeforeMerge(root, head, head, 'spec_git/policy.yaml')).toMatchObject({ ok: false, code: 'policy_history_unavailable' });
      expect(git(root, ['status', '--porcelain'], env)).toBe('');
    } finally { rmDir(directory); }
  });
  it('distinguishes a missing path from a missing commit without fetching or checking out', async () => {
    const calls: string[][] = [];
    const git = new LocalGitAdapter({ spawnImpl: async (_command, args) => {
      calls.push(args);
      return { stdout: args.includes('ls-remote') ? `${SHA}\trefs/heads/main\n` : '', stderr: '' };
    } });
    expect(await git.readFileAtRemoteRef('/repo', 'main', 'spec_git/policy.yaml')).toEqual(ok({ sha: SHA, content: null }));
    expect(calls.map((args) => args[2])).toEqual(['ls-remote', 'ls-tree']);
    const missing = new LocalGitAdapter({ spawnImpl: async (_command, args) => {
      if (args.includes('ls-tree')) throw new Error('object unavailable');
      return { stdout: `${SHA}\trefs/heads/main\n`, stderr: '' };
    } });
    expect(await missing.readFileAtRemoteRef('/repo', 'main', 'spec_git/policy.yaml')).toMatchObject({ ok: false, code: 'policy_ref_unavailable' });
  });
  it('rejects revision expressions and symlinks before reading policy bytes', async () => {
    const spawnImpl = vi.fn(async (_command: string, args: string[]) => ({ stdout: args.includes('ls-remote')
      ? `${SHA}\trefs/heads/main\n` : `120000 blob ${SHA}\tspec_git/policy.yaml\0`, stderr: '' }));
    const git = new LocalGitAdapter({ spawnImpl });
    expect(await git.readFileAtRemoteRef('/repo', 'main^{tree}', 'spec_git/policy.yaml')).toMatchObject({ ok: false });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(await git.readFileAtRemoteRef('/repo', 'main', 'spec_git/policy.yaml')).toMatchObject({ ok: false, code: 'policy_ref_invalid' });
    expect(spawnImpl.mock.calls.some(([, args]) => args.includes('show'))).toBe(false);
  });
});
