import { describe, expect, it, vi } from 'vitest';
import { resolveEffectivePolicy } from '../../src/record/effective-policy.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { fail, ok, type Evidence } from '../../src/kernel/evidence.js';
import { makeGitFacts, sampleBinding, samplePolicy } from '../specgit-cli/helpers.js';
import { makePrFact } from './helpers/mock-forge.js';
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
