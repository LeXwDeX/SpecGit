/**
 * applyDeliveryTags (#330) — the pool-first tag step of `specgit issue`,
 * focused tests with injected ports. Priorities pinned here:
 *   1. The pool wins: valid existing labels are applied verbatim.
 *   2. Missing labels seed only from declared vocabulary (built-in
 *      kind:: catalog or policy tags:), never invented at apply time.
 *   3. Explicit mode is strict (fail-closed, usage-refused unknowns);
 *      inferred mode is best-effort (degrades to a stderr warning).
 * Off-spec pool leftovers are reported and never rewritten.
 */

import { describe, expect, it } from 'vitest';

import { ok, fail } from '../../src/kernel/evidence.js';
import { EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { applyDeliveryTags } from '../../src/cli/commands/tagging.js';
import { fallbackColorFor } from '../../src/tags/catalog.js';
import {
  makeCtx,
  makeGhProvider,
  samplePolicy,
  type CtxOptions,
  type GhScript,
} from './helpers.js';
import type { RepoRef } from '../../src/gitfacts/origin.js';
import type { LabelsAppliedFact, RepoLabelsFact } from '../../src/github/port.js';

const repo: RepoRef = { platform: 'github', owner: 'LeXwDeX', repo: 'SpecGit' };

interface TagHarness {
  seeded: Array<{ name: string; color: string }>;
  applied: Array<{ issue: number; slugs: string[] }>;
}

function tagCtx(options: {
  pool?: string[];
  poolFail?: { code: string; message: string };
  ensureFail?: { code: string; message: string };
  applyFail?: { code: string; message: string };
  policy?: CtxOptions['policy'];
} = {}) {
  const harness: TagHarness = { seeded: [], applied: [] };
  const ghScript: GhScript = {};
  if (options.poolFail) {
    const failure = options.poolFail;
    ghScript.listRepoLabels = () => fail(failure.code, failure.message) as never;
  } else {
    const names = options.pool ?? [];
    ghScript.listRepoLabels = () => ok<RepoLabelsFact>({ names }) as never;
  }
  if (options.ensureFail) {
    const failure = options.ensureFail;
    ghScript.ensureRepoLabels = (_repo, specs) => {
      harness.seeded.push(...specs);
      return fail(failure.code, failure.message) as never;
    };
  } else {
    ghScript.ensureRepoLabels = (_repo, specs) => {
      harness.seeded.push(...specs);
      return ok<LabelsAppliedFact>({ names: specs.map((s) => s.name) }) as never;
    };
  }
  if (options.applyFail) {
    const failure = options.applyFail;
    ghScript.addIssueLabels = (_repo, issue) =>
      fail(failure.code, failure.message) as never;
  } else {
    ghScript.addIssueLabels = (_repo, issue, slugs) => {
      harness.applied.push({ issue, slugs });
      return ok<LabelsAppliedFact>({ names: slugs }) as never;
    };
  }
  const t = makeCtx({
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    gh: makeGhProvider(ghScript),
  });
  // ctx.gh is the injected provider (makeCtx keeps its default unused);
  // every tag call the step makes records on this instance.
  const gh = t.ctx.gh as ReturnType<typeof makeGhProvider>;
  return { ...t, harness, gh };
}

describe('applyDeliveryTags — explicit mode (--tags)', () => {
  it('applies pool members verbatim and seeds nothing', async () => {
    const t = tagCtx({ pool: ['bug', 'module::auth'] });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: ['bug', 'module::auth'],
      inferredSlug: null,
    });
    expect(result).toEqual({ status: 'applied', applied: ['bug', 'module::auth'], seeded: [], dirty: [] });
    expect(t.harness.seeded).toEqual([]);
    expect(t.harness.applied).toEqual([{ issue: 7, slugs: ['bug', 'module::auth'] }]);
  });

  it('seeds a built-in kind:: member missing from an empty pool with its catalog color', async () => {
    const t = tagCtx();
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: ['kind::fix'],
      inferredSlug: null,
    });
    expect(result).toMatchObject({ status: 'applied', applied: ['kind::fix'] });
    expect(t.harness.seeded).toHaveLength(1);
    expect(t.harness.seeded[0].name).toBe('kind::fix');
    expect(t.harness.seeded[0].color).toMatch(/^[0-9A-F]{6}$/);
  });

  it('refuses unknown vocabulary with zero side effects (exit 2)', async () => {
    const t = tagCtx({ pool: ['bug'] });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: ['module::ghost'],
      inferredSlug: null,
    });
    expect('exit' in result && result.exit).toBe(EXIT_USAGE);
    expect('errors' in result && result.errors?.[0]?.code).toBe('issue_tags_unknown');
    expect('errors' in result && result.errors?.[0]?.fix).toContain('tags:');
    expect(t.gh.calls).not.toContain('createIssue');
    expect(t.harness.seeded).toEqual([]);
    expect(t.harness.applied).toEqual([]);
  });

  it('refuses off-grammar requests before any probe side effect beyond listing', async () => {
    const t = tagCtx();
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: ['Kind::X'],
      inferredSlug: null,
    });
    expect('exit' in result && result.exit).toBe(EXIT_USAGE);
    expect('errors' in result && result.errors?.[0]?.code).toBe('issue_tags_invalid');
    expect(t.harness.seeded).toEqual([]);
  });

  it('propagates a pool-probe failure fail-closed with its provider code', async () => {
    const t = tagCtx({ poolFail: { code: 'gh_unauthenticated', message: 'expired token' } });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: ['kind::feat'],
      inferredSlug: null,
    });
    if (!('exit' in result)) throw new Error('expected an IssueOutcome');
    expect(result.exit).toBe(3);
    expect(result.errors?.[0]?.code).toBe('gh_unauthenticated');
  });

  it('reports dirty pool labels without touching them', async () => {
    const t = tagCtx({ pool: ['Priority:High', '中文 标签'] });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: ['kind::docs'],
      inferredSlug: null,
    });
    expect(result).toMatchObject({ status: 'applied', dirty: ['Priority:High', '中文 标签'] });
    expect(t.io.stderr.join('\n')).toContain('outside the tag grammar');
    // Untouched: no rename/delete machinery exists on the port; exactly
    // list + ensure(seed) + apply ran, nothing more.
    expect(t.gh.calls.filter((c) => /Labels/.test(c))).toHaveLength(3);
  });

  it('seeds policy-declared vocabulary with the declared color', async () => {
    const t = tagCtx({
      policy: samplePolicy({
        tags: [{ name: 'module::auth', color: '12AB34' }, { name: 'feature::billing' }],
      }),
    });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [9],
      requested: ['module::auth', 'feature::billing'],
      inferredSlug: null,
    });
    expect(result).toMatchObject({ status: 'applied' });
    expect(t.harness.seeded).toEqual([
      { name: 'module::auth', color: '12AB34' },
      { name: 'feature::billing', color: fallbackColorFor('feature::billing') },
    ]);
  });

  it('skips silently when there is nothing to do', async () => {
    const t = tagCtx({ pool: [] });
    const emptyIssues = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [],
      requested: undefined,
      inferredSlug: 'kind::feat',
    });
    expect(emptyIssues).toEqual({ status: 'skipped', applied: [], seeded: [], dirty: [] });
    expect(t.gh.calls).toEqual([]);
  });
});

describe('applyDeliveryTags — inferred mode (no --tags)', () => {
  it('degrades to a localized warning when the pool cannot be read', async () => {
    for (const [language, expected] of [
      ['en', 'label pool could not be read'],
      ['zh', '无法读取仓库标签池'],
    ] as const) {
      const t = tagCtx({ poolFail: { code: 'gh_transport', message: 'down' } });
      const result = await applyDeliveryTags({
        ctx: t.ctx,
        root: '/repo',
        repo,
        language,
        issues: [7],
        requested: undefined,
        inferredSlug: 'kind::feat',
      });
      expect(result).toEqual({ status: 'degraded', applied: [], seeded: [], dirty: [] });
      expect(t.io.stderr.join('\n')).toContain(expected);
    }
  });

  it('degrades when seeding fails (permission), warning instead of failing the bootstrap', async () => {
    const t = tagCtx({ ensureFail: { code: 'gh_transport', message: 'HTTP 403 needs admin' } });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: undefined,
      inferredSlug: 'kind::fix',
    });
    expect(result).toMatchObject({ status: 'degraded' });
    expect(t.io.stderr.join('\n')).toContain('Warning');
    expect(t.harness.applied).toEqual([]);
  });

  it('warns once on policy_invalid but keeps the pool universe working', async () => {
    const t = tagCtx({ policy: 'invalid', pool: ['module::auth'] });
    const result = await applyDeliveryTags({
      ctx: t.ctx,
      root: '/repo',
      repo,
      language: 'en',
      issues: [7],
      requested: undefined,
      inferredSlug: 'kind::docs',
    });
    expect(result).toMatchObject({ status: 'applied', applied: ['kind::docs'] });
    expect(t.io.stderr.join('\n')).toContain('its tags vocabulary was ignored');
  });
});
