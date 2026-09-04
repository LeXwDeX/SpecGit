import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/acceptance/evaluate.js';
import { ok } from '../../src/kernel/evidence.js';
import type { SpawnFn } from '../../src/kernel/spawn.js';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { makeGitFacts } from '../specgit-cli/helpers.js';

const repo = { owner: 'group/nested', repo: 'project', platform: 'gitlab' } as const;
const branch = 'feat/123-login';
const head = 'a'.repeat(40);

function providerWith(fault?: 'issue' | 'mr'): GlabProvider {
  const spawnImpl: SpawnFn = async (_command, args) => {
    const endpoint = args.find((arg) => arg.startsWith('projects/'));
    let payload;
    if (endpoint?.endsWith('/issues/123')) {
      payload = { iid: fault === 'issue' ? 124 : 123, state: 'opened', title: 'fix: bound issue' };
    } else if (endpoint?.endsWith('/merge_requests/42')) {
      payload = {
        iid: fault === 'mr' ? 43 : 42, state: 'opened', draft: false,
        title: 'fix: bound delivery', source_branch: branch, target_branch: 'main',
        sha: head, description: 'Closes #123', merge_commit_sha: null,
      };
    } else {
      throw new Error(`Unexpected test endpoint: ${endpoint}`);
    }
    return { stdout: JSON.stringify(payload), stderr: '' };
  };
  return new GlabProvider({ hostname: 'git.example.com', spawnImpl });
}

async function verdict(fault?: 'issue' | 'mr') {
  const provider = providerWith(fault);
  return evaluate({
    root: ok('/repo'), policy: ok({ version: 1, required_checks: [] }),
    record: ok({ version: 1, delivery: 'audit', context: { kind: 'branch', branch }, issues: [123], pr: 42 }),
    gitlabHost: 'git.example.com',
    git: {
      facts: async () => makeGitFacts({ branch, headSha: head, originUrl: 'https://git.example.com/group/nested/project.git' }),
      headContains: async () => ok({ contained: false }),
    },
    gh: {
      preflight: async () => ok({ authenticated: true }),
      getIssue: (project, number) => provider.getIssue(project, number),
      getPr: (project, number) => provider.getPr(project, number),
      getOpenIssueNumbers: async () => ok([]),
      getCheckRuns: async () => ok([]),
      getEvidenceAnchor: async () => ok({ anchoredAt: null }),
    },
  });
}

describe('GitLab bound entity identity', () => {
  it('refuses an issue response whose IID differs from the requested issue', async () => {
    expect(await providerWith('issue').getIssue(repo, 123)).toMatchObject({ ok: false, code: 'glab_transport' });
  });

  it('refuses a merge request response whose IID differs from the requested MR', async () => {
    expect(await providerWith('mr').getPr(repo, 42)).toMatchObject({ ok: false, code: 'glab_transport' });
  });

  it.each(['issue', 'mr'] as const)('keeps acceptance unknown when the %s response describes another bound entity', async (fault) => {
    const result = await verdict(fault);
    expect(result).toMatchObject({ accepted: false, classification: 'unknown', exitCode: 3 });
    expect(result.gates.find((gate) => gate.id === (fault === 'issue' ? 'issues' : 'pr'))?.failures)
      .toContainEqual(expect.objectContaining({ code: 'glab_transport' }));
  });

  it('accepts the otherwise identical delivery when both response IIDs match', async () => {
    expect(await verdict()).toMatchObject({ accepted: true, classification: 'accepted', exitCode: 0 });
  });
});
