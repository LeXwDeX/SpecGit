import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyCiEligibility } from '../dist/automation/ci-eligibility.js';

const DISABLED_MESSAGE = 'Version PR automatic merge is disabled. Run specgit init --force and answer yes with main as the merge target to enable it.';

/**
 * Merge one generated version PR through the configured automation boundary.
 * @param {{ policy?: import('../src/record/policy.js').Policy,
 * provider: Pick<import('../src/github/port.js').ForgeProvider, 'listOpenPrsByHead' | 'getPr' | 'getPrChecks' | 'mergePr'>,
 * repo: import('../src/gitfacts/origin.js').RepoRef, expectedHeadSha: string,
 * now?: () => number, sleep?: (milliseconds: number) => Promise<void>,
 * timeoutMs?: number, pollIntervalMs?: number, log?: (message: string) => void }} options
 * @returns {Promise<{status: 'disabled' | 'merged', pr?: number}>}
 */
export async function mergeVersionPullRequest(options) {
  const { policy, log = console.log } = options;
  if (policy?.automation?.merge !== true || policy.automation.target_branch !== 'main') {
    log(DISABLED_MESSAGE);
    return { status: 'disabled' };
  }
  const { provider, repo, expectedHeadSha } = options;
  if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha)) throw new Error('A full GitHub commit SHA is required.');
  const listed = requireEvidence(await provider.listOpenPrsByHead(repo, 'changeset-release/main'));
  if (listed.length !== 1) throw new Error('Expected exactly one open version PR.');
  const number = listed[0].number;
  /** @param {import('../src/github/port.js').PrFact} fact */
  const checkIdentity = (fact) => {
    if (fact.number !== number || fact.headBranch !== 'changeset-release/main' || fact.baseBranch !== 'main' || fact.headSha !== expectedHeadSha || fact.draft) {
      throw new Error('The version PR identity changed or does not match the generated proposal.');
    }
    if (fact.state === 'closed') throw new Error('The version PR is closed without merging.');
  };
  const { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 35 * 60 * 1000, pollIntervalMs = 10_000 } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const current = requireEvidence(await provider.getPr(repo, number));
    checkIdentity(current);
    if (current.state === 'merged') return { status: 'merged', pr: number };
    const ci = requireEvidence(await provider.getPrChecks(repo, number));
    if (ci.headSha !== expectedHeadSha) throw new Error('CI evidence belongs to a different version PR head.');
    const eligibility = classifyCiEligibility(ci.checks, policy.required_checks);
    // Aggregated checks can revise an intermediate conclusion while sibling
    // work is running. Decide failure only after this head's CI has settled.
    const pending = eligibility.problems.some((problem) => problem.kind === 'pending');
    const failure = eligibility.problems.find((problem) => problem.kind === 'failed');
    if (!pending && failure !== undefined) {
      const { check } = failure;
      throw new Error(`CI check '${check.name}' concluded ${check.conclusion ?? 'unknown'}.`);
    }
    if (eligibility.eligible) break;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Timed out waiting for complete, successful version PR checks.');
    log(`Waiting for all CI checks on version PR #${number} at ${expectedHeadSha}.`);
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  const beforeMerge = requireEvidence(await provider.getPr(repo, number));
  checkIdentity(beforeMerge);
  if (beforeMerge.state !== 'merged') {
    const merged = requireEvidence(await provider.mergePr(repo, number, expectedHeadSha));
    if (!merged.merged) throw new Error('The platform did not merge the version PR.');
  }
  const confirmed = requireEvidence(await provider.getPr(repo, number));
  checkIdentity(confirmed);
  if (confirmed.state !== 'merged') throw new Error('The platform did not confirm the version PR as merged.');
  log(`Version PR #${number} merged at verified head ${expectedHeadSha}.`);
  return { status: 'merged', pr: number };
}

/** @template T @param {import('../src/kernel/evidence.js').Evidence<T>} result @returns {T} */
function requireEvidence(result) {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}


async function main() {
  // The workflow builds before invoking this entry point; its checkout is
  // still the generated version branch, whose HEAD is the expected SHA.
  const { readPolicy } = await import(new URL('../dist/record/io.js', import.meta.url).href);
  const loaded = await readPolicy(process.cwd());
  if (!loaded.ok && loaded.code !== 'policy_missing') throw new Error(`${loaded.code}: ${loaded.message}`);
  const policy = loaded.ok ? loaded.value : undefined;
  if (policy?.automation?.merge !== true || policy.automation.target_branch !== 'main') {
    console.log(DISABLED_MESSAGE);
    return;
  }
  const project = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project)) throw new Error('GITHUB_REPOSITORY must identify the release repository.');
  const [owner, repo] = project.split('/');
  const expectedHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const { GhCliGitHubProvider } = await import(new URL('../dist/providers/github/gh-cli.js', import.meta.url).href);
  await mergeVersionPullRequest({ policy, provider: new GhCliGitHubProvider(), repo: { owner, repo, platform: 'github' }, expectedHeadSha });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
