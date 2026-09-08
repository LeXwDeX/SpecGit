/**
 * #220 — direct unit tests for the init submodules split out in #171.
 *
 * `init-platform.ts` and `init-validation.ts` advertise themselves as
 * individually testable modules; these tests import them directly (no
 * CLI-level init.test.ts round-trip) and pin their decision logic: the
 * endpoint/port classification that drives platform resolution, and the
 * required-check / language / policy validation that runs before any
 * mutation.
 */

import { describe, expect, it } from 'vitest';
import {
  DECLARED_ENDPOINT,
  declaredEndpointName,
  endpointEffectivePort,
  endpointUsesDefaultPort,
  originEndpoint,
  validateGitlabHost,
} from '../../src/cli/commands/init-platform.js';
import {
  ambiguousJobWarning,
  preservedChecksWarning,
  resolveRequiredChecks,
  nonPrWorkflowWarning,
  policyGateOutcome,
  resolveInitLanguage,
  validateLanguageOption,
} from '../../src/cli/commands/init-validation.js';
import { EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { ok, fail } from '../../src/kernel/evidence.js';
import type { DetectionReport } from '../../src/cli/detect-checks.js';
import type { Policy } from '../../src/cli/types.js';
import { makeCtx, makeGitFacts, samplePolicy } from './helpers.js';

describe('init-platform: endpoint and port judgment (#220)', () => {
  it('classifies the accepted origin URL shapes', () => {
    expect(originEndpoint('https://github.com/LeXwDeX/SpecGit.git')).toEqual({
      host: 'github.com',
      port: null,
      defaultPort: '443',
    });
    expect(originEndpoint('git@github.com:LeXwDeX/SpecGit.git')).toEqual({
      host: 'github.com',
      port: null,
      defaultPort: '22',
    });
    expect(originEndpoint('ssh://git@git.example.com:2222/team/repo.git')).toEqual({
      host: 'git.example.com',
      port: '2222',
      defaultPort: '22',
    });
    expect(originEndpoint('https://git.example.com:8443/team/repo.git')).toEqual({
      host: 'git.example.com',
      port: '8443',
      defaultPort: '443',
    });
  });

  it('rejects shapes the classification never accepts', () => {
    expect(originEndpoint('ftp://git.example.com/team/repo.git')).toBeNull();
    expect(originEndpoint('')).toBeNull();
  });

  it('answers the effective-port question from explicit digits or the scheme default', () => {
    expect(endpointEffectivePort({ host: 'h', port: '8443', defaultPort: '443' })).toBe('8443');
    expect(endpointEffectivePort({ host: 'h', port: null, defaultPort: '443' })).toBe('443');
    expect(endpointEffectivePort({ host: 'h', port: null, defaultPort: '22' })).toBe('22');
  });

  it('treats the scheme default port as the portless equivalent', () => {
    expect(endpointUsesDefaultPort({ host: 'h', port: null, defaultPort: '443' })).toBe(true);
    expect(endpointUsesDefaultPort({ host: 'h', port: '443', defaultPort: '443' })).toBe(true);
    expect(endpointUsesDefaultPort({ host: 'h', port: '8443', defaultPort: '443' })).toBe(false);
    expect(endpointUsesDefaultPort({ host: 'h', port: '2222', defaultPort: '22' })).toBe(false);
  });

  it('parses the host(:port) declaration grammar', () => {
    expect(DECLARED_ENDPOINT.exec('git.ycgame.com')?.[1]).toBe('git.ycgame.com');
    expect(DECLARED_ENDPOINT.exec('git.ycgame.com')?.[2]).toBeUndefined();
    const ported = DECLARED_ENDPOINT.exec('git.ycgame.com:8443');
    expect(ported?.[1]).toBe('git.ycgame.com');
    expect(ported?.[2]).toBe('8443');
    expect(DECLARED_ENDPOINT.exec('https://git.example.com')).toBeNull();
  });

  it('renders the declaration name for envelopes and human output', () => {
    expect(declaredEndpointName('git.example.com', null)).toBe('git.example.com');
    expect(declaredEndpointName('git.example.com', '8443')).toBe('git.example.com:8443');
  });

  it('refuses a GitLab declaration against a github.com origin', async () => {
    const t = makeCtx();
    const outcome = await validateGitlabHost({ gitlabHost: 'git.example.com' }, t.ctx, '/repo');
    expect('exit' in outcome).toBe(true);
    if ('exit' in outcome) {
      expect(outcome.exit).toBe(EXIT_USAGE);
      expect(outcome.errors?.[0]?.code).toBe('gitlab_host_invalid');
      expect(outcome.errors?.[0]?.message).toContain('already a github.com repository');
    }
  });

  it('refuses malformed declarations before any write', async () => {
    const t = makeCtx({ facts: makeGitFacts({ originUrl: 'https://git.example.com/team/repo.git' }) });
    const outcome = await validateGitlabHost({ gitlabHost: 'https://git.example.com' }, t.ctx, '/repo');
    expect('exit' in outcome).toBe(true);
    if ('exit' in outcome) {
      expect(outcome.exit).toBe(EXIT_USAGE);
      expect(outcome.errors?.[0]?.code).toBe('gitlab_host_invalid');
    }
  });

  it('accepts the declaration that matches the origin endpoint', async () => {
    const t = makeCtx({ facts: makeGitFacts({ originUrl: 'https://git.example.com/team/repo.git' }) });
    const outcome = await validateGitlabHost({ gitlabHost: 'git.example.com' }, t.ctx, '/repo');
    expect(outcome).toEqual({ host: 'git.example.com', port: null });
  });

  it('requires the declared port to be the port the origin actually uses', async () => {
    const facts = makeGitFacts({ originUrl: 'ssh://git@git.example.com:2222/team/repo.git' });
    const matching = await validateGitlabHost(
      { gitlabHost: 'git.example.com:2222' },
      makeCtx({ facts }).ctx,
      '/repo'
    );
    expect(matching).toEqual({ host: 'git.example.com', port: '2222' });

    const portless = await validateGitlabHost(
      { gitlabHost: 'git.example.com' },
      makeCtx({ facts }).ctx,
      '/repo'
    );
    expect('exit' in portless).toBe(true);
    if ('exit' in portless) {
      expect(portless.exit).toBe(EXIT_USAGE);
      expect(portless.errors?.[0]?.message).toContain('does not match the origin endpoint');
    }
  });

  it('accepts any well-formed declaration when the origin is unknown', async () => {
    const t = makeCtx({ facts: makeGitFacts({ originUrl: null }) });
    const outcome = await validateGitlabHost({ gitlabHost: 'git.example.com:8443' }, t.ctx, '/repo');
    expect(outcome).toEqual({ host: 'git.example.com', port: '8443' });
  });
});

describe('init-validation: check selection provenance and pre-mutation gates (#220, #310)', () => {
  const noPolicy = fail<Policy>('policy_missing', 'No policy found at spec_git/policy.yaml.');

  it('trims explicit check names and skips detection', async () => {
    const t = makeCtx();
    const resolution = await resolveRequiredChecks(
      { requiredCheck: [' build ', 'test'] },
      t.ctx,
      '/repo',
      noPolicy
    );
    expect('exit' in resolution).toBe(false);
    if (!('exit' in resolution)) {
      expect(resolution.checks).toEqual(['build', 'test']);
      expect(resolution.detected).toBeNull();
      expect(resolution.provenance).toBe('explicit');
    }
  });

  it('rejects empty check names as usage errors', async () => {
    const t = makeCtx();
    const outcome = await resolveRequiredChecks(
      { requiredCheck: ['valid', ' '] },
      t.ctx,
      '/repo',
      noPolicy
    );
    expect('exit' in outcome).toBe(true);
    if ('exit' in outcome) {
      expect(outcome.exit).toBe(EXIT_USAGE);
      expect(outcome.errors?.[0]?.code).toBe('required_check_invalid');
    }
  });

  it('keeps the strict --no-detect path explicit-or-refused without a policy', async () => {
    const t = makeCtx();
    const outcome = await resolveRequiredChecks({ detect: false }, t.ctx, '/repo', noPolicy);
    expect('exit' in outcome).toBe(true);
    if ('exit' in outcome) {
      expect(outcome.exit).toBe(EXIT_USAGE);
      expect(outcome.errors?.[0]?.code).toBe('required_check_required');
    }
  });

  it('preserves an existing policy exactly — order and emptiness included (#310)', async () => {
    const t = makeCtx();
    const ordered = await resolveRequiredChecks(
      {},
      t.ctx,
      '/repo',
      ok(samplePolicy({ required_checks: ['Second', 'First'] }))
    );
    expect('exit' in ordered).toBe(false);
    if (!('exit' in ordered)) {
      expect(ordered.checks).toEqual(['Second', 'First']);
      expect(ordered.detected).toBeNull();
      expect(ordered.provenance).toBe('existing');
    }
    // A no-CI policy (zero checks, #63) upgrades as a no-CI policy too.
    const noCi = await resolveRequiredChecks(
      {},
      t.ctx,
      '/repo',
      ok(samplePolicy({ required_checks: [] }))
    );
    expect('exit' in noCi).toBe(false);
    if (!('exit' in noCi)) {
      expect(noCi.checks).toEqual([]);
      expect(noCi.provenance).toBe('existing');
    }
  });

  it('explicit checks win over an existing policy — the intentional replacement path (#310)', async () => {
    const t = makeCtx();
    const resolution = await resolveRequiredChecks(
      { requiredCheck: ['New'] },
      t.ctx,
      '/repo',
      ok(samplePolicy({ required_checks: ['Old'] }))
    );
    expect('exit' in resolution).toBe(false);
    if (!('exit' in resolution)) {
      expect(resolution.checks).toEqual(['New']);
      expect(resolution.provenance).toBe('explicit');
    }
  });

  it('validates --language before any mutation', () => {
    expect(validateLanguageOption({})).toBeNull();
    expect(validateLanguageOption({ language: 'zh' })).toBeNull();
    const invalid = validateLanguageOption({ language: 'fr' });
    expect(invalid?.exit).toBe(EXIT_USAGE);
    expect(invalid?.errors?.[0]?.code).toBe('language_invalid');
  });

  it('gates the policy write on existence unless --force', () => {
    const existing = ok(samplePolicy());
    const refused = policyGateOutcome(existing, {});
    expect(refused?.exit).toBe(EXIT_USAGE);
    expect(refused?.errors?.[0]?.code).toBe('policy_exists');
    expect(policyGateOutcome(existing, { force: true })).toBeNull();

    const missing = fail<Policy>('policy_missing', 'No policy found.');
    expect(policyGateOutcome(missing, {})).toBeNull();

    const invalid = fail<Policy>('policy_invalid', 'spec_git/policy.yaml is invalid.');
    expect(policyGateOutcome(invalid, {})?.exit).toBe(EXIT_UNKNOWN);
  });

  it('resolves the effective language: explicit wins, force inherits, default en', () => {
    expect(resolveInitLanguage({ language: 'zh' }, undefined)).toBe('zh');
    expect(resolveInitLanguage({}, 'zh')).toBe('zh');
    expect(resolveInitLanguage({}, undefined)).toBe('en');
    expect(resolveInitLanguage({ language: 'fr' }, 'zh')).toBe('zh');
  });

  it('warns exactly when non-PR workflows were excluded from detection', () => {
    const base: DetectionReport = {
      platform: 'github',
      requiredChecks: ['Test'],
      sources: ['.github/workflows/ci.yml'],
      nonPrWorkflows: [],
      ambiguousJobs: [],
      clis: { gh: true, glab: false },
    };
    expect(nonPrWorkflowWarning(base)).toBeNull();
    const warning = nonPrWorkflowWarning({ ...base, nonPrWorkflows: ['release.yml'] });
    expect(warning?.code).toBe('checks_not_pr_visible');
    expect(warning?.message).toContain('release.yml');
  });

  it('warns exactly when detection could not prove a check-run name (#310)', () => {
    const base: DetectionReport = {
      platform: 'github',
      requiredChecks: ['Test'],
      sources: ['.github/workflows/ci.yml'],
      nonPrWorkflows: [],
      ambiguousJobs: [],
      clis: { gh: true, glab: false },
    };
    expect(ambiguousJobWarning(base)).toBeNull();
    const warning = ambiguousJobWarning({
      ...base,
      ambiguousJobs: ['.github/workflows/ci.yml: test_matrix'],
    });
    expect(warning?.code).toBe('checks_name_ambiguous');
    expect(warning?.message).toContain('test_matrix');
    expect(warning?.fix).toContain('--required-check');
  });

  it('the preserve path names the replacement path in its warning (#310)', () => {
    const warning = preservedChecksWarning();
    expect(warning.severity).toBe('warning');
    expect(warning.code).toBe('checks_preserved');
    expect(warning.fix).toContain('--required-check');
  });
});
