import { beforeEach, describe, expect, it, vi } from 'vitest';

// #352: the interactive confirm's DEFAULT is under test — mock the prompt
// module the guardrail imports dynamically.
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

import { confirm } from '@inquirer/prompts';
import { setupBranchProtection } from '../../src/cli/commands/init-protection.js';
import type { InitOptions } from '../../src/cli/commands/init-validation.js';
import { catalogFor } from '../../src/i18n/language.js';
import { makeCtx } from './helpers.js';

const text = catalogFor('en').human;

describe('init branch-protection confirm default (#352)', () => {
  beforeEach(() => {
    vi.mocked(confirm).mockReset();
  });

  it('fresh adoption: the interactive confirm defaults to NO and a default answer keeps protection off', async () => {
    // The mock answers with the prompt's own default, like pressing Enter.
    vi.mocked(confirm).mockImplementation(async (question) => question.default ?? false);
    const t = makeCtx({ stdinIsTTY: true });
    const { outcome } = await setupBranchProtection(
      {} as InitOptions,
      t.ctx,
      '/repo',
      text,
      false,
      'main'
    );
    expect(confirm).toHaveBeenCalledOnce();
    const question = vi.mocked(confirm).mock.calls[0][0] as unknown as { default?: boolean };
    expect(question.default).toBe(false);
    expect(outcome?.action).toBe('warned');
    expect(
      t.ghProvider.calls.find((call) => call.startsWith('enableBranchProtection'))
    ).toBeUndefined();
  });

  it('adopted harness: the confirm defaults to YES and enables protection', async () => {
    vi.mocked(confirm).mockImplementation(async (question) => question.default ?? false);
    const t = makeCtx({ stdinIsTTY: true });
    const { outcome } = await setupBranchProtection(
      {} as InitOptions,
      t.ctx,
      '/repo',
      text,
      true,
      'main'
    );
    const question = vi.mocked(confirm).mock.calls[0][0] as unknown as { default?: boolean };
    expect(question.default).toBe(true);
    expect(
      t.ghProvider.calls.find((call) => call.startsWith('enableBranchProtection'))
    ).toBeDefined();
    expect(outcome?.action).toBe('protected');
  });
});
