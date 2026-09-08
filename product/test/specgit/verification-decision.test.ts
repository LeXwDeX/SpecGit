import { describe, expect, it, vi } from 'vitest';
import { resolveVerification } from '../../src/verification/resolve.js';
import { ok, fail } from '../../src/kernel/evidence.js';
import { makePrFact } from './helpers/mock-forge.js';
import type { Policy } from '../../src/record/policy.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40), ancestor = 'c'.repeat(40);
const policy: Policy = { version: 1, required_checks: [], verification: { product_checks: ['build'], rules: [] } };
const binding = 'version: 1\ndelivery: work\ncontext: {kind: branch, branch: feature}\nissues: [1]\npr: 2\n';
function fixture() {
  return { root: '/repo', policy, policySha: base, repo: { owner: 'owner', repo: 'repo', platform: 'github' as const },
    forge: { getCiConfigPath: vi.fn(async () => ok<string | null>(null)) }, request: makePrFact({ headSha: head }), git: {
    changesBetween: vi.fn(async () => ok({ baseSha: base, headSha: head, mergeBaseSha: ancestor, changes: [{ path: '.specgit.yaml', status: 'M' as const, oldMode: '100644', newMode: '100644' }] })),
    readFileAtCommit: vi.fn(async (_root: string, sha: string) => ok({ sha, content: binding })),
  } };
}
describe('immutable verification decision', () => {
  it('pins policy and both commit identities and proves binding bytes', async () => {
    const f = fixture();
    expect(await resolveVerification(f)).toMatchObject({ ok: true, value: {
      kind: 'applicable', policySha: base, baseSha: base, mergeBaseSha: ancestor, headSha: head, requiredChecks: [],
      paths: [{ kind: 'record' }],
    } });
    expect(f.git.readFileAtCommit.mock.calls.map((call) => call[1])).toEqual([ancestor, head]);
  });
  it('rejects a change-set identity mismatch and a missing approved revision', async () => {
    const f = fixture();
    expect(await resolveVerification({ ...f, policySha: undefined })).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
    f.git.changesBetween.mockResolvedValue(ok({ baseSha: head, headSha: head, mergeBaseSha: ancestor, changes: [] }));
    expect(await resolveVerification(f)).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
  });
  it('preserves unavailable evidence and does not invent an empty diff', async () => {
    const f = fixture();
    const missing = { changesBetween: vi.fn(async () => fail<never>('verification_changes_unavailable', 'history missing')), readFileAtCommit: f.git.readFileAtCommit };
    expect(await resolveVerification({ ...f, git: missing })).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
    expect(f.git.readFileAtCommit).not.toHaveBeenCalled();
  });
  it('protects an approved custom GitLab entry and rejects changed or unavailable settings', async () => {
    const f = fixture();
    const configured = { ...f, repo: { ...f.repo, platform: 'gitlab' as const }, policy: {
      ...policy, verification: { product_checks: ['build'], gitlab_entry: 'ci/custom.config',
        rules: [{ paths: ['ci/**'], checks: [] }] },
    } };
    f.git.changesBetween.mockResolvedValue(ok({ baseSha: base, headSha: head, mergeBaseSha: ancestor,
      changes: [{ path: 'ci/custom.config', status: 'M', oldMode: '100644', newMode: '100644' }] }));
    expect(await resolveVerification(configured)).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
    f.forge.getCiConfigPath.mockResolvedValue(ok('ci/custom.config'));
    expect(await resolveVerification(configured)).toMatchObject({ ok: true, value: { requiredChecks: ['build'], ciEntry: 'ci/custom.config' } });
    f.forge.getCiConfigPath.mockResolvedValue(fail('glab_transport', 'unavailable'));
    expect(await resolveVerification(configured)).toMatchObject({ ok: false, code: 'glab_transport' });
    f.forge.getCiConfigPath.mockClear();
    expect(await resolveVerification({ ...configured, request: { ...f.request, state: 'merged' } })).toMatchObject({ ok: true, value: { requiredChecks: ['build'] } });
    expect(f.forge.getCiConfigPath).not.toHaveBeenCalled();
  });

  it('does not demand change evidence from existing fixed-check projects', async () => {
    const f = fixture();
    expect(await resolveVerification({ ...f, policy: { version: 1, required_checks: ['old'] }, policySha: undefined })).toMatchObject({ ok: true, value: { kind: 'fixed', requiredChecks: ['old'] } });
    expect(f.git.changesBetween).not.toHaveBeenCalled();
  });
});
