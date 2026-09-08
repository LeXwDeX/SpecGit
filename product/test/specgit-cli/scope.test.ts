import { describe, expect, it, vi } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeCtx, parseStdoutJson } from './helpers.js';

const SHA = 'a'.repeat(40);
const content = JSON.stringify({ version: 1, name: 'programme', parent: 1, required: [{ issue: 10, target: 'preview' }] });
function fixture() {
  const t = makeCtx();
  t.ctx.git.readFileAtRemoteRef = vi.fn(async () => ok({ sha: SHA, content }));
  t.ctx.git.readFileHistory = vi.fn(async () => ok([{ sha: SHA, content }]));
  t.ctx.gh.getIssue = vi.fn(async (_repo, number) => ok({ number, state: 'open' as const, pullRequest: false }));
  t.ctx.gh.listIssuePullRequests = vi.fn(async () => ok([]));
  return t;
}

describe('finish --scope', () => {
  it('emits a separate scope result without invoking delivery acceptance or writes', async () => {
    const t = fixture();
    expect(await runCliWith(['node', 'specgit', 'finish', '--scope', 'programme', '--json'], t.ctx)).toBe(1);
    const result = parseStdoutJson(t.io);
    expect(result.verdict).toBeUndefined();
    expect(result.scope).toMatchObject({ state: 'incomplete', declaration: { sha: SHA, branch: 'main' }, members: [{ issue: 10, state: 'unbound' }] });
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
  });

  it('does not read a proposed workspace scope when the approved file is absent', async () => {
    const t = fixture();
    t.ctx.git.readFileAtRemoteRef = vi.fn(async () => ok({ sha: SHA, content: null }));
    expect(await runCliWith(['node', 'specgit', 'finish', '--scope', 'programme', '--json'], t.ctx)).toBe(3);
    expect(parseStdoutJson(t.io).errors[0].code).toBe('scope_unapproved');
    expect(t.ctx.git.readFileHistory).not.toHaveBeenCalled();
  });

  it('rejects a scope that changed during assessment', async () => {
    const t = fixture();
    t.ctx.git.readFileAtRemoteRef = vi.fn().mockResolvedValueOnce(ok({ sha: SHA, content }))
      .mockResolvedValue(ok({ sha: 'b'.repeat(40), content }));
    expect(await runCliWith(['node', 'specgit', 'finish', '--scope', 'programme', '--json'], t.ctx)).toBe(3);
    expect(parseStdoutJson(t.io).scope.state).toBe('unknown');
  });

  it('rejects unsafe scope names before probing the forge', async () => {
    const t = fixture();
    expect(await runCliWith(['node', 'specgit', 'finish', '--scope', '../policy', '--json'], t.ctx)).toBe(2);
    expect(t.ctx.gh.getIssue).not.toHaveBeenCalled();
  });
});
