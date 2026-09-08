import { appendFile, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { decideVerificationReuse } from '../verification/reuse-decision.js';
import { originalJobName } from '../verification/reuse-producer.js';
import { gitlabReuseChild } from '../verification/reuse-workflow.js';
import { executeNormalizedVerification, executeVerificationCommands } from '../verification/reuse-runner.js';
import { readReuseCiState, type ReuseCiState } from './reuse-state.js';

export type { ReuseCiState } from './reuse-state.js';
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[1-9][0-9]*$/).max(30);
const refSchema = z.object({ repository: z.string().max(500), run: id, attempt: z.number().int().min(1), job: id }).strict();
const contextSchema = z.object({
  repository: z.string().max(500), profile: z.object({ id: z.string(), maxAgeSeconds: z.number().int() }).strict().nullable(),
  inputs: z.object({ sourceSha: sha, checkoutSha: sha, baseSha: sha, policySha: sha,
    recipeDigest: digest, environmentDigest: digest, sourceTreeDigest: digest, checkoutTreeDigest: digest, digest }).strict(),
}).strict();
const planSchema = z.object({
  version: z.literal(1), profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  repository: z.string().max(500), run: id, attempt: z.number().int().min(1), checkoutSha: sha,
  mode: z.enum(['execute', 'reuse']), jobName: z.string().max(200), applicable: z.boolean().optional(),
  context: contextSchema.optional(), original: refSchema.optional(),
  parentPipeline: id.optional(), prepareJob: id.optional(),
}).strict();

interface CiOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; now?: () => number; log?: (text: string) => void;
  readState?: (parentRun?: string) => Promise<ReuseCiState>;
}

type CiResult = { mode: 'execute' | 'reuse' | 'executed' | 'reused' | 'not_applicable'; reason?: string };
const rejected = (code: string) => fail<CiResult>(code,
  'Verification inputs or execution changed; no successful verification result was produced.',
  'Run a new CI pipeline for the current inputs. SpecGit acceptance remains separate.');

async function regularFile(target: string): Promise<string> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Invalid integration artifact');
  return readFile(target, 'utf8');
}

/** Private CI entry point. It schedules/runs checks and cannot accept or complete a delivery. */
export async function runVerificationCi(
  mode: 'prepare' | 'execute' | 'reuse', profileId: string, options: CiOptions = {},
): Promise<Evidence<CiResult>> {
  const root = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const observe = options.readState ?? ((parentRun?: string) => readReuseCiState(root, profileId, env, now(), parentRun));
  const directory = path.join(root, '.specgit-reuse');
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profileId)) return rejected('verification_profile_invalid');
    if (mode === 'prepare') {
      const state = await observe();
      if (state.verifyJobName && !await state.verifyJobName(`SpecGit prepare / ${profileId}`)) return rejected('verification_native_job_mismatch');
      const notApplicable = state.context.ok && state.applicable === false;
      const decision = notApplicable ? { mode: 'execute' as const, reason: 'check_not_applicable' } : await decideVerificationReuse({ current: async () => (await observe()).context,
        executions: state.executions, now: now() });
      const reused = decision.mode === 'reuse';
      const jobName = notApplicable ? `SpecGit not applicable / ${profileId}` : reused ? `SpecGit reused / ${profileId}` : state.context.ok
        ? originalJobName(profileId, state.context.value.inputs.digest) : `SpecGit uncached / ${profileId}`;
      const plan = planSchema.parse({ version: 1, profile: profileId, repository: state.repository,
        run: state.run, attempt: state.attempt, checkoutSha: state.checkoutSha, mode: reused ? 'reuse' : 'execute', jobName,
        ...(state.applicable !== undefined ? { applicable: state.applicable } : {}),
        ...(state.context.ok ? { context: state.context.value } : {}),
        ...(reused ? { original: decision.original } : {}),
        ...(state.platform === 'gitlab' ? { parentPipeline: state.run, prepareJob: env.CI_JOB_ID } : {}),
      });
      // A tracked file/link at this reserved path is never overwritten.
      await mkdir(directory);
      await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
      if (state.platform === 'gitlab') {
        const assertion = env.SPECGIT_REUSE_IDENTITY;
        delete env.SPECGIT_REUSE_IDENTITY;
        if (assertion && assertion.length <= 65536) {
          await writeFile(path.join(directory, 'identity.json'), JSON.stringify({ assertion }), { flag: 'wx', mode: 0o600 });
        }
        await writeFile(path.join(directory, 'parent.json'), JSON.stringify({ parentPipeline: plan.parentPipeline, prepareJob: plan.prepareJob }), { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(directory, 'child.yml'), gitlabReuseChild(state.profile, {
          parentPipeline: state.run, jobName, mode: plan.mode,
        }), { flag: 'wx', mode: 0o600 });
      } else if (env.GITHUB_OUTPUT) {
        await appendFile(env.GITHUB_OUTPUT, `mode=${plan.mode}\njob_name=${jobName}\ncheckout_sha=${state.checkoutSha}\n`);
      }
      return ok({ mode: plan.mode, ...(decision.mode === 'execute' ? { reason: state.context.ok ? decision.reason : state.context.code } : {}) });
    }
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return rejected('verification_plan_invalid');
    // Parent assertions remain in the native artifact, never in a business-command workspace.
    await unlink(path.join(directory, 'identity.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const plan = planSchema.parse(JSON.parse(await regularFile(path.join(directory, 'plan.json'))));
    if (plan.profile !== profileId || plan.mode !== mode) return rejected('verification_plan_mismatch');
    const state = await observe(plan.parentPipeline);
    if (state.profile.id !== profileId || plan.repository !== state.repository || plan.run !== state.run || plan.attempt !== state.attempt ||
        plan.checkoutSha !== state.checkoutSha || plan.applicable !== state.applicable ||
        (plan.context && (!state.context.ok || JSON.stringify(plan.context) !== JSON.stringify(state.context.value)))) return rejected('verification_inputs_changed');
    const notApplicable = plan.context !== undefined && plan.applicable === false;
    const expectedName = notApplicable ? `SpecGit not applicable / ${profileId}` : mode === 'reuse' ? `SpecGit reused / ${profileId}` : plan.context
      ? originalJobName(profileId, plan.context.inputs.digest) : `SpecGit uncached / ${profileId}`;
    if (plan.jobName !== expectedName || (state.verifyJobName && !await state.verifyJobName(expectedName))) return rejected('verification_native_job_mismatch');
    let reused = false;
    if (mode === 'reuse') {
      const current = await decideVerificationReuse({ current: async () => (await observe(plan.parentPipeline)).context,
        executions: state.executions, now: now() });
      reused = current.mode === 'reuse' && JSON.stringify(current.original) === JSON.stringify(plan.original);
    }
    if (!reused && !notApplicable) {
      const result = plan.context
        ? await executeNormalizedVerification(root, plan.context.inputs, state.profile, { log: options.log, env })
        : await executeVerificationCommands(root, state.profile.commands, state.profile.environment, { log: options.log, env });
      if (!result.ok) return result;
    }
    const fresh = await executeVerificationCommands(root, state.profile.fresh_commands, state.profile.environment, { log: options.log, env });
    if (!fresh.ok) return fresh;
    if (plan.parentPipeline) {
      const originalParent = JSON.parse(await regularFile(path.join(directory, 'parent.json')));
      if (JSON.stringify(originalParent) !== JSON.stringify({ parentPipeline: plan.parentPipeline, prepareJob: plan.prepareJob })) return rejected('verification_parent_changed');
    }
    return ok({ mode: notApplicable ? 'not_applicable' : reused ? 'reused' : 'executed' });
  } catch { return rejected('verification_ci_failed'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, profile, ...extra] = process.argv.slice(2);
  if (!['prepare', 'execute', 'reuse'].includes(mode) || !profile || extra.length) {
    process.stderr.write('Internal CI usage: verification-ci.js <prepare|execute|reuse> <profile>\n');
    process.exitCode = 2;
  } else {
    const result = await runVerificationCi(mode as 'prepare' | 'execute' | 'reuse', profile);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }
}
