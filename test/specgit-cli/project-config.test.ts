import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { createDefaultContext } from '../../src/cli/wiring.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeCtx, makeGitFacts } from './helpers.js';
import { createFakeGlab, readFakeGlabCalls } from '../specgit/helpers/fake-glab.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('project convention configuration', () => {
  let root: string;
  let forgeDir: string | undefined;
  beforeEach(() => { root = makeTempDir('specgit-project-config-'); });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmDir(root);
    if (forgeDir !== undefined) rmDir(forgeDir);
    forgeDir = undefined;
  });
  it('persists explicit title and label choices separately from automation', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const result = await runInit({
      language: 'en', titleCheck: 'yes', labelCheck: 'kind', allowedLabel: ['module::auth'],
      protect: false, automation: 'no', json: true,
    }, t.ctx);
    expect(result.exit).toBe(0);
    expect(result.policy).toMatchObject({
      validation: { titles: true, labels: 'kind' }, tags: [{ name: 'module::auth' }],
      automation: { merge: false },
    });
  });
  it('requires a nonempty selected vocabulary in project mode before writes', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const result = await runInit({ labelCheck: 'project', protect: false, json: true }, t.ctx);
    expect(result.exit).toBe(2);
    expect(t.recordPort.policyWrites).toEqual([]);
  });
  it('does not prompt for project choices from a JSON invocation', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const result = await runInit({ configureRules: true, protect: false, json: true }, t.ctx);
    expect(result.exit).toBe(2);
    expect(t.recordPort.policyWrites).toEqual([]);
  });
  it.each([
    { selected: ['module::auth'], exit: 0 },
    { selected: [], exit: 2 },
  ])('reads fresh GitLab project labels before writing, with selection $selected', async ({ selected, exit }) => {
    forgeDir = makeTempDir('specgit-project-config-glab-');
    const fake = createFakeGlab(forgeDir, [{
      match: 'projects/team%2Fapp/labels', stdout: JSON.stringify([{ name: 'module::auth' }]),
    }]);
    vi.stubEnv('SPECGIT_GLAB', fake.env().SPECGIT_GLAB!);
    vi.stubEnv('FAKE_GLAB_CONFIG', fake.configPath);
    const originUrl = 'https://git.example.com:8443/team/app.git';
    const injected = makeCtx({ facts: makeGitFacts({ originUrl }) });
    const ctx = createDefaultContext({ discoverRoot: async () => ok(root) });
    ctx.git = injected.gitPort;
    ctx.io = injected.io.writeOut;
    ctx.stdinIsTTY = true;
    // Cache the absent declaration first: the temporary read must not change it.
    expect((await ctx.parseRepoRef(originUrl)).ok).toBe(false);
    const answers = ['en', 'yes', 'project'];
    const selectLabels = vi.fn(async (names: string[]) => {
      expect(names).toContain('module::auth');
      expect(readdirSync(root)).toEqual([]);
      expect((await ctx.parseRepoRef(originUrl)).ok).toBe(false);
      return selected;
    });
    const result = await runInit({
      gitlabHost: 'git.example.com:8443', configureRules: true,
      requiredCheck: ['test'], protect: false, automation: 'no',
    }, ctx, { selectRule: async () => answers.shift()!, selectLabels });
    expect(result.exit).toBe(exit);
    expect(selectLabels).toHaveBeenCalledOnce();
    const reads = readFakeGlabCalls(fake.logPath);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('--hostname git.example.com:8443');
    expect(reads[0]).toContain('projects/team%2Fapp/labels');
    if (exit === 0) {
      expect(result.policy).toMatchObject({
        validation: { titles: true, labels: 'project' }, tags: [{ name: 'module::auth' }],
      });
    } else {
      expect(result.errors?.[0].code).toBe('project_rules_invalid');
      expect(readdirSync(root)).toEqual([]);
    }
  });
  it('saves the selected choices and preserves them on an ordinary upgrade', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: true });
    const answers = ['zh', 'yes', 'kind'];
    const result = await runInit({ configureRules: true, protect: false, automation: 'no' }, t.ctx, {
      selectRule: async (_message, choices) => {
        const answer = answers.shift()!;
        expect(choices.some((choice) => choice.value === answer)).toBe(true);
        return answer;
      },
    });
    expect(result.exit).toBe(0);
    expect(result.policy).toMatchObject({ language: 'zh', validation: { titles: true, labels: 'kind' } });
    const upgraded = await runInit({ force: true, protect: false, automation: 'no' }, t.ctx);
    expect(upgraded.policy).toMatchObject({ language: 'zh', validation: { titles: true, labels: 'kind' } });
  });
});
