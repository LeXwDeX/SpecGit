import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { runInit } from '../../src/cli/commands/init.js';
import { runCliWith } from '../../src/cli/index.js';
import { PolicySchema } from '../../src/record/policy.js';
import { makeCtx, parseStdoutJson, samplePolicy } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

let root: string;
beforeEach(() => { root = makeTempDir('specgit-repair-labels-'); });
afterEach(() => { rmDir(root); });
const project = (names: string[], repair?: string[]) => samplePolicy({
  validation: { labels: 'project' }, tags: names.map((name) => ({ name })),
  automation: { merge: true, target_branch: 'main', ...(repair ? { repair_labels: repair } : {}) },
});

it.each([['kind::fix', 'module::core'], ['module::core']])('derives an unambiguous repair mapping from %s', async (...names) => {
  const t = makeCtx({ root: { ok: true, value: root }, policy: project(names) });
  const result = await runInit({ force: true, protect: false, json: true }, t.ctx);
  expect(result.exit).toBe(0);
  expect(result.policy?.automation?.repair_labels).toEqual([names[0]]);
});
it('refuses an ambiguous scripted mapping before any write', async () => {
  const t = makeCtx({ root: { ok: true, value: root }, policy: project(['module::api', 'module::ui']) });
  const result = await runInit({ force: true, protect: false, json: true }, t.ctx);
  expect(result.exit).toBe(2);
  expect(result.errors?.[0]).toMatchObject({ code: 'repair_labels_required', fix: expect.stringContaining('--repair-label') });
  expect(t.recordPort.policyWrites).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});
it('offers only project labels and preserves the selected mapping on refresh', async () => {
  const t = makeCtx({ root: { ok: true, value: root }, policy: project(['module::api', 'module::ui']), stdinIsTTY: true });
  const selectRepairLabels = vi.fn(async () => ['module::ui']);
  const result = await runInit({ force: true, protect: false }, t.ctx, { selectRepairLabels });
  expect(result.exit).toBe(0);
  expect(selectRepairLabels).toHaveBeenCalledWith(['module::api', 'module::ui'], []);
  expect(result.policy?.automation?.repair_labels).toEqual(['module::ui']);
  const again = await runInit({ force: true, protect: false }, t.ctx, { selectRepairLabels });
  expect(again.policy?.automation?.repair_labels).toEqual(['module::ui']);
  expect(selectRepairLabels).toHaveBeenCalledOnce();
});
it('validates explicit repair labels against the selected vocabulary before writes', async () => {
  const t = makeCtx({ root: { ok: true, value: root }, policy: project(['module::api', 'module::ui']) });
  const result = await runInit({ force: true, protect: false, repairLabel: ['kind::fix'] }, t.ctx);
  expect(result.exit).toBe(2);
  expect(t.recordPort.policyWrites).toEqual([]);
});
it('collects repeated CLI repair labels without replacing the allowed vocabulary', async () => {
  const policy = project(['module::api', 'module::ui', 'priority::high']);
  const t = makeCtx({ root: { ok: true, value: root }, policy });
  const result = await runCliWith(['node', 'specgit', 'init', '--force', '--no-protect', '--json',
    '--repair-label', 'module::api', '--repair-label', 'priority::high'], t.ctx);
  expect(result, JSON.stringify(parseStdoutJson(t.io))).toBe(0);
  const saved = parseStdoutJson(t.io).policy;
  expect(saved.automation.repair_labels).toEqual(['module::api', 'priority::high']);
  expect(saved.tags).toEqual(policy.tags);
});
it('accepts portable mappings and rejects empty or invalid schema values', () => {
  expect(PolicySchema.safeParse(project(['module::api'], ['module::api'])).success).toBe(true);
  for (const repair of [[], ['bad label']]) expect(PolicySchema.safeParse(project(['module::api'], repair)).success).toBe(false);
});
