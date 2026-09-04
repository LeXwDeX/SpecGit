import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { runInit } from '../../src/cli/commands/init.js';
import { inspectGeneratedAssets } from '../../src/cli/asset-drift.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeCtx, makeGitFacts } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const CI = '.gitlab-ci.yml';
const BUSINESS = '.gitlab/specgit-business.yml';
const COMPLETION = '.gitlab/specgit-complete.yml';
const BUSINESS_BYTES = '# original CI\r\ninclude: ci/shared.yml\r\nworkflow:\r\n  rules:\r\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\r\n    - if: $CI_COMMIT_BRANCH\r\nbuild:\r\n  script: echo business\r\n';

describe('GitLab completion routing transaction', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-gitlab-routing-'); });
  afterEach(() => { rmDir(root); });
  function write(file: string, bytes: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), bytes);
  }
  function fixture(ci = BUSINESS_BYTES) {
    write(CI, ci);
    write('ci/shared.yml', '.base:\n  image: node:24\n');
    const facts = makeGitFacts({ originUrl: 'git@gitlab.com:owner/repo.git' });
    const t = makeCtx({ root: ok(root), facts, parseRepoRef: (url) => parseRepoRef(url, { gitlabHost: 'gitlab.com' }) });
    Object.assign(t.ghProvider, { getCiConfigPath: vi.fn(async () => ok(null)) });
    return { ...t, facts };
  }
  function files(): Record<string, string> {
    return Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter((name) =>
      fs.statSync(path.join(root, String(name))).isFile()).map((name) => [String(name), fs.readFileSync(path.join(root, String(name)), 'base64')]));
  }
  const enabled = { requiredCheck: ['build'], protect: false, automation: 'yes', mergeTarget: 'main' };

  it('preserves original business bytes and local include semantics, then restores the edited business configuration on disable', async () => {
    const t = fixture();
    const original = files();
    const installed = await runInit(enabled, t.ctx);
    expect(installed.exit).toBe(0);
    expect(fs.readFileSync(path.join(root, BUSINESS), 'utf8')).toBe(BUSINESS_BYTES);
    expect(fs.readFileSync(path.join(root, 'ci/shared.yml'), 'base64')).toBe(original['ci/shared.yml']);
    const router = parse(fs.readFileSync(path.join(root, CI), 'utf8'));
    expect(router.build).toBeUndefined();
    expect(router.workflow).toBeUndefined();
    expect(router.include.map((entry: { local: string }) => entry.local)).toEqual([`/${BUSINESS}`, `/${COMPLETION}`]);
    expect(router['specgit-request-completion'].trigger.strategy).toBeUndefined();
    const beforeStatus = files();
    const status = await inspectGeneratedAssets({ root, ctx: t.ctx, facts: t.facts, policy: ok(installed.policy!) });
    expect(status.surfaces.find((surface) => surface.surface === 'init')?.assets).toContainEqual({ path: CI, state: 'current' });
    expect(files()).toEqual(beforeStatus);
    const edit = BUSINESS_BYTES + '\r\n# a later business edit\r\n';
    write(BUSINESS, edit);
    const refresh = makeCtx({ root: ok(root), facts: t.facts, policy: installed.policy! });
    const disabled = await runInit({ force: true, protect: false, automation: 'no' }, refresh.ctx);
    expect(disabled.exit).toBe(0);
    expect(fs.readFileSync(path.join(root, CI), 'utf8')).toBe(edit);
    expect(fs.existsSync(path.join(root, BUSINESS))).toBe(false);
    expect(fs.existsSync(path.join(root, COMPLETION))).toBe(false);
  });

  it.each([
    ['glob local includes', 'include: .gitlab/*.yml\nbuild:\n  script: echo test\n'],
    ['dynamic includes', 'include: "$CI_CONFIG"\nbuild:\n  script: echo test\n'],
    ['external includes', 'include:\n  - project: owner/templates\n    file: ci.yml\n'],
    ['self includes', 'include: .gitlab-ci.yml\nbuild:\n  script: echo test\n'],
    ['pipeline inputs', 'spec:\n  inputs:\n    target:\n---\nbuild:\n  script: echo test\n'],
    ['reserved jobs', 'specgit-request-completion:\n  script: user command\n'],
  ])('refuses unsupported %s without any write', async (_reason, bytes) => {
    const t = fixture(bytes);
    const before = files();
    const outcome = await runInit(enabled, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('gitlab_ci_unsupported');
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(files()).toEqual(before);
  });

  it('refuses an existing business-copy path before writes', async () => {
    const t = fixture();
    write(BUSINESS, 'User-owned unrelated file\n');
    const before = files();
    const outcome = await runInit(enabled, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('gitlab_ci_unsupported');
    expect(files()).toEqual(before);
  });

  it('rolls back the router, original CI bytes and new directories after a later policy-write failure', async () => {
    const t = fixture();
    const before = files();
    t.ctx.record.writePolicy = async () => { throw new Error('injected policy failure'); };
    const outcome = await runInit(enabled, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(files()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.gitlab'))).toBe(false);
  });
});
