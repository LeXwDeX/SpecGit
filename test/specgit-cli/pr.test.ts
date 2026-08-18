/**
 * `specgit pr` — repair the PR binding: auto-discover the open PR by
 * head branch (0 → error with fix, >1 → refuse and list, 1 → bind), or
 * bind an explicit PR reference.
 */

import { describe, expect, it } from 'vitest';
import { runPr } from '../../src/cli/commands/pr.js';
import {
  makeCtx,
  makeGhProvider,
  makeGitFacts,
  sampleBinding,
  type GhScript,
} from './helpers.js';

function prCtx(options: { gh?: GhScript; record?: ReturnType<typeof sampleBinding> } = {}) {
  const gh = makeGhProvider(options.gh ?? {});
  const t = makeCtx({
    facts: makeGitFacts(),
    record: options.record ?? sampleBinding({ pr: undefined, delivery: 'add-login-flow' }),
    gh,
  });
  return { ...t, gh };
}

const prList = (prs: Array<{ number: number; title: string }>) => ({
  ok: true as const,
  value: prs.map((p) => ({
    ...p,
    url: `https://github.com/LeXwDeX/SpecGit/pull/${p.number}`,
  })),
});

describe('specgit pr: auto-discovery', () => {
  it('binds the single open PR found by head branch', async () => {
    const t = prCtx({ gh: { listOpenPrsByHead: (_repo, head) => prList([{ number: 7, title: 'Delivery add-login-flow' }]) } });
    const outcome = await runPr({}, t.ctx);

    expect(outcome.exit).toBe(0);
    expect(t.gh.calls).toEqual(['listOpenPrsByHead:feat/123-login']);
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.pr).toBe(7);
    expect(outcome.state).toBe('bound');
    expect(outcome.human?.join('\n')).toContain('#7');
  });

  it('zero candidates is a fail-closed error with a fix', async () => {
    const t = prCtx({ gh: { listOpenPrsByHead: () => prList([]) } });
    const outcome = await runPr({}, t.ctx);

    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('pr_not_found');
    expect(outcome.errors?.[0]?.fix).toBeTruthy();
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('multiple candidates refuses and lists them', async () => {
    const t = prCtx({
      gh: {
        listOpenPrsByHead: () =>
          prList([
            { number: 7, title: 'one' },
            { number: 9, title: 'two' },
          ]),
      },
    });
    const outcome = await runPr({}, t.ctx);

    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('pr_ambiguous');
    const text = `${outcome.errors?.[0]?.message}\n${(outcome.human ?? []).join('\n')}`;
    expect(text).toContain('#7');
    expect(text).toContain('#9');
    expect(t.recordPort.recordWrites.length).toBe(0);
  });

  it('provider failure is passed through fail-closed', async () => {
    const t = prCtx({
      gh: {
        listOpenPrsByHead: () => ({
          ok: false as const,
          code: 'gh_unauthenticated',
          message: 'GitHub CLI is not authenticated.',
          fix: 'Run "gh auth login" to authenticate.',
        }),
      },
    });
    const outcome = await runPr({}, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('gh_unauthenticated');
  });
});

describe('specgit pr: explicit binding', () => {
  it('binds a numeric reference without contacting GitHub', async () => {
    const t = prCtx();
    const outcome = await runPr({ ref: '42' }, t.ctx);

    expect(outcome.exit).toBe(0);
    expect(t.gh.calls.length).toBe(0);
    expect(t.recordPort.recordWrites.at(-1)?.record?.pr).toBe(42);
  });

  it('binds a PR URL reference verbatim (schema accepts number | string)', async () => {
    const t = prCtx();
    const url = 'https://github.com/LeXwDeX/SpecGit/pull/55';
    const outcome = await runPr({ ref: url }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.recordPort.recordWrites.at(-1)?.record?.pr).toBe(url);
  });
});

describe('specgit pr: preconditions', () => {
  it('without a record is a fail-closed error pointing at issue bootstrap', async () => {
    const t = makeCtx({ facts: makeGitFacts() });
    const outcome = await runPr({}, t.ctx);

    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('record_missing');
    expect(outcome.errors?.[0]?.fix).toContain('specgit issue');
  });
});
