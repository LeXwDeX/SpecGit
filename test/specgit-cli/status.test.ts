import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../../src/cli/exit-codes.js';
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

  it('fails closed (exit 3) when the record is missing', async () => {
    const t = makeCtx({ policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.state).toBe('unbound');
    expect(envelope.errors[0].code).toBe('record_missing');
  });

  it('fails closed (exit 3) when the record is invalid', async () => {
    const t = makeCtx({ record: 'invalid', policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
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
