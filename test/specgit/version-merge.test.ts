import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, fail } from '../../src/kernel/evidence.js';
import type { CheckRunInfo, ForgeProvider, PrFact } from '../../src/github/port.js';
import { mergeVersionPullRequest } from '../../scripts/merge-version-pr.mjs';
import { MockForgeProvider } from './helpers/mock-forge.js';
import type { Policy } from '../../src/record/policy.js';

const sha = 'a'.repeat(40);
const repo = { owner: 'owner', repo: 'project', platform: 'github' as const };

const enabled: Policy = { version: 1, required_checks: ['Test'], automation: { merge: true, target_branch: 'main', close_issues: true } };
const pr: PrFact = { number: 42, state: 'open', headBranch: 'changeset-release/main', baseBranch: 'main', headSha: sha, draft: false, body: 'Automated version bump.', mergeCommitSha: null };
function check(name: string, conclusion: string | null = 'success', status = 'completed'): CheckRunInfo {
  return { name, conclusion, status, id: 1, startedAt: null };
}
function fixture() {
  const calls: string[] = [];
  let merged = false;
  const provider: Pick<ForgeProvider, 'listOpenPrsByHead' | 'getPr' | 'getPrChecks' | 'mergePr'> = {
    async listOpenPrsByHead(_repo, head) { calls.push(`list:${head}`); return ok([{ number: 42, title: 'chore(release): v2.0.0', url: 'https://github.com/owner/project/pull/42' }]); },
    async getPr(_repo, number) { calls.push(`pr:${number}`); return ok({ ...pr, state: merged ? 'merged' : 'open', mergeCommitSha: merged ? 'b'.repeat(40) : null }); },
    async getPrChecks() { calls.push('checks'); return ok({ headSha: sha, checks: [check('Test'), check('classic: scan'), check('workflow: CI (pull_request)'), check('Nix', 'skipped')] }); },
    async mergePr(_repo, number, expectedSha) { calls.push(`merge:${number}:${expectedSha}`); merged = true; return ok({ merged: true }); },
  };
  let time = 0;
  return { provider, calls, options: { policy: enabled, provider, repo, expectedHeadSha: sha, now: () => time, sleep: async (ms: number) => { time += ms; }, timeoutMs: 20, pollIntervalMs: 10, log: () => {} } };
}

describe('configured version PR merge', () => {
  it.each<Policy | undefined>([
    undefined,
    { version: 1, required_checks: [] },
    { version: 1, required_checks: [], automation: { merge: false, close_issues: false } },
    { version: 1, required_checks: [], automation: { merge: true, target_branch: 'release/stable' } },
  ])('keeps the version PR untouched when main merge is not enabled: %j', async (policy) => {
    const provider = new MockForgeProvider();
    const messages: string[] = [];
    expect(await mergeVersionPullRequest({ policy, provider, repo, expectedHeadSha: sha, log: (message) => messages.push(message) })).toEqual({ status: 'disabled' });
    expect(provider.calls).toEqual([]);
    expect(messages.join('\n')).toMatch(/disabled.*init --force/i);
  });
  it('merges the verified version head and confirms the resulting PR state', async () => {
    const { calls, options } = fixture();
    expect(await mergeVersionPullRequest(options)).toEqual({ status: 'merged', pr: 42 });
    expect(calls).toContain(`merge:42:${sha}`);
    expect(calls.at(-1)).toBe('pr:42');
  });

  it.each([
    [check('Test'), check('optional scan', 'failure')],
    [check('Test', 'skipped')],
    [check('Test'), check('classic status', 'error')],
    [check('Test'), check('workflow: audit (pull_request)', 'action_required')],
    [check('Test'), check('optional scan', 'neutral')],
  ])('refuses unsuccessful CI, including optional checks: %j', async (...checks) => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => ok({ headSha: sha, checks });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/concluded/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it.each([
    { checks: [check('Broken', 'failure')] },
  ])('rejects a settled failed check even when required evidence is missing: $checks', async ({ checks }) => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => ok({ headSha: sha, checks });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow("CI check 'Broken' concluded failure.");
    expect(options.now()).toBe(0);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it.each(['neutral', 'failure'].flatMap((conclusion) => [
    { conclusion, reversed: false }, { conclusion, reversed: true },
  ]))('waits for mixed CI to settle before merging: $conclusion, reversed=$reversed', async ({ conclusion, reversed }) => {
    const { provider, calls, options } = fixture();
    let polls = 0;
    provider.getPrChecks = async () => {
      const checks = ++polls === 1
        ? [check('Test', null, 'in_progress'), check('CodeQL', conclusion)]
        : [check('Test'), check('CodeQL')];
      return ok({ headSha: sha, checks: reversed ? checks.reverse() : checks });
    };
    expect(await mergeVersionPullRequest(options)).toEqual({ status: 'merged', pr: 42 });
    expect(polls).toBe(2);
    expect(options.now()).toBe(10);
    expect(calls.filter((call) => call.startsWith('merge:'))).toEqual([`merge:42:${sha}`]);
  });

  it.each(['neutral', 'failure'])('rejects a non-success result that remains after CI settles: %s', async (conclusion) => {
    const { provider, calls, options } = fixture();
    let polls = 0;
    provider.getPrChecks = async () => ok({ headSha: sha, checks: [
      ++polls === 1 ? check('Test', null, 'queued') : check('Test'), check('CodeQL', conclusion),
    ] });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(`CI check 'CodeQL' concluded ${conclusion}.`);
    expect(polls).toBe(2);
    expect(options.now()).toBe(10);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('waits for all CI to finish before merging the same head', async () => {
    const { provider, calls, options } = fixture();
    let polls = 0;
    provider.getPrChecks = async () => ok({ headSha: sha, checks: [check('Test', ++polls === 1 ? null : 'success', polls === 1 ? 'in_progress' : 'completed')] });
    expect(await mergeVersionPullRequest(options)).toEqual({ status: 'merged', pr: 42 });
    expect(polls).toBe(2);
    expect(options.now()).toBe(10);
    expect(calls.filter((call) => call.startsWith('merge:'))).toEqual([`merge:42:${sha}`]);
  });

  it('waits through the acceptance job window with the default release budget', async () => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => ok({ headSha: sha, checks: [
      options.now() < 30 * 60_000 ? check('Test', null, 'in_progress') : check('Test'),
    ] });
    expect(await mergeVersionPullRequest({ ...options, timeoutMs: undefined, pollIntervalMs: 60_000 }))
      .toEqual({ status: 'merged', pr: 42 });
    expect(options.now()).toBe(30 * 60_000);
    expect(calls.filter((call) => call.startsWith('merge:'))).toEqual([`merge:42:${sha}`]);
  });

  it.each([[], [check('Optional')], [check('Test', null, 'queued')], [check('Test', null, 'queued'), check('CodeQL', 'neutral')]].map((checks) => ({ checks })))('times out while required evidence is incomplete: $checks', async ({ checks }) => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => ok({ headSha: sha, checks });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/Timed out/);
    expect(options.now()).toBe(20);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it.each<Partial<PrFact>>([
    { headSha: 'c'.repeat(40) }, { headBranch: 'feature/wrong' },
    { baseBranch: 'develop' }, { number: 43 }, { draft: true }, { state: 'closed' },
  ])('refuses a version PR identity that differs from the generated proposal: %j', async (change) => {
    const { provider, calls, options } = fixture();
    provider.getPr = async () => ok({ ...pr, ...change });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/identity|closed/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('rejects CI for a different PR head', async () => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => ok({ headSha: 'd'.repeat(40), checks: [check('Test')] });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/different.*head/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('rechecks the PR identity immediately before the conditional merge', async () => {
    const { provider, calls, options } = fixture();
    let reads = 0;
    provider.getPr = async () => ok({ ...pr, headSha: ++reads === 1 ? sha : 'd'.repeat(40) });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/identity/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('refuses a changed head while waiting for CI to settle', async () => {
    const { provider, calls, options } = fixture();
    let reads = 0;
    provider.getPr = async () => ok({ ...pr, headSha: ++reads === 1 ? sha : 'd'.repeat(40) });
    provider.getPrChecks = async () => ok({ headSha: sha, checks: [check('Test', null, 'queued'), check('CodeQL', 'neutral')] });
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/identity/);
    expect(options.now()).toBe(10);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('rejects a non-full expected SHA before any platform call', async () => {
    const { calls, options } = fixture();
    await expect(mergeVersionPullRequest({ ...options, expectedHeadSha: 'abc1234' })).rejects.toThrow(/full.*SHA/);
    expect(calls).toEqual([]);
  });

  it('fails closed on unavailable checks', async () => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => fail('gh_transport', 'Disconnected');
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/gh_transport/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('refuses an ambiguous open version PR list', async () => {
    const { provider, calls, options } = fixture();
    provider.listOpenPrsByHead = async () => ok([42, 43].map((number) => ({ number, title: 'release', url: '' })));
    await expect(mergeVersionPullRequest(options)).rejects.toThrow(/exactly one/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  it('requires a positive server merge response and subsequent merged evidence', async () => {
    const first = fixture();
    first.provider.mergePr = async () => ok({ merged: false });
    await expect(mergeVersionPullRequest(first.options)).rejects.toThrow(/did not merge/);
    const second = fixture();
    second.provider.mergePr = async () => ok({ merged: true });
    await expect(mergeVersionPullRequest(second.options)).rejects.toThrow(/did not confirm/);
  });

  it('never merges from a completely skipped CI result', async () => {
    const { provider, calls, options } = fixture();
    provider.getPrChecks = async () => ok({ headSha: sha, checks: [check('Optional', 'skipped')] });
    await expect(mergeVersionPullRequest({ ...options, policy: { ...enabled, required_checks: [] } })).rejects.toThrow(/Timed out/);
    expect(calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

});


describe('version merge workflow entry point', () => {
  it.each([undefined, 'version: 1\nrequired_checks: []\nautomation:\n  merge: false\n  close_issues: false\n'])('reads workspace policy and reports disabled without requiring git or forge access', async (policy) => {
    const root = await mkdtemp(join(tmpdir(), 'specgit-release-disabled-'));
    try {
      if (policy !== undefined) {
        await mkdir(join(root, 'spec_git'));
        await writeFile(join(root, 'spec_git', 'policy.yaml'), policy);
      }
      const output = execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/merge-version-pr.mjs', import.meta.url))], { cwd: root, encoding: 'utf8' });
      expect(output).toMatch(/automatic merge is disabled/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
