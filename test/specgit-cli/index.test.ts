import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliWith, runMain } from '../../src/cli/index.js';
import * as wiring from '../../src/cli/wiring.js';
import { makeCtx, sampleBinding, samplePolicy } from './helpers.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(async () => {
    const error = new Error('Prompt interrupted');
    error.name = 'ExitPromptError';
    throw error;
  }),
}));

afterEach(() => vi.restoreAllMocks());

function captureProduction(t = makeCtx()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
  const manifest = wiring.readPackageJson();
  vi.spyOn(wiring, 'readPackageJson').mockReturnValue({ ...manifest, version: t.ctx.version });
  const context = vi.spyOn(wiring, 'createDefaultContext').mockReturnValue(t.ctx);
  return { stdout, stderr, context };
}

describe('shared CLI parsing and production context (#415)', () => {
  it.each(['--help', '--version'])('serves %s without resolving the production context', async (flag) => {
    const captured = captureProduction();
    captured.context.mockImplementation(() => { throw new Error('Context must stay lazy.'); });
    expect(await runMain(['node', 'specgit', flag])).toBe(0);
    expect(captured.context).not.toHaveBeenCalled();
    expect(captured.stdout.join('')).toContain(flag === '--version' ? '0.0.0-test' : 'Usage: specgit');
  });

  it.each([{ args: [] }, { args: ['unknown'] }, { args: ['status', '--unknown'] }])('reports parser usage $args without loading the context', async ({ args }) => {
    const captured = captureProduction();
    expect(await runMain(['node', 'specgit', ...args, '--json'])).toBe(2);
    expect(captured.context).not.toHaveBeenCalled();
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0])).toMatchObject({ exit: 2, status: 'error' });
  });

  it('keeps help usable when package metadata is unavailable', async () => {
    const captured = captureProduction();
    vi.mocked(wiring.readPackageJson).mockImplementation(() => { throw new Error('Missing package manifest.'); });
    expect(await runMain(['node', 'specgit', '--version'])).toBe(0);
    expect(captured.stdout.join('').trim()).toBe('0.0.0');
    expect(captured.context).not.toHaveBeenCalled();
  });

  it.each(['resolver', 'command'])('keeps thrown %s failures identical across injected and production entry points', async (phase) => {
    const t = makeCtx();
    const argv = ['node', 'specgit', 'status', '--json'];
    const crash = () => { throw new Error('Evidence transport crashed.'); };
    if (phase === 'command') t.ctx.discoverRoot = vi.fn(crash);
    const injected = await runCliWith(argv, t.ctx, phase === 'resolver' ? async () => crash() : undefined);
    const captured = captureProduction(t);
    if (phase === 'resolver') captured.context.mockImplementation(crash);
    const production = await runMain(argv);
    expect(injected).toBe(3);
    expect(production).toBe(injected);
    expect(t.io.stdout).toHaveLength(1);
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0])).toEqual(JSON.parse(t.io.stdout[0]));
    expect(JSON.parse(captured.stdout[0])).toMatchObject({
      command: 'status', exit: 3, status: 'unknown', errors: [{ code: 'unexpected_error' }],
    });
  });

  it('resolves the context once for a command and emits one success envelope', async () => {
    const captured = captureProduction(makeCtx({ record: sampleBinding(), policy: samplePolicy() }));
    expect(await runMain(['node', 'specgit', 'status', '--json'])).toBe(0);
    expect(captured.context).toHaveBeenCalledOnce();
    expect(captured.stdout).toHaveLength(1);
    expect(JSON.parse(captured.stdout[0])).toMatchObject({ command: 'status', exit: 0, status: 'ok' });
  });

  it('preserves production prompt interruption as exit 130 outside the JSON envelope', async () => {
    const t = makeCtx({ policy: samplePolicy(), stdinIsTTY: true });
    const captured = captureProduction(t);
    expect(await runMain(['node', 'specgit', 'issue', 'feat: 中文名称'])).toBe(130);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(['Interrupted.\n']);
    expect(t.recordPort.recordWrites).toEqual([]);
  });
});
