/**
 * The delivery bootstrap chain (#278): the ordered steps `specgit
 * issue` walks after arguments and record are resolved — checkout,
 * commit the binding, push the head, bind the PR, commit the final
 * record, push the commit. The order is a contract (§5 of
 * docs/release-gates.md: a PR/MR for a head branch that was never
 * pushed is refused by both platforms; #323: a PR whose head adds no
 * commit over the base is refused too), so it lives here as data — one
 * registration per step with its precondition, resume marker, and
 * failure code — instead of statement sequence in the highest-churn
 * command file. Reordering the chain is a change to BOOTSTRAP_STEPS,
 * reviewable as such; `runIssue` is a thin facade over
 * `runBootstrapSteps`.
 *
 * Resume discipline (I4): each step's `resume` probe names the durable
 * marker of its completion — the live branch, the recorded PR number —
 * so a re-run from any partial state converges without repeating a
 * completed step. The two pushes are deliberately marker-less healing
 * steps: git push is idempotent, and re-running them is exactly how a
 * run that died mid-chain heals (#270).
 */

import { EXIT_UNKNOWN } from '../exit-codes.js';
import { errorDiagnostic, type IssueOutcome } from '../output.js';
import { renderPrScaffold } from '../../github/pr-scaffold.js';
import { POLICY_FILENAME, PROVIDERS_FILENAME, RECORD_FILENAME } from '../../record/schema.js';
import { SPEC_GIT_DIR } from '../types.js';
import type { PolicyLanguage } from '../../record/policy.js';
import type { CommandContext, DeliveryBinding, Evidence, RepoRef } from '../types.js';
import { catalogFor } from '../language.js';
import type { GitFacts } from '../../gitfacts/port.js';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

type FailureEvidence = Extract<Evidence<unknown>, { ok: false }>;

/**
 * #299: the authoritative delivery files that ride a carrying commit —
 * the record always, the policy and providers files when they exist on
 * disk. One spelling for the bootstrap chain, `pr` repair, and `bind`
 * surgery, so every path that rewrites the record carries it into git
 * the same way (force-staged past the #292 local-asset ignore, where
 * the PR-head CI verdict reads it).
 */
export function authoritativeDeliveryPaths(root: string): string[] {
  return [
    RECORD_FILENAME,
    ...[
      `${SPEC_GIT_DIR}/${POLICY_FILENAME}`,
      `${SPEC_GIT_DIR}/${PROVIDERS_FILENAME}`,
    ].filter((relative) => existsSync(path.join(root, relative))),
  ];
}

export function recordBindingCommitMessage(delivery: string): string {
  return `chore: record delivery binding for ${delivery}`;
}

/**
 * #299 carrying commit for record-changing repair paths: force-stage the
 * authoritative files, commit, push the delivery branch. Idempotent
 * (unchanged tree commits nothing; push -u is safe to re-run). The
 * caller owns the failure policy: the local commit is deterministic
 * (its failure is a real environment problem), while the push depends
 * on remote availability — callers warn on push failure so offline and
 * sandboxed environments keep working, with the stale-record
 * consequence spelled out.
 */
export async function carryRecordToBranch(
  ctx: CommandContext,
  root: string,
  record: DeliveryBinding
): Promise<
  | { ok: true; value: { committed: boolean; pushed: boolean } }
  | { ok: false; code: string; message: string; fix?: string }
  | { ok: true; pushFailed: true; pushMessage: string }
> {
  const commit = await ctx.git.commitFile(
    root,
    authoritativeDeliveryPaths(root),
    recordBindingCommitMessage(record.delivery)
  );
  if (!commit.ok) {
    return commit;
  }
  const push = await ctx.git.pushBranch(root, record.context.branch);
  if (!push.ok) {
    return { ok: true, pushFailed: true, pushMessage: push.message };
  }
  return { ok: true, value: { committed: commit.value.committed, pushed: true } };
}

export function passthrough(failure: FailureEvidence): IssueOutcome {
  return {
    exit: EXIT_UNKNOWN,
    errors: [
      errorDiagnostic(failure.code, failure.message, failure.fix ? { fix: failure.fix } : {}),
    ],
  };
}

export function recordWriteFailure(error: unknown): IssueOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exit: EXIT_UNKNOWN,
    errors: [errorDiagnostic('record_write_failed', message)],
  };
}

/** The mutable thread the chain steps read and advance. */
export interface BootstrapState {
  record: DeliveryBinding;
  firstTitle: string | null;
  /** The branch HEAD is on as of the pre-chain facts (null: detached). */
  currentBranch: string | null;
}

export interface BootstrapStepContext {
  ctx: CommandContext;
  root: string;
  repo: RepoRef;
  language: PolicyLanguage;
  state: BootstrapState;
}

/** The chain result: the bound record, or a fail-closed diagnostic. */
export type BootstrapOutcome = IssueOutcome | { record: DeliveryBinding };

export type BootstrapStepId =
  | 'checkout'
  | 'commit-binding'
  | 'push-head'
  | 'bind-pr'
  | 'commit-record'
  | 'push-record-commit';

export interface BootstrapStep {
  id: BootstrapStepId;
  /**
   * The stable diagnostic code a failure of this step reports — the
   * code the operator sees when the chain halts here.
   */
  failureCode: string;
  /**
   * The precondition that must hold before `run` executes; the runner
   * skips the step when it already holds.
   */
  precondition: (state: BootstrapState) => boolean;
  /**
   * The durable marker of completion: when it holds on resume, the step
   * never runs again. null marks a healing step whose idempotent
   * re-execution IS the resume mechanism (the pushes).
   */
  resume: ((state: BootstrapState) => boolean) | null;
  run: (deps: BootstrapStepContext) => Promise<BootstrapOutcome>;
}

/**
 * The record-commit step body, shared by the two chain positions that
 * carry the authoritative files (#323): once BEFORE PR creation — a
 * pull request whose head equals its base is refused by both platforms
 * ("No commits between"), so the binding must be in git before the
 * head is pushed for binding — and once AFTER, to carry the PR number
 * the bind step persisted. Both positions are marker-less healing
 * steps: commitFile probes staged changes itself and commits nothing
 * on a clean tree.
 */
function recordCommitStep(id: 'commit-binding' | 'commit-record'): BootstrapStep {
  return {
    id,
    failureCode: 'git_commit_failed',
    precondition: () => true,
    resume: null,
    run: async ({ ctx, root, state }) => {
      const commit = await ctx.git.commitFile(
        root,
        authoritativeDeliveryPaths(root),
        recordBindingCommitMessage(state.record.delivery)
      );
      return commit.ok ? { record: state.record } : passthrough(commit);
    },
  };
}

/**
 * The chain, in order. Reordering the bootstrap is a change to this
 * list; the runner carries no order of its own.
 *
 * #323 ordering contract: `commit-binding` precedes `push-head` +
 * `bind-pr` because both platforms refuse a pull request whose head
 * branch holds no commit beyond the base — pushing the bare branch
 * first made every fresh bootstrap die at PR creation with "No
 * commits between".
 */
export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  {
    id: 'checkout',
    failureCode: 'git_checkout_failed',
    precondition: (state) => state.currentBranch !== state.record.context.branch,
    resume: (state) => state.currentBranch === state.record.context.branch,
    run: async ({ ctx, root, state }) => {
      const checkout = await ctx.git.checkoutOrCreateBranch(root, state.record.context.branch);
      if (!checkout.ok) {
        return passthrough(checkout);
      }
      state.currentBranch = state.record.context.branch;
      return { record: state.record };
    },
  },
  recordCommitStep('commit-binding'),
  {
    // The branch must exist on the remote before PR/MR creation — both
    // platforms refuse a pull request whose head branch was never
    // pushed (gh: Head sha can't be blank; glab: source_branch does not
    // exist). Idempotent, so it also heals an unpushed branch on resume.
    // It runs after `commit-binding`: the pushed head must differ from
    // the base (#323), not merely exist.
    id: 'push-head',
    failureCode: 'git_push_failed',
    precondition: () => true,
    resume: null,
    run: async ({ ctx, root, state }) => {
      const push = await ctx.git.pushBranch(root, state.record.context.branch);
      return push.ok ? { record: state.record } : passthrough(push);
    },
  },
  {
    id: 'bind-pr',
    failureCode: 'pr_ambiguous',
    precondition: (state) => state.record.pr === undefined,
    resume: (state) => state.record.pr !== undefined,
    run: async (deps) => {
      const { ctx, root, repo, language, state } = deps;
      const { human } = catalogFor(language);
      const bound = await bindPullRequest({
        ctx,
        root,
        repo,
        language,
        human,
        record: state.record,
        branch: state.record.context.branch,
        firstTitle: state.firstTitle,
      });
      if ('exit' in bound) {
        return bound;
      }
      state.record = bound.record;
      return bound;
    },
  },
  recordCommitStep('commit-record'),
  {
    id: 'push-record-commit',
    failureCode: 'git_push_failed',
    precondition: () => true,
    resume: null,
    run: async ({ ctx, root, state }) => {
      const push = await ctx.git.pushBranch(root, state.record.context.branch);
      return push.ok ? { record: state.record } : passthrough(push);
    },
  },
];

/**
 * Walk the chain in order: skip a step whose precondition already
 * holds, halt on the first failure. Returns the bound record once every
 * step has run.
 */
export async function runBootstrapSteps(
  steps: readonly BootstrapStep[],
  deps: {
    ctx: CommandContext;
    root: string;
    repo: RepoRef;
    language: PolicyLanguage;
    record: DeliveryBinding;
    firstTitle: string | null;
    facts: GitFacts;
  }
): Promise<BootstrapOutcome> {
  const state: BootstrapState = {
    record: deps.record,
    firstTitle: deps.firstTitle,
    currentBranch: deps.facts.branch,
  };
  for (const step of steps) {
    if (!step.precondition(state)) {
      continue;
    }
    const outcome = await step.run({
      ctx: deps.ctx,
      root: deps.root,
      repo: deps.repo,
      language: deps.language,
      state,
    });
    if ('exit' in outcome) {
      return outcome;
    }
  }
  return { record: state.record };
}

/**
 * PR binding: discover, adopt, or create the draft PR for the head
 * branch — the open PR for the branch is the remotely discoverable
 * idempotency marker — then post the traceability comment (#160) on
 * every bound issue and persist the number as the exactly-once marker.
 * The scaffold body is written exactly once, on the fresh-creation path
 * (#87).
 */
async function bindPullRequest(deps: {
  ctx: CommandContext;
  root: string;
  repo: RepoRef;
  language: PolicyLanguage;
  human: ReturnType<typeof catalogFor>['human'];
  record: DeliveryBinding;
  branch: string;
  firstTitle: string | null;
}): Promise<IssueOutcome | { record: DeliveryBinding }> {
  const { ctx, root, repo, language, human, branch, firstTitle } = deps;
  let record = deps.record;

  const baseEv = await ctx.git.remoteDefaultBranch(root);
  if (!baseEv.ok) {
    return passthrough(baseEv);
  }
  // Remotely discoverable idempotency marker for the PR: the open pull
  // request for this head branch. A previous run may have created it but
  // failed to record the number — adopt it instead of opening a second.
  const listEv = await ctx.gh.listOpenPrsByHead(repo, branch);
  if (!listEv.ok) {
    return passthrough(listEv);
  }
  let prNumber: number;
  if (listEv.value.length === 1) {
    prNumber = listEv.value[0].number;
  } else if (listEv.value.length > 1) {
    const listing = listEv.value
      .map((pr) => `  #${pr.number} ${pr.title} (${pr.url})`)
      .join('\n');
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(
          'pr_ambiguous',
          `Multiple open pull requests have head branch '${branch}':\n${listing}`,
          {
            fix: 'Bind one explicitly: specgit pr <number>, then re-run specgit issue to finish the delivery.',
          }
        ),
      ],
    };
  } else {
    const prTitle = firstTitle ?? human.issuePrTitleFallback(record.delivery);
    // The scaffold is written exactly once, here on the fresh-creation
    // path (no PR bound, none adoptable): resume and repair bind or
    // adopt what already exists and never rewrite a PR body (#87).
    const prBody = renderPrScaffold(record.issues, language);
    const prEv = await ctx.gh.createDraftPr(repo, branch, baseEv.value, prTitle, prBody);
    if (!prEv.ok) {
      return passthrough(prEv);
    }
    prNumber = prEv.value.number;
  }
  // Traceability edge issue→branch (#160): the moment the PR binding is
  // first established, every bound issue gets the branch and PR as a
  // comment. `record.pr` below is the persisted exactly-once marker —
  // a comment failure fails closed *before* the number lands in the
  // record, so a re-run re-enters this block (fresh or adopt path) and
  // posts it; a completed binding never comments again.
  const commentBody = human.issueTraceabilityComment(branch, prNumber);
  for (const issueNumber of record.issues) {
    const commentEv = await ctx.gh.addIssueComment(repo, issueNumber, commentBody);
    if (!commentEv.ok) {
      return passthrough(commentEv);
    }
  }
  record = { ...record, pr: prNumber };
  try {
    await ctx.record.writeRecord(root, record);
  } catch (error) {
    return recordWriteFailure(error);
  }
  return { record };
}
