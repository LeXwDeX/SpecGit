import { describe, expect, it, vi } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { makeCtx, samplePolicy } from './helpers.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(async () => {
    const error = new Error('User interrupted the prompt');
    error.name = 'ExitPromptError';
    throw error;
  }),
}));

describe('issue delivery naming interruption (#400)', () => {
  it('exits 130 without a usage envelope when the naming prompt is interrupted', async () => {
    const t = makeCtx({ policy: samplePolicy(), stdinIsTTY: true });
    const code = await runCliWith(['node', 'specgit', 'issue', 'feat: 中文名称'], t.ctx);
    expect(code).toBe(130);
    expect(t.io.stdout).toEqual([]);
    expect(t.io.stderr).toEqual(['Interrupted.']);
    expect(t.recordPort.recordWrites).toEqual([]);
  });
});
