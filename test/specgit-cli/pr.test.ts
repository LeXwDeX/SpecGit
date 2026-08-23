/**
 * `specgit pr` — repair the PR binding: auto-discover the open PR by
 * head branch (0 → error with fix, >1 → refuse and list, 1 → bind), or
 * bind an explicit PR reference.
 */

import { describe, expect, it } from 'vitest';
import { CODE_INFO } from '../../src/acceptance/codes.js';
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

  it('zero candidates sources its fix verbatim from the code catalogue', async () => {
    const t = prCtx({ gh: { listOpenPrsByHead: () => prList([]) } });
    const outcome = await runPr({}, t.ctx);

    const catalogFix = CODE_INFO.pr_not_found.fix;
    expect(catalogFix).toBeTruthy();
    expect(outcome.errors?.[0]?.fix).toBe(catalogFix);
    expect(outcome.errors?.[0]?.fix).toContain('specgit pr');
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

// ---- #299: the repaired record must reach the PR head — local-only
// writes fork the local and CI verdicts. ----

describe('specgit pr: carrying commit (#299)', () => {
  it('force-commits the repaired record and pushes the branch', async () => {
    const t = prCtx({ gh: { listOpenPrsByHead: (_repo, head) => prList([{ number: 7, title: 'Delivery add-login-flow' }]) } });
    const outcome = await runPr({}, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.gitPort.commitCalls.length).toBe(1);
    expect(t.gitPort.commitCalls[0].paths).toContain('.specgit.yaml');
    expect(t.gitPort.pushCalls).toContain('feat/123-login');
  });

  it('a carry push failure downgrades to a warning (offline stays usable), the record is committed and written (#299)', async () => {
    const t = prCtx({
      gh: { listOpenPrsByHead: () => prList([{ number: 7, title: 'Delivery add-login-flow' }]) },
    });
    t.gitPort.pushBranch = async () => ({
      ok: false as const,
      code: 'git_push_failed',
      message: 'git push failed: network',
    });
    const outcome = await runPr({}, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.recordPort.recordWrites.at(-1)?.record?.pr).toBe(7);
    expect(t.gitPort.commitCalls.length).toBe(1);
    expect(JSON.stringify(outcome.warnings ?? [])).toContain('record_carry_push_failed');
  });

  it('an off-branch repair skips the carry and warns (#299)', async () => {
    const t = prCtx({ gh: { listOpenPrsByHead: () => prList([{ number: 7, title: 'x' }]) } });
    t.gitPort.facts = async () => makeGitFacts({ branch: 'some-other-branch' });
    const outcome = await runPr({}, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.gitPort.commitCalls.length).toBe(0);
    expect(t.gitPort.pushCalls.length).toBe(0);
    expect(JSON.stringify(outcome.warnings ?? [])).toContain('record_carry_skipped');
  });
});
