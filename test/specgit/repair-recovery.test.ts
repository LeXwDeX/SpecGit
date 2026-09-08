import { describe, expect, it, vi } from 'vitest';
import { recoverRepairCreations } from '../../src/automation/repair-recovery.js';
import { recordRepairIntent, readRepairLog, repairPolicyHash } from '../../src/automation/repair-log.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeGhProvider, samplePolicy } from '../specgit-cli/helpers.js';

const repo = { platform: 'github' as const, owner: 'owner', repo: 'repo' };
const headSha = 'a'.repeat(40);

describe('interrupted repair creation recovery', () => {
  it('ignores an untrusted history marker before recording a new repair receipt', async () => {
    const policy = samplePolicy({ automation: { merge: true, target_branch: 'main', close_issues: true } });
    const forge = makeGhProvider();
    const intent = await recordRepairIntent(repo, { request: 42, headSha, policyHash: repairPolicyHash(policy),
      cause: { code: 'checks_failed' }, title: 'fix: CI', body: 'Repair CI.', labels: [] }, forge);
    if (!intent.ok) throw new Error(intent.message);
    vi.mocked(forge.searchIssueHistory).mockResolvedValue(ok([{ number: 800, title: 'unrelated',
      body: `<!-- specgit:repair-operation:${intent.value.key} -->`, state: 'open', url: 'https://forge.example/issues/800' }]));
    vi.mocked(forge.getIssueWriterAuthority).mockResolvedValue(ok(false));
    vi.mocked(forge.createIssue).mockResolvedValue(ok({ number: 200, url: 'https://forge.example/issues/200' }));
    vi.mocked(forge.getIssue).mockImplementation(async (_repo, number) => ok({ number, state: 'open', pullRequest: false }));
    expect(await recoverRepairCreations({ repo, request: 42, root: '/repo', headSha, policy, boundIssues: [123] },
      forge, { isAncestor: async () => ok({ contained: true }) })).toMatchObject({ ok: true });
    expect(await readRepairLog(repo, 42, forge)).toMatchObject({ ok: true, value: [{ issue: 200 }] });
    expect(forge.createIssue).toHaveBeenCalledOnce();
  });

  it.each(['policy', 'source'] as const)('records already-created work after %s evidence changes without authorizing resolution', async (change) => {
    const policy = samplePolicy({ automation: { merge: true, target_branch: 'main', close_issues: true } });
    const forge = makeGhProvider();
    const intent = await recordRepairIntent(repo, {
      request: 42, headSha, policyHash: repairPolicyHash(policy),
      cause: { code: 'checks_failed', target: 'github:workflow:CI' },
      title: 'fix: repair CI', body: 'Repair the failure.', labels: ['kind::fix'],
    }, forge);
    if (!intent.ok) throw new Error(intent.message);
    const marker = `<!-- specgit:repair-operation:${intent.value.key} -->`;
    vi.mocked(forge.searchIssueHistory).mockResolvedValue(ok([{ number: 200, title: intent.value.title,
      body: `${marker}\n${intent.value.body}`, state: 'open', url: 'https://github.com/owner/repo/issues/200' }]));
    vi.mocked(forge.getIssue).mockResolvedValue(ok({ number: 200, pullRequest: false, state: 'open' }));
    const git = { isAncestor: vi.fn(async () => ok({ contained: change !== 'source' })) };
    const result = await recoverRepairCreations({ repo, request: 42, root: '/repo', headSha,
      policy: change === 'policy' ? { ...policy, required_checks: ['changed'] } : policy, boundIssues: [123] }, forge, git);
    expect(result.ok).toBe(true);
    expect(await readRepairLog(repo, 42, forge)).toMatchObject({ ok: true, value: [{ issue: 200 }] });
    expect(forge.createIssue).not.toHaveBeenCalled();
    expect(forge.addIssueLabels).not.toHaveBeenCalled();
  });

  it.each(['policy', 'source'] as const)('does not create missing work after %s authorization changes', async (change) => {
    const policy = samplePolicy({ automation: { merge: true, target_branch: 'main', close_issues: true } });
    const forge = makeGhProvider();
    await recordRepairIntent(repo, { request: 42, headSha, policyHash: repairPolicyHash(policy),
      cause: { code: 'checks_failed' }, title: 'fix: repair CI', body: 'Repair failure.', labels: [] }, forge);
    const result = await recoverRepairCreations({ repo, request: 42, root: '/repo', headSha,
      policy: change === 'policy' ? { ...policy, required_checks: ['changed'] } : policy, boundIssues: [123] },
    forge, { isAncestor: async () => ok({ contained: change !== 'source' }) });
    expect(result).toMatchObject({ ok: false, code: 'repair_resolution_unproven' });
    expect(forge.createIssue).not.toHaveBeenCalled();
    const log = await readRepairLog(repo, 42, forge);
    if (!log.ok) throw new Error(log.message);
    expect(log.value).toHaveLength(1);
    expect(log.value[0].issue).toBeUndefined();
  });
});
