import { describe, expect, it } from 'vitest';
import { GhCliGitHubProvider, type SpawnFn } from '../../src/providers/github/gh-cli.js';

const repo = { owner: 'acme', repo: 'app', platform: 'github' } as const;
const sha = 'a'.repeat(40);
const pr = { number: 7, state: 'open', draft: false, head: { ref: 'feature', sha }, base: { ref: 'main' } };

function setup(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const payloads: Record<string, unknown> = {
    'pulls/7': pr,
    'check-runs': { check_runs: [{ name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'success', id: 2, started_at: null }] },
    'statuses': [],
    'actions/runs': { workflow_runs: [] },
    'pulls/7/merge': { merged: true },
    'issues/3': { number: 3, state: 'closed' },
    ...overrides,
  };
  const spawn: SpawnFn = async (_cmd, args, options) => {
    calls.push(args.join(' '));
    if (options?.stdin) bodies.push(String(options.stdin));
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
    const key = Object.keys(payloads).sort((a, b) => b.length - a.length).find((part) => endpoint.includes(part));
    const raw = key ? payloads[key] : undefined;
    if (raw instanceof Error) throw raw;
    const data: unknown = typeof raw === 'function' ? raw() : raw;
    if (data === undefined) throw new Error(`Unhandled fixture endpoint: ${endpoint}`);
    return { stdout: JSON.stringify(data), stderr: '' };
  };
  return { provider: new GhCliGitHubProvider({ spawnImpl: spawn }), calls, bodies };
}

describe('GitHub guarded delivery operations', () => {
  it('includes the newest classic status even when checks are green', async () => {
    const { provider } = setup({ statuses: [
      { id: 1, context: 'external deploy', state: 'success', created_at: '2026-09-01T00:00:00Z' },
      { id: 2, context: 'external deploy', state: 'pending', created_at: '2026-09-02T00:00:00Z' },
    ] });
    const result = await provider.getPrChecks(repo, 7);
    expect(result).toMatchObject({ ok: true, value: { headSha: sha, checks: [
      { name: 'test', conclusion: 'success' },
      { name: 'external deploy', status: 'in_progress', conclusion: null },
    ] } });
  });

  it('includes action_required workflow runs with no check jobs', async () => {
    const { provider } = setup({ 'actions/runs': { workflow_runs: [
      { id: 4, workflow_id: 1, name: 'CI', event: 'pull_request', head_sha: sha, status: 'completed', conclusion: 'action_required', run_started_at: '2026-09-02T00:00:00Z' },
    ] } });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: true, value: { checks: [
      { name: 'test' }, { conclusion: 'action_required' },
    ] } });
  });

  it('ignores a superseded failed workflow while preserving its current attempt', async () => {
    const old = { id: 4, workflow_id: 1, name: 'CI', event: 'pull_request', head_sha: sha, status: 'completed', conclusion: 'failure', run_started_at: null };
    const { provider } = setup({ 'actions/runs': { workflow_runs: [old, { ...old, id: 5, conclusion: 'success' }] } });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: true, value: { checks: [
      { name: 'test' }, { conclusion: 'success' },
    ] } });
  });

  it.each(['statuses', 'actions/runs', 'check-runs'])('fails closed on malformed %s evidence', async (key) => {
    const { provider } = setup({ [key]: null });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: false });
  });

  it('enforces the expected head atomically at GitHub without overriding protection', async () => {
    const { provider, calls, bodies } = setup();
    expect(await provider.mergePr(repo, 7, sha)).toEqual({ ok: true, value: { merged: true } });
    expect(calls).toContain('api -X PUT repos/acme/app/pulls/7/merge --input -');
    expect(JSON.parse(bodies[0])).toEqual({ sha, merge_method: 'merge' });
    expect(calls.join(' ')).not.toContain('--admin');
  });

  it('does not treat an unconfirmed merge as completed', async () => {
    const { provider } = setup({ 'pulls/7/merge': { merged: false } });
    expect(await provider.mergePr(repo, 7, sha)).toEqual({ ok: true, value: { merged: false } });
  });

  it('reconciles an already closed issue without another mutation', async () => {
    const { provider, calls } = setup();
    expect(await provider.closeIssue(repo, 3)).toEqual({ ok: true, value: { closed: true } });
    expect(calls).toEqual(['api repos/acme/app/issues/3']);
  });

  it('closes an open issue and waits for a confirming remote read', async () => {
    let reads = 0;
    const { provider, calls, bodies } = setup({ 'issues/3': () => ({ number: 3, state: reads++ < 2 ? 'open' : 'closed' }) });
    expect(await provider.closeIssue(repo, 3)).toEqual({ ok: true, value: { closed: true } });
    expect(calls).toEqual(['api repos/acme/app/issues/3', 'api -X PATCH repos/acme/app/issues/3 --input -', 'api repos/acme/app/issues/3']);
    expect(JSON.parse(bodies[0])).toEqual({ state: 'closed' });
  });

  it('does not report closure when the remote still says open', async () => {
    const { provider } = setup({ 'issues/3': { number: 3, state: 'open' } });
    expect(await provider.closeIssue(repo, 3)).toEqual({ ok: true, value: { closed: false } });
  });

  it('reports a server-side head race without claiming merge success', async () => {
    const { provider } = setup({ 'pulls/7/merge': new Error('HTTP 409: Head branch was modified') });
    expect(await provider.mergePr(repo, 7, sha)).toMatchObject({ ok: false, code: 'gh_transport' });
  });

  it('refuses malformed request and issue identity evidence', async () => {
    const emptyPr = setup({ 'pulls/7': null }).provider;
    await expect(emptyPr.getPrChecks(repo, 7)).resolves.toMatchObject({ ok: false });
    const emptyIssue = setup({ 'issues/3': null }).provider;
    await expect(emptyIssue.closeIssue(repo, 3)).resolves.toMatchObject({ ok: false });
    const wrongIssue = setup({ 'issues/3': { number: 4, state: 'closed' } }).provider;
    expect(await wrongIssue.closeIssue(repo, 3)).toMatchObject({ ok: false });
  });

  it('never treats a truncated classic status list as complete', async () => {
    const statuses = Array.from({ length: 100 }, (_, id) => ({ id, context: `test${id}`, state: 'success' }));
    const { provider } = setup({ statuses });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: false, code: 'evidence_truncated' });
  });

  it('does not hide a failed check behind another app with the same name', async () => {
    const { provider } = setup({ 'check-runs': { check_runs: [
      { id: 1, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', app: { id: 2 }, status: 'completed', conclusion: 'success' },
    ] } });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: true, value: { checks: [
      { conclusion: 'failure' }, { conclusion: 'success' },
    ] } });
  });

  it('selects check attempts by start time before id, consistently with acceptance', async () => {
    const { provider } = setup({ 'check-runs': { check_runs: [
      { id: 1, app: { id: 1 }, name: 'test', started_at: '2026-09-02T00:00:00Z', status: 'completed', conclusion: 'success' },
      { id: 2, app: { id: 1 }, name: 'test', started_at: '2026-09-01T00:00:00Z', status: 'completed', conclusion: 'skipped' },
    ] } });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: true, value: { checks: [
      { conclusion: 'success' },
    ] } });
  });

  it.each(['attempt', 'app'])('refuses missing %s identity instead of discarding pending evidence', async (missing) => {
    const identity = missing === 'attempt' ? { app: { id: 1 } } : { id: 2 };
    const { provider } = setup({ 'check-runs': { check_runs: [
      { ...identity, name: 'test', status: 'completed', conclusion: 'success' },
      { ...identity, name: 'test', status: 'queued', conclusion: null },
    ] } });
    expect(await provider.getPrChecks(repo, 7)).toMatchObject({ ok: false, code: 'gh_transport' });
  });
});
