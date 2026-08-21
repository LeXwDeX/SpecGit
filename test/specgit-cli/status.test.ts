import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../../src/cli/exit-codes.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import {
  makeCtx,
  makeGitFacts,
  parseStdoutJson,
  sampleBinding,
  samplePolicy,
} from './helpers.js';

describe('specgit status (local evidence only, G1-G5)', () => {
  it('reports a bound state with all local gates passing', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.state).toBe('bound');
    expect(envelope.evidence.repo).toBe('LeXwDeX/SpecGit');
    expect(envelope.evidence.branch).toBe('feat/123-login');
    const gateIds = envelope.gates.map((g: any) => `${g.id}:${g.status}`);
    expect(gateIds).toEqual([
      'record:pass',
      'policy:pass',
      'completeness:pass',
      'context:pass',
      'origin:pass',
    ]);
  });

  it('reports draft state when the PR is missing but still exits 0', async () => {
    const t = makeCtx({
      record: sampleBinding({ pr: undefined }),
      policy: samplePolicy(),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.state).toBe('draft');
    const completeness = envelope.gates.find((g: any) => g.id === 'completeness');
    expect(completeness.status).toBe('fail');
    expect(completeness.failures.map((f: any) => f.code)).toEqual(['pr_missing']);
  });

  it('reports draft state when issues are empty', async () => {
    const t = makeCtx({
      record: sampleBinding({ issues: [] }),
      policy: samplePolicy(),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.state).toBe('draft');
    const completeness = envelope.gates.find((g: any) => g.id === 'completeness');
    expect(completeness.failures.map((f: any) => f.code)).toEqual(['issues_empty']);
  });

  it('reports a branch mismatch against live git', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      facts: makeGitFacts({ branch: 'other-branch' }),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    const gate = envelope.gates.find((g: any) => g.id === 'context');
    expect(gate.status).toBe('fail');
    expect(gate.failures.map((f: any) => f.code)).toEqual(['branch_mismatch']);
  });

  it('verifies worktree contexts against the live worktree list', async () => {
    const t = makeCtx({
      record: sampleBinding({ context: { kind: 'worktree', label: '123-login', branch: 'feat/123-login' } }),
      policy: samplePolicy(),
      facts: makeGitFacts({
        isLinkedWorktree: true,
        worktreeLabel: 'different-wt',
        worktrees: [{ label: 'different-wt', branch: 'feat/123-login' }],
      }),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    const gate = envelope.gates.find((g: any) => g.id === 'context');
    expect(gate.status).toBe('fail');
    expect(gate.failures.map((f: any) => f.code)).toEqual(['worktree_mismatch']);
  });

  // #175: a missing record is the normal pre-binding state, not a
  // fail-closed unknown — exit 0 with state `unbound`, the record gate
  // still reports `record_missing`, and the fix rides a warning.
  it('reports the pre-binding state (exit 0, state unbound) when the record is missing (#175)', async () => {
    const t = makeCtx({ policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.state).toBe('unbound');
    expect(envelope.exit).toBe(EXIT_SUCCESS);
    const record = envelope.gates.find((g: any) => g.id === 'record');
    expect(record.status).toBe('fail');
    expect(record.failures.map((f: any) => f.code)).toEqual(['record_missing']);
    expect(envelope.warnings?.[0]?.code).toBe('record_missing');
    expect(envelope.errors ?? []).toEqual([]);
  });

  it('fails closed (exit 3) when the record is invalid', async () => {
    const t = makeCtx({ record: 'invalid', policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.state).toBe('unknown');
    expect(envelope.errors[0].code).toBe('record_invalid');
  });

  it('fails closed (exit 3) outside a git repository', async () => {
    const t = makeCtx({ root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' } });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('not_a_git_repo');
  });

  it('reports a gitlab origin as gitlab_unsupported without failing the run', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://gitlab.example.com/o/r.git' }),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    const gate = envelope.gates.find((g: any) => g.id === 'origin');
    expect(gate.status).toBe('fail');
    expect(gate.failures.map((f: any) => f.code)).toEqual(['gitlab_unsupported']);
  });

  // #117 (provider routing): a DECLARED GitLab origin resolves through
  // the nested-group grammar — the origin gate passes and the evidence
  // repo carries the full group path.
  it('passes the origin gate for a declared GitLab origin (#117)', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://git.example.com/g/sg/p.git' }),
      parseRepoRef: (url: string) =>
        parseRepoRef(url, { gitlabHost: 'git.example.com' }),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    const gate = envelope.gates.find((g: any) => g.id === 'origin');
    expect(gate.status).toBe('pass');
    expect(envelope.evidence.repo).toBe('g/sg/p');
  });

  it('fails closed (exit 3) when the policy is missing', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: 'none' });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.state).toBe('bound');
    expect(envelope.errors[0].code).toBe('policy_missing');
    const policy = envelope.gates.find((g: any) => g.id === 'policy');
    expect(policy.status).toBe('fail');
  });

  it('fails closed (exit 3) when the policy is invalid', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: 'invalid' });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('policy_invalid');
  });

  it('fails closed (exit 3) when git cannot be spawned', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      facts: makeGitFacts({ gitAvailable: false }),
    });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.errors.map((e: any) => e.code)).toContain('git_unavailable');
    const context = envelope.gates.find((g: any) => g.id === 'context');
    expect(context.status).toBe('fail');
    expect(context.failures.map((f: any) => f.code)).toEqual(['git_unavailable']);
  });

  it('classifies repository state through the three-tier asset taxonomy', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(Object.keys(envelope.assets).sort()).toEqual([
      'authoritativeCommitted',
      'derivedCommittedHarness',
      'localIntegrationAssets',
    ]);
    expect(envelope.assets.authoritativeCommitted.paths).toContain('spec_git/policy.yaml');
    expect(envelope.assets.derivedCommittedHarness.paths).toContain('.github/workflows/specgit-accept.yml');
  });

  it('never contacts the GitHub provider', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy() });
    await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('never reads spec/task artifacts: only record and policy ports are touched', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy() });
    await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    const recordPort = t.recordPort as any;
    expect(recordPort.readRecord).toHaveBeenCalledTimes(1);
    expect(recordPort.readPolicy).toHaveBeenCalledTimes(1);
    expect(recordPort.writeRecord).not.toHaveBeenCalled();
    expect(recordPort.writePolicy).not.toHaveBeenCalled();
  });
});
