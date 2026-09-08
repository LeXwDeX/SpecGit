import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { fail, ok, type Evidence } from '../../kernel/evidence.js';

export const REUSE_IDENTITY_AUDIENCE = 'urn:specgit:verification-reuse:v1';
const id = z.string().regex(/^[1-9][0-9]*$/).max(30);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const headerSchema = z.object({
  alg: z.literal('RS256'), typ: z.literal('JWT').optional(), kid: z.string().min(1).max(200),
}).strict();
const claimsSchema = z.object({
  iss: z.string(), aud: z.union([z.string(), z.array(z.string())]),
  project_id: id, project_path: z.string(), job_project_id: id.optional(), job_project_path: z.string().optional(),
  pipeline_id: id, job_id: id, sha, pipeline_source: z.string(), ref_path: z.string(),
  ci_config_ref_uri: z.string(), ci_config_sha: sha,
  iat: z.number().int().positive(), nbf: z.number().int().positive(), exp: z.number().int().positive(),
});
const keysSchema = z.object({ keys: z.array(z.object({
  kty: z.literal('RSA'), kid: z.string(), use: z.literal('sig').optional(), alg: z.literal('RS256').optional(),
  n: z.string().regex(/^[A-Za-z0-9_-]+$/).max(2048), e: z.string().regex(/^[A-Za-z0-9_-]+$/).max(20),
})).max(16) });

export interface GitLabJobIdentityContext {
  issuer: string;
  projectId: string;
  projectPath: string;
  pipelineId: string;
  jobId: string;
  sourceSha: string;
  pipelineSource: string;
  configPath: string;
  refPath: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

export interface GitLabConfigurationIdentity {
  projectId: string;
  pipelineId: string;
  jobId: string;
  configSha: string;
  configPath: string;
  issuedAt: number;
}

/**
 * Verify a historical signed job statement, never current authentication.
 * The caller obtains keys from the approved issuer and job facts through glab;
 * neither assertion-supplied keys nor assertion-supplied URLs are followed.
 * Raw assertions and other personal claims never appear in the return value.
 * Native success, the approved recipe and original execution age remain separate gates.
 */
export function verifyHistoricalGitLabJobIdentity(
  assertion: string,
  issuerKeys: unknown,
  expected: GitLabJobIdentityContext,
): Evidence<GitLabConfigurationIdentity> {
  const unavailable = () => fail<GitLabConfigurationIdentity>('gitlab_job_identity_unproven',
    'The original GitLab job configuration identity could not be verified.',
    'Run the applicable verification commands; missing historical identity cannot grant reuse.');
  try {
    if (assertion.length > 65536) return unavailable();
    const parts = assertion.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return unavailable();
    const header = headerSchema.safeParse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    const keys = keysSchema.safeParse(issuerKeys);
    if (!header.success || !keys.success) return unavailable();
    const matches = keys.data.keys.filter((key) => key.kid === header.data.kid);
    if (matches.length !== 1) return unavailable();
    const key = createPublicKey({ key: matches[0], format: 'jwk' });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return unavailable();
    const decoded = claimsSchema.safeParse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    if (!decoded.success) return unavailable();
    const claims = decoded.data;
    const issuer = new URL(expected.issuer);
    if (issuer.protocol !== 'https:' || issuer.origin !== expected.issuer) return unavailable();
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    const configUri = `${issuer.host}/${expected.projectPath}//${expected.configPath}@${expected.refPath}`;
    if (claims.iss !== expected.issuer || audiences.length !== 1 || audiences[0] !== REUSE_IDENTITY_AUDIENCE ||
        claims.project_id !== expected.projectId || claims.project_path !== expected.projectPath ||
        (claims.job_project_id !== undefined && claims.job_project_id !== expected.projectId) ||
        (claims.job_project_path !== undefined && claims.job_project_path !== expected.projectPath) ||
        claims.job_id !== expected.jobId || claims.pipeline_id !== expected.pipelineId ||
        claims.sha !== expected.sourceSha || claims.pipeline_source !== expected.pipelineSource ||
        claims.ref_path !== expected.refPath || claims.ci_config_ref_uri !== configUri ||
        claims.ci_config_sha !== expected.sourceSha) return unavailable();
    const created = Date.parse(expected.createdAt) / 1000;
    const started = Date.parse(expected.startedAt) / 1000;
    const finished = Date.parse(expected.finishedAt) / 1000;
    if (![created, started, finished].every(Number.isFinite) || created > started || started > finished ||
        claims.iat < created - 30 || claims.iat > finished + 30 || Math.abs(claims.iat - started) > 60 ||
        claims.nbf > claims.iat || claims.nbf < claims.iat - 60 || claims.exp <= claims.iat || claims.exp - claims.iat > 3600) return unavailable();
    return ok({ projectId: claims.project_id, pipelineId: claims.pipeline_id, jobId: claims.job_id,
      configSha: claims.ci_config_sha, configPath: expected.configPath, issuedAt: claims.iat });
  } catch { return unavailable(); }
}
