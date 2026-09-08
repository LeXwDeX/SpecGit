import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ok, fail, type Evidence } from '../../src/kernel/evidence.js';
import { GitLabReuseExecutions } from '../../src/providers/gitlab/reuse.js';
import { originalJobName } from '../../src/verification/reuse-producer.js';

const sourceSha = 'a'.repeat(40);
const inputDigest = 'b'.repeat(64);
const repository = 'gitlab.example.com/group/project';
const ref = { repository, run: '101', attempt: 1, job: '201' };
const entry = '.gitlab-ci.yml';
const producer = { profile: 'linux', entry, files: [{ path: entry, sha256: createHash('sha256').update('approved').digest('hex') }] };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' }] };
const iat = Date.parse('2026-09-08T00:00:10Z') / 1000;
const pipeline = { id: 100, project_id: 20, sha: sourceSha, source: 'push', status: 'success', ref: 'feature' };
const child = { ...pipeline, id: 101, source: 'parent_pipeline' };
const prepare = { id: 200, name: 'SpecGit prepare / linux', pipeline, commit: { id: sourceSha }, status: 'success', ref: 'feature',
  created_at: '2026-09-08T00:00:00Z', started_at: '2026-09-08T00:00:10Z', finished_at: '2026-09-08T00:01:00Z', erased_at: null };
const job = { ...prepare, id: 201, name: originalJobName('linux', inputDigest), pipeline: child,
  created_at: '2026-09-08T00:01:00Z', started_at: '2026-09-08T00:01:10Z', finished_at: '2026-09-08T00:02:00Z' };
function statement(changes: object = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: 'https://gitlab.example.com', aud: 'urn:specgit:verification-reuse:v1',
    project_id: '20', project_path: 'group/project', pipeline_id: '100', job_id: '200',
    sha: sourceSha, pipeline_source: 'push', ref_path: 'refs/heads/feature',
    ci_config_ref_uri: 'gitlab.example.com/group/project//.gitlab-ci.yml@refs/heads/feature', ci_config_sha: sourceSha,
    iat, nbf: iat - 5, exp: iat + 300, ...changes,
  })).toString('base64url');
  return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}

function fixture(change: { child?: object; job?: object; prepare?: object; bridge?: object; claims?: object;
  jobTokenOnly?: boolean; parent?: object; content?: string; missing?: string; keys?: unknown; hint?: object } = {}) {
  const paths: string[] = [];
  const api = async (endpoint: string): Promise<Evidence<unknown>> => {
    paths.push(endpoint);
    if (change.jobTokenOnly && (/^projects\/[^/]+$/.test(endpoint) || /\/jobs\/[0-9]+$/.test(endpoint))) return fail('unauthorized', 'Endpoint unavailable to job tokens');
    if (change.missing && endpoint.includes(change.missing)) return fail('not_found', 'Missing');
    if (endpoint.startsWith('https://')) return ok(change.keys ?? jwks);
    if (endpoint.includes('/repository/files/') && endpoint.includes('/raw?')) return ok(change.content ?? 'approved');
    if (change.jobTokenOnly && endpoint.includes('/repository/files/')) return fail('unauthorized', 'Metadata endpoint unavailable');
    if (endpoint.includes('/repository/files/')) return ok({ encoding: 'base64', content: Buffer.from(change.content ?? 'approved').toString('base64') });
    if (endpoint.includes('/jobs/201/artifacts/')) return ok({ parentPipeline: '100', prepareJob: '200', ...change.hint });
    if (endpoint.includes('/jobs/200/artifacts/')) return ok({ assertion: statement(change.claims) });
    if (endpoint.includes('/jobs/201')) return ok({ ...job, ...change.job });
    if (endpoint.includes('/jobs/200')) return ok({ ...prepare, ...change.prepare });
    if (endpoint.includes('/pipelines/100/bridges')) return ok([{ id: 300, name: 'SpecGit dispatch / linux', status: 'success', downstream_pipeline: child, ...change.bridge }]);
    if (endpoint.includes('/pipelines/101/jobs')) return ok([{ ...job, ...change.job }]);
    if (endpoint.includes('/pipelines/100/jobs')) return ok([{ ...prepare, ...change.prepare }]);
    if (endpoint.endsWith('/pipelines/102')) return ok({ ...pipeline, id: 102, status: 'running' });
    if (endpoint.endsWith('/pipelines/101')) return ok({ ...child, ...change.child });
    if (endpoint.endsWith('/pipelines/100')) return ok({ ...pipeline, ...change.parent });
    if (endpoint.includes('/pipelines?')) return ok([{ ...pipeline, ...change.parent }]);
    return ok({ id: 20, path_with_namespace: 'group/project' });
  };
  return { paths, port: new GitLabReuseExecutions({ host: 'gitlab.example.com', project: 'group/project',
    producer, currentRun: '102', since: '2026-09-07T00:00:00Z', api }) };
}

describe('GitLab original execution provenance', () => {
  it('requires the native child, bridge, parent preparation and signed historical root configuration', async () => {
    const { port, paths } = fixture();
    expect(await port.candidates(repository, 'linux')).toEqual(ok([ref]));
    const result = await port.original(ref);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected original');
    expect(result.value).toMatchObject({ ref, profile: 'linux', sourceSha, inputDigest, completedAt: job.finished_at });
    expect(paths.some((value) => value.includes('/bridges?'))).toBe(true);
    expect(paths).toContain('https://gitlab.example.com/oauth/discovery/keys');
  });

  it('proves the same execution using job-token-supported native inventories and immutable raw files', async () => {
    const { port, paths } = fixture({ jobTokenOnly: true });
    expect(await port.candidates(repository, 'linux')).toEqual(ok([ref]));
    expect((await port.original(ref)).ok).toBe(true);
    expect(paths.some((entry) => /\/jobs\/[0-9]+$/.test(entry))).toBe(false);
    expect(paths.some((entry) => entry.includes('/raw?ref='))).toBe(true);
    expect(paths.some((entry) => entry.includes('&ref=feature'))).toBe(true);
  });

  it.each([
    { child: { source: 'push' } }, { child: { project_id: 99 } },
    { child: { sha: 'c'.repeat(40) } }, { job: { status: 'failed' } },
    { job: { erased_at: '2026-09-08T01:00:00Z' } },
    { prepare: { status: 'failed' } }, { prepare: { name: 'unrelated preparation' } },
    { bridge: { downstream_pipeline: { ...child, id: 999 } } },
    { bridge: { name: 'unrelated bridge' } },
    { claims: { ci_config_ref_uri: 'gitlab.example.com/group/project//other.yml@refs/heads/feature' } },
    { claims: { ci_config_sha: null } }, { claims: { pipeline_id: '999' } },
    { keys: { keys: [] } }, { content: 'unapproved workflow' },
    { missing: '/artifacts/' }, { hint: { parentPipeline: '../100' } },
  ])('executes again for missing, changed, erased or unrelated provenance', async (change) => {
    expect((await fixture(change).port.original(ref)).ok).toBe(false);
  });

  it('does not omit a failed original or treat a successful reuse gate as an original', async () => {
    expect(await fixture({ job: { status: 'failed' } }).port.candidates(repository, 'linux')).toEqual(ok([ref]));
    expect(await fixture({ job: { name: 'SpecGit reused / linux' } }).port.candidates(repository, 'linux')).toEqual(ok([]));
  });

  it('rejects candidates and originals from a different branch than the current native pipeline', async () => {
    const { port } = fixture({ parent: { ref: 'other' } });
    expect((await port.candidates(repository, 'linux')).ok).toBe(false);
    expect((await port.original(ref)).ok).toBe(false);
  });

  it('rejects a different repository or a fabricated attempt', async () => {
    const { port } = fixture();
    expect((await port.original({ ...ref, repository: 'gitlab.example.com/other/project' })).ok).toBe(false);
    expect((await port.original({ ...ref, attempt: 2 })).ok).toBe(false);
  });
});
