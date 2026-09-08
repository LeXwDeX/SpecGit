import { describe, expect, it, vi } from 'vitest';
import { readRepairLog, recordRepairIntent, recordRepairCreation } from '../../src/automation/repair-log.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { makeGhProvider } from '../specgit-cli/helpers.js';

const repo = { platform: 'github' as const, owner: 'owner', repo: 'repo' };
const intent = {
  request: 42, headSha: 'a'.repeat(40), policyHash: 'b'.repeat(64),
  cause: { code: 'checks_failed', target: 'github:workflow:CI' },
  title: 'fix: repair CI', body: 'Repair the failed CI check.', labels: ['kind::fix'],
};

describe('repair write-ahead log', () => {
  it('retains a confirmed intent without a created receipt after a fresh read', async () => {
    const forge = makeGhProvider();
    const recorded = await recordRepairIntent(repo, intent, forge);
    expect(recorded.ok).toBe(true);
    const recovered = await readRepairLog(repo, 42, forge);
    expect(recovered).toMatchObject({ ok: true, value: [intent] });
    if (!recovered.ok) throw new Error(recovered.message);
    expect(recovered.value[0].issue).toBeUndefined();
  });

  it('reconciles repeated intent and creation writes without duplicate operations', async () => {
    const forge = makeGhProvider();
    const first = await recordRepairIntent(repo, intent, forge);
    if (!first.ok) throw new Error(first.message);
    await recordRepairIntent(repo, intent, forge);
    expect(await recordRepairCreation(repo, 42, first.value.key, 200, forge)).toMatchObject({ ok: true });
    await recordRepairCreation(repo, 42, first.value.key, 200, forge);
    expect(await readRepairLog(repo, 42, forge)).toMatchObject({ ok: true, value: [{ key: first.value.key, issue: 200 }] });
  });

  it('rejects conflicting creation receipts instead of selecting an issue to close', async () => {
    const forge = makeGhProvider();
    const first = await recordRepairIntent(repo, intent, forge);
    if (!first.ok) throw new Error(first.message);
    await recordRepairCreation(repo, 42, first.value.key, 200, forge);
    expect(await recordRepairCreation(repo, 42, first.value.key, 201, forge)).toMatchObject({ ok: false, code: 'repair_log_conflict' });
  });

  it('does not return an empty log when trusted declarations are unavailable or malformed', async () => {
    const forge = makeGhProvider();
    vi.mocked(forge.getRequestDeclarations).mockResolvedValueOnce(fail('gh_transport', 'unavailable'));
    expect(await readRepairLog(repo, 42, forge)).toMatchObject({ ok: false, code: 'gh_transport' });
    vi.mocked(forge.getRequestDeclarations).mockResolvedValueOnce(ok([{ id: '1', body: 'bad protocol payload' }]));
    expect(await readRepairLog(repo, 42, forge)).toMatchObject({ ok: false, code: 'repair_log_invalid' });
  });
});
