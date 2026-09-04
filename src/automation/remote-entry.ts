/** Internal trusted-workflow entry. It is deliberately not a public CLI command. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createDefaultContext } from '../cli/wiring.js';
import { DeliveryBindingSchema } from '../record/schema.js';
import { isAutomationTargetBranch } from '../record/policy.js';
import { matchesBoundRequest, runRemoteDelivery } from './remote-delivery.js';
import * as recordIo from '../record/io.js';

const git = (root: string, hooks: string, args: string[]): string => execFileSync('git', ['-C', root, '-c', `core.hooksPath=${hooks}`, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
});

/** workflow_run may omit its PR list after merge; retain the identity resolved by the trusted identify job. */
export function workflowRequestNumber(requests: unknown, supplied: number): number | undefined {
  if (Array.isArray(requests) && requests.length === 1) {
    const item = requests[0] as { number?: unknown } | null;
    if (typeof item?.number === 'number' && Number.isSafeInteger(item.number) && item.number > 0) return item.number;
  }
  return Number.isSafeInteger(supplied) && supplied > 0 ? supplied : undefined;
}

/** Call from a trusted default-branch pipeline with gh/glab authentication and a full-history data checkout. */
export async function completeFromEnvironment(): Promise<number> {
  const parent = mkdtempSync(join(tmpdir(), 'specgit-completion-'));
  const hooks = join(parent, 'hooks');
  mkdirSync(hooks);
  const dataRoot = resolve(process.env.SPECGIT_DATA_ROOT ?? process.cwd());
  process.chdir(dataRoot);
  const ctx = createDefaultContext();
  const facts = await ctx.git.facts(dataRoot);
  if (!facts.originUrl) throw new Error('Completion requires a repository origin.');
  const repo = await ctx.parseRepoRef(facts.originUrl);
  if (!repo.ok) throw new Error(repo.message);
  let pr = Number(process.env.SPECGIT_PR);
  let headSha = process.env.SPECGIT_HEAD ?? '';
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const run = event.workflow_run;
    if (run?.event !== 'pull_request' || run?.status !== 'completed' || run?.repository?.full_name !== process.env.GITHUB_REPOSITORY) {
      throw new Error('Completion requires a completed pull-request workflow in this repository.');
    }
    headSha = run.head_sha;
    const identified = workflowRequestNumber(run.pull_requests, pr);
    if (identified !== undefined) pr = identified;
    else {
      if (!isAutomationTargetBranch(run.head_branch ?? '')) throw new Error('The triggering head branch is unavailable.');
      const candidates = await ctx.gh.listOpenPrsByHead(repo.value, run.head_branch);
      if (!candidates.ok || candidates.value.length !== 1) throw new Error('The triggering workflow does not identify exactly one pull request.');
      pr = candidates.value[0].number;
    }
  }
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/i.test(headSha)) {
    throw new Error('Set SPECGIT_PR and SPECGIT_HEAD to the intended request and full current head SHA.');
  }
  const observed = await ctx.gh.getPr(repo.value, pr);
  if (!observed.ok) throw new Error(observed.message);
  if (observed.value.headSha !== headSha) throw new Error('The triggering request head is stale.');
  if (!isAutomationTargetBranch(observed.value.headBranch) || !isAutomationTargetBranch(observed.value.baseBranch)) {
    throw new Error('The forge returned an unusable branch name.');
  }
  const record = DeliveryBindingSchema.parse(YAML.parse(git(dataRoot, hooks, ['show', `${headSha}:.specgit.yaml`])));
  if (!matchesBoundRequest(record, repo.value, pr) || record.context.branch !== observed.value.headBranch) throw new Error('The immutable PR-head record does not match the triggering request.');
  // A dedicated data worktree preserves branch/worktree context without ever
  // installing or running the request's code, hooks, or lifecycle scripts.
  const label = record.context.kind === 'worktree' ? record.context.label : 'delivery';
  if (!label || label === '.' || label === '..' || /[\\/\p{Cc}]/u.test(label)) throw new Error('Unsafe worktree label in delivery record.');
  const checkout = join(parent, label);
  const branch = observed.value.state === 'merged' ? observed.value.baseBranch : record.context.branch;
  const revision = observed.value.state === 'merged' ? `refs/remotes/origin/${branch}` : headSha;
  git(dataRoot, hooks, ['worktree', 'add', '--detach', checkout, revision]);
  git(checkout, hooks, ['checkout', '-B', branch, revision]);
  git(checkout, hooks, ['config', 'core.hooksPath', hooks]);
  process.chdir(checkout);
  const isolated = createDefaultContext({ record: { ...recordIo, readRecord: async () => ({ ok: true, value: record }) } });
  const result = await runRemoteDelivery({ repo: repo.value, pr, headSha, record }, isolated, {
    prepareMerged: async () => {
      const base = observed.value.baseBranch;
      git(checkout, hooks, ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
      git(checkout, hooks, ['checkout', '-B', base, `refs/remotes/origin/${base}`]);
    },
  });
  console.log(JSON.stringify(result));
  return result.exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  completeFromEnvironment().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
}
