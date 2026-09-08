import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHistoricalGitLabJobIdentity, REUSE_IDENTITY_AUDIENCE, type GitLabJobIdentityContext } from '../../src/providers/gitlab/job-identity.js';

// Ephemeral test keys; no real job identity or authentication credential is used.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] };
const sha = 'a'.repeat(40);
const expected: GitLabJobIdentityContext = {
  issuer: 'https://gitlab.example.com', projectId: '20', projectPath: 'group/project',
  pipelineId: '100', jobId: '200', sourceSha: sha, pipelineSource: 'push',
  configPath: '.gitlab-ci.yml', refPath: 'refs/heads/feature',
  createdAt: '2026-09-08T01:00:00.000Z', startedAt: '2026-09-08T01:00:10.000Z',
  finishedAt: '2026-09-08T01:01:00.000Z',
};
const issued = Date.parse('2026-09-08T01:00:10.000Z') / 1000;
const claims = {
  iss: expected.issuer, aud: 'urn:specgit:verification-reuse:v1',
  project_id: expected.projectId, project_path: expected.projectPath,
  job_project_id: expected.projectId, job_project_path: expected.projectPath,
  pipeline_id: expected.pipelineId, job_id: expected.jobId,
  sha, pipeline_source: 'push', ref_path: expected.refPath,
  ci_config_ref_uri: 'gitlab.example.com/group/project//.gitlab-ci.yml@refs/heads/feature',
  ci_config_sha: sha, iat: issued, nbf: issued - 5, exp: issued + 300,
};
function assertion(changes: Record<string, unknown> = {}, headerChanges: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...headerChanges })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

describe('historical GitLab job identity proof', () => {
  it('verifies a native signature and returns only the configuration identity', () => {
    expect(REUSE_IDENTITY_AUDIENCE).toBe(claims.aud);
    expect(verifyHistoricalGitLabJobIdentity(assertion(), jwks, expected)).toEqual({ ok: true, value: {
      projectId: '20', pipelineId: '100', jobId: '200', configSha: sha,
      configPath: '.gitlab-ci.yml', issuedAt: issued,
    } });
  });

  it.each([
    { iss: 'https://other.example.com' }, { aud: 'https://some-service.example.com' },
    { aud: [claims.aud, 'another-audience'] }, { project_id: '21' },
    { job_project_id: '21' }, { project_path: 'other/project' },
    { job_id: '201' }, { pipeline_id: '101' }, { sha: 'b'.repeat(40) },
    { pipeline_source: 'web' }, { ci_config_sha: null }, { ci_config_sha: 'b'.repeat(40) },
    { ci_config_ref_uri: null },
    { ci_config_ref_uri: 'gitlab.example.com/group/project//other.yml@refs/heads/feature' },
    { ref_path: 'refs/heads/main' },
  ])('rejects an authenticated but wrong identity: %j', (change) => {
    expect(verifyHistoricalGitLabJobIdentity(assertion(change), jwks, expected).ok).toBe(false);
  });

  it.each([{ alg: 'none' }, { alg: 'HS256' }, { kid: 'retired-key' }, { jku: 'https://attacker.example.com/keys' }])('rejects header key or algorithm substitution', (header) => {
    expect(verifyHistoricalGitLabJobIdentity(assertion({}, header), jwks, expected).ok).toBe(false);
  });

  it('rejects a forged signature and unavailable or ambiguous issuer keys', () => {
    const token = assertion();
    const parts = token.split('.');
    parts[2] = Buffer.alloc(256, 7).toString('base64url');
    expect(verifyHistoricalGitLabJobIdentity(parts.join('.'), jwks, expected).ok).toBe(false);
    expect(verifyHistoricalGitLabJobIdentity(token, { keys: [] }, expected).ok).toBe(false);
    expect(verifyHistoricalGitLabJobIdentity(token, { keys: [...jwks.keys, ...jwks.keys] }, expected).ok).toBe(false);
  });

  it('checks historical issuance against the native job interval, not the current wall clock', () => {
    expect(verifyHistoricalGitLabJobIdentity(assertion(), jwks, expected).ok).toBe(true);
    for (const change of [{ iat: issued + 3600 }, { iat: issued - 3600 }, { exp: issued - 1 }, { nbf: issued + 1 }, { iat: 'unknown' }]) {
      expect(verifyHistoricalGitLabJobIdentity(assertion(change), jwks, expected).ok).toBe(false);
    }
  });

  it('does not expose the assertion or private claims in errors', () => {
    const token = assertion({ user_email: 'private@example.com' });
    const result = verifyHistoricalGitLabJobIdentity(token, { keys: [] }, expected);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private@example.com');
  });
});
