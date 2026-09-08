import { describe, expect, it } from 'vitest';
import { selectVerification, type VerificationChange } from '../../src/verification/select.js';
import type { Policy } from '../../src/record/policy.js';

const policy: Policy = { version: 1, required_checks: ['security'], verification: {
  product_checks: ['build', 'test'],
  rules: [{ paths: ['README.md', 'docs/**'], checks: ['docs'] }, { paths: ['docs/api/**'], checks: ['api'] }],
} };
const binding = 'version: 1\ndelivery: work\ncontext: {kind: branch, branch: feature}\nissues: [1]\npr: 2\n';
const change = (path: string, extra: Partial<VerificationChange> = {}): VerificationChange => ({
  path, status: 'M', oldMode: '100644', newMode: '100644', ...extra,
});

describe('verification selection', () => {
  it('skips product commands only for recognized valid binding data', () => {
    const result = selectVerification(policy, [change('.specgit.yaml')], { before: binding, after: binding.replace('[1]', '[1, 3]') });
    expect(result.requiredChecks).toEqual(['security']);
    expect(result.paths).toEqual([{ path: '.specgit.yaml', kind: 'record', reason: 'recognized_binding', checks: [] }]);
  });

  it.each([binding + 'build: evil\n', binding.replace('branch: feature', 'branch: feature, script: evil'), 'invalid: ['])('does not exempt unrecognized or malformed binding data', (after) => {
    expect(selectVerification(policy, [change('.specgit.yaml')], { before: binding, after }).requiredChecks).toEqual(['security', 'build', 'test']);
  });

  it('unions every matching rule and every changed path', () => {
    expect(selectVerification(policy, [change('docs/api/x.md'), change('src/a.ts')]).requiredChecks).toEqual(['security', 'docs', 'api', 'build', 'test']);
  });

  it.each(['README.MD', 'other/file', '.github/workflows/build.yml', 'spec_git/policy.yaml', '.gitlab-ci.yml'])('uses product fallback for unmatched or critical input %s', (path) => {
    const broad: Policy = { ...policy, verification: { product_checks: ['build', 'test'], rules: [{ paths: [path], checks: [] }] } };
    const chosen = path === 'README.MD' || path === 'other/file' ? policy : broad;
    expect(selectVerification(chosen, [change(path)]).requiredChecks).toEqual(['security', 'build', 'test']);
  });

  it('retains deleted old paths and type/mode changes even under a documentation rule', () => {
    for (const entry of [change('docs/deleted.md', { status: 'D', newMode: '000000' }), change('docs/link.md', { status: 'T', newMode: '120000' }), change('docs/run.md', { newMode: '100755' }), change('docs/new.md', { status: 'A', oldMode: '000000', newMode: '100755' })]) {
      expect(selectVerification(policy, [entry]).requiredChecks).toEqual(['security', 'build', 'test']);
    }
    expect(selectVerification(policy, [change('src/a.ts', { status: 'D', newMode: '000000' }), change('README.md', { status: 'A', oldMode: '000000' })]).requiredChecks).toContain('build');
  });

  it('keeps fixed policies unchanged and distinguishes an empty product diff', () => {
    expect(selectVerification({ version: 1, required_checks: ['legacy'] }, [change('docs/a.md')]).requiredChecks).toEqual(['legacy']);
    expect(selectVerification(policy, []).requiredChecks).toEqual(['security']);
    expect(selectVerification(policy, [change('docs/a.md')]).requiredChecks).toEqual(['security', 'docs']);
  });
});
