import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { makeCtx, makeGitFacts, parseStdoutJson, sampleBinding } from './helpers.js';

describe('specgit bind', () => {
  it('writes a new record with delivery, auto-resolved branch context, and coerced issue refs', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '123', '--pr', '42'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.recordWrites).toHaveLength(1);
    expect(t.recordPort.recordWrites[0].record).toEqual({
      version: 1,
      delivery: 'add-login-flow',
      context: { kind: 'branch', branch: 'feat/123-login' },
      issues: [123],
      pr: 42,
    });
  });

  it('auto-resolves a worktree context from live git facts', async () => {
    const t = makeCtx({
      facts: makeGitFacts({
        isLinkedWorktree: true,
        worktreeLabel: '123-login',
        worktrees: [{ label: '123-login', branch: 'feat/123-login' }],
      }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '1'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.recordWrites[0].record.context).toEqual({
      kind: 'worktree',
      label: '123-login',
      branch: 'feat/123-login',
    });
  });

  it('requires --delivery on the first bind', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--issue', '123', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('delivery_required');
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('rejects non-kebab delivery ids', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'Add_Login', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('delivery_invalid');
  });

  it('locks delivery after the first bind', async () => {
    const t = makeCtx({ record: sampleBinding() });
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'other-id', '--issue', '9', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('delivery_locked');
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('merges issues with dedupe keeping first-seen order', async () => {
    const t = makeCtx({ record: sampleBinding({ issues: [7, 123] }) });
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--issue', '123', '--issue', '9', '--issue', '7'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.recordWrites[0].record.issues).toEqual([7, 123, 9]);
  });

  it('replaces pr on flag presence and keeps it otherwise', async () => {
    const withReplace = makeCtx({ record: sampleBinding({ pr: 42 }) });
    await runCliWith(['node', 'specgit', 'bind', '--pr', '77'], withReplace.ctx);
    expect(withReplace.recordPort.recordWrites[0].record.pr).toBe(77);

    const withoutReplace = makeCtx({ record: sampleBinding({ pr: 42 }) });
    await runCliWith(['node', 'specgit', 'bind', '--issue', '9'], withoutReplace.ctx);
    expect(withoutReplace.recordPort.recordWrites[0].record.pr).toBe(42);
  });

  it('keeps a PR URL verbatim and coerces pure-digit refs', async () => {
    const t = makeCtx({ record: sampleBinding() });
    await runCliWith(
      ['node', 'specgit', 'bind', '--pr', 'https://github.com/LeXwDeX/SpecGit/pull/55'],
      t.ctx
    );
    expect(t.recordPort.recordWrites[0].record.pr).toBe(
      'https://github.com/LeXwDeX/SpecGit/pull/55'
    );
  });

  it('resolves GitHub issue URLs to their numbers', async () => {
    const t = makeCtx();
    await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', 'https://github.com/LeXwDeX/SpecGit/issues/7'],
      t.ctx
    );
    expect(t.recordPort.recordWrites[0].record.issues).toEqual([7]);
  });

  it('rejects opaque tracker ids at bind time', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', 'JIRA-123', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('issue_ref_not_github');
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('fails closed on detached HEAD', async () => {
    const t = makeCtx({ facts: makeGitFacts({ branch: null }) });
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('detached_head');
  });

  it('fails closed (exit 3) when the existing record is invalid', async () => {
    const t = makeCtx({ record: 'invalid' });
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('record_invalid');
  });

  it('preserves unknown keys already on disk', async () => {
    const t = makeCtx({ record: sampleBinding({ custom: { keep: true } }) });
    await runCliWith(['node', 'specgit', 'bind', '--issue', '9'], t.ctx);
    expect(t.recordPort.recordWrites[0].record.custom).toEqual({ keep: true });
  });

  it('never consults the GitHub provider', async () => {
    const t = makeCtx();
    await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '1', '--pr', '2'],
      t.ctx
    );
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('emits the bound record summary in JSON mode', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.record).toEqual({
      version: 1,
      delivery: 'add-login-flow',
      context: { kind: 'branch', branch: 'feat/123-login' },
      issues: [1],
    });
  });

  // ---- #299: record surgery must reach the delivery branch too. ----

  it('force-commits the bound record and pushes the branch (#299)', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.gitPort.commitCalls.length).toBe(1);
    expect(t.gitPort.commitCalls[0].paths).toContain('.specgit.yaml');
    expect(t.gitPort.pushCalls).toContain('feat/123-login');
  });

  it('a carry push failure downgrades to a warning, the record stays written (#299)', async () => {
    const t = makeCtx();
    t.gitPort.pushBranch = async () => ({
      ok: false as const,
      code: 'git_push_failed',
      message: 'git push failed: network',
    });
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'add-login-flow', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(JSON.stringify(envelope.warnings ?? [])).toContain('record_carry_push_failed');
    expect(t.recordPort.recordWrites).toHaveLength(1);
  });
});
