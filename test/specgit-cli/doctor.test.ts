import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../../src/cli/exit-codes.js';
import {
  makeCtx,
  makeGitFacts,
  parseStdoutJson,
  samplePolicy,
  stdoutText,
} from './helpers.js';

describe('specgit doctor', () => {
  it('reports all probes green and exits 0', async () => {
    const t = makeCtx({ policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.probes.map((p: any) => p.name)).toEqual([
      'git',
      'repo',
      'origin',
      'gh_present',
      'gh_authenticated',
      'policy',
    ]);
    for (const probe of envelope.probes) {
      expect(probe.ok).toBe(true);
    }
  });

  it('prints a probe table in text mode', async () => {
    const t = makeCtx({ policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'doctor'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(stdoutText(t.io)).toContain('git');
    expect(stdoutText(t.io)).toContain('policy');
  });

  it('exits 3 when the GitHub provider is unauthenticated', async () => {
    const t = makeCtx({
      policy: samplePolicy(),
      gh: {
        preflight: async () => ({ ok: false, code: 'gh_unauthenticated', message: 'gh auth status failed.' }),
        getIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getOpenIssueNumbers: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getPr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getCheckRuns: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        createIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        createDraftPr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        listOpenPrsByHead: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getBranchProtection: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        enableBranchProtection: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getRepoAutomerge: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        enableRepoAutomerge: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
      },
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'gh_authenticated');
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe('gh_unauthenticated');
  });

  it('exits 3 when the policy is missing', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'policy');
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe('policy_missing');
  });

  it('exits 3 outside a git repository', async () => {
    const t = makeCtx({
      root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' },
      policy: samplePolicy(),
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'repo');
    expect(probe.ok).toBe(false);
  });

  it('reports a GitLab origin with gitlab_unsupported and still probes gh', async () => {
    const t = makeCtx({
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://gitlab.com/owner/repo.git' }),
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'origin');
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe('gitlab_unsupported');
    const ghPresent = envelope.probes.find((p: any) => p.name === 'gh_present');
    expect(ghPresent.ok).toBe(true);
  });
});
