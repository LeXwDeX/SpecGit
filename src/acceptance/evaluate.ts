import type { Diagnostic } from '../kernel/diagnostics.js';
import type { Evidence } from '../kernel/evidence.js';
import type { Policy } from '../record/policy.js';
import type { DeliveryBinding } from '../record/schema.js';
import type { GitFacts, GitPort } from '../gitfacts/port.js';
import {
  formatRepoRef,
  parsePrUrl,
  parseRepoRef,
  requireGithubRoute,
  sameRepoRef,
  type RepoRef,
} from '../gitfacts/origin.js';
import type { CheckRunInfo, GitHubProvider, PrFact } from '../github/port.js';
import { parseClosingRefs } from '../github/closing-refs.js';
import { CODE_INFO, type SpecGitCode } from './codes.js';

export type DeliveryState = 'unbound' | 'draft' | 'bound' | 'accepted' | 'rejected' | 'unknown';
export type VerdictClassification = 'accepted' | 'rejected' | 'unknown';

export type GateId =
  | 'record'
  | 'policy'
  | 'completeness'
  | 'context'
  | 'origin'
  | 'provider'
  | 'issues'
  | 'sequence'
  | 'pr'
  | 'closing'
  | 'checks';

/**
 * The gate registry (#69): eleven gates in evaluation order, `sequence`
 * included. Contract tests pin this against help, docs, and the generated
 * agent surface.
 */
export const GATE_ORDER: GateId[] = [
  'record',
  'policy',
  'completeness',
  'context',
  'origin',
  'provider',
  'issues',
  'sequence',
  'pr',
  'closing',
  'checks',
];

export interface GateFailure {
  code: SpecGitCode;
  message: string;
  detail?: unknown;
  fix?: string;
}

export interface GateResult {
  id: GateId;
  status: 'pass' | 'fail' | 'skipped';
  failures: GateFailure[];
}

export interface VerdictEvidence {
  root: string | null;
  repo: string | null;
  delivery: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  upstreamDrift: { ahead: number; behind: number } | null;
  context: { kind: 'branch' } | { kind: 'worktree' } | null;
  issues: number[] | null;
  pr: number | null;
  prHead: string | null;
}

export interface Verdict {
  accepted: boolean;
  state: DeliveryState;
  classification: VerdictClassification;
  exitCode: 0 | 1 | 3;
  complete: boolean;
  gates: GateResult[];
  evidence: VerdictEvidence;
  warnings: Diagnostic[];
}

export interface EvaluateInput {
  root: Evidence<string>;
  record: Evidence<DeliveryBinding>;
  policy: Evidence<Policy>;
  git: GitPort;
  gh?: GitHubProvider;
  /** Declared self-hosted GitLab host (spec_git/providers.yaml), if any. */
  gitlabHost?: string;
}

function isEvidenceKind(code: string): boolean {
  return (CODE_INFO[code as SpecGitCode]?.kind ?? 'evidence') === 'evidence';
}

function repoRefForMergedCheck(originUrl: string | null, gitlabHost?: string): { owner: string; repo: string } | null {
  if (!originUrl) return null;
  const parsed = parseRepoRef(originUrl, gitlabHost !== undefined ? { gitlabHost } : {});
  return parsed.ok ? parsed.value : null;
}

/**
 * #119: the truth run for a check name — the run with the latest
 * started_at, ties broken by the higher check-run id. Re-runs keep every
 * same-name run in the Checks API and response position is never
 * evidence (the product decision docs/reference.md states once).
 */
function truthRun(runs: CheckRunInfo[], name: string): CheckRunInfo | undefined {
  let best: CheckRunInfo | undefined;
  for (const run of runs) {
    if (run.name !== name) continue;
    if (best === undefined || isLaterRun(run, best)) best = run;
  }
  return best;
}

function isLaterRun(a: CheckRunInfo, b: CheckRunInfo): boolean {
  const keyA = a.startedAt ?? '';
  const keyB = b.startedAt ?? '';
  if (keyA !== keyB) return keyA > keyB;
  return a.id > b.id;
}

/**
 * Pure acceptance evaluation. States are derived per invocation, never
 * persisted. Gates short-circuit across gates and collect all failures within
 * a gate. Acceptance derives only from git, PR, and check evidence — spec
 * artifacts and task lists are never read. Fail-closed axiom: any evidence
 * failure yields `unknown` (exit 3); a decisive finding with complete evidence
 * yields `rejected` (exit 1).
 */
export async function evaluate(input: EvaluateInput): Promise<Verdict> {
  const results = new Map<GateId, GateFailure[]>();
  let halted = false;

  const evidence: VerdictEvidence = {
    root: input.root.ok ? input.root.value : null,
    repo: null,
    delivery: null,
    branch: null,
    headSha: null,
    dirty: null,
    upstreamDrift: null,
    context: null,
    issues: null,
    pr: null,
    prHead: null,
  };
  const warnings: Diagnostic[] = [];

  const makeFailure = (code: string, detail?: unknown): GateFailure => {
    const info = CODE_INFO[code as SpecGitCode];
    return {
      code: code as SpecGitCode,
      message: info?.message ?? code,
      fix: info?.fix,
      ...(detail === undefined ? {} : { detail }),
    };
  };

  const runGate = async (
    id: GateId,
    collect: () => Promise<GateFailure[]> | GateFailure[]
  ): Promise<boolean> => {
    if (halted) {
      return false;
    }
    const failures = await collect();
    results.set(id, failures);
    if (failures.length > 0) {
      halted = true;
      return false;
    }
    return true;
  };

  const binding: DeliveryBinding | null = input.record.ok ? input.record.value : null;
  const policy: Policy | null = input.policy.ok ? input.policy.value : null;

  const g1 = await runGate('record', () => {
    if (!input.record.ok) {
      return [makeFailure(input.record.code)];
    }
    evidence.delivery = binding!.delivery;
    evidence.context = binding!.context.kind === 'branch' ? { kind: 'branch' } : { kind: 'worktree' };
    evidence.issues = [...binding!.issues];
    return [];
  });

  const g2 =
    g1 &&
    (await runGate('policy', () => {
      if (!policy) {
        return [makeFailure((input.policy as { ok: false; code: string }).code)];
      }
      return [];
    }));

  const g3 =
    g2 &&
    (await runGate('completeness', () => {
      const failures: GateFailure[] = [];
      if (!binding || binding.issues.length === 0) {
        failures.push(makeFailure('issues_empty'));
      }
      if (!binding || binding.pr === undefined) {
        failures.push(makeFailure('pr_missing'));
      }
      return failures;
    }));

  const factsState: { value: GitFacts | null } = { value: null };
  let mergedRecord = false;
  const g4 =
    g3 &&
    (await runGate('context', async () => {
      if (!input.root.ok) {
        return [makeFailure(input.root.code)];
      }
      factsState.value = await input.git.facts(input.root.value);
      const facts = factsState.value;
      if (!facts.gitAvailable) {
        return [makeFailure('git_unavailable')];
      }
      if (!facts.repo) {
        return [makeFailure('not_a_git_repo')];
      }
      if (facts.headSha === null) {
        return [makeFailure('no_commits')];
      }

      evidence.branch = facts.branch;
      evidence.headSha = facts.headSha;
      evidence.dirty = facts.dirty;
      evidence.upstreamDrift = facts.upstreamDrift;

      if (facts.branch === null) {
        return [makeFailure('detached_head')];
      }
      if (facts.branch !== binding!.context.branch) {
        // The record may belong to a delivery whose PR already merged —
        // running finish on main afterwards is then a completed history,
        // not a mismatch. Historical acceptance still requires proof that
        // local HEAD contains the merged delivery: GitHub's
        // merge_commit_sha is a commit on the base branch under every
        // merge method (merge commit, squash, rebase), so containment of
        // that one anchor in local HEAD is the lineage proof. A provider
        // failure keeps the fail-closed mismatch (never upgrades on
        // missing evidence), and unresolved lineage never turns green.
        const repoForMerged = repoRefForMergedCheck(facts.originUrl, input.gitlabHost);
        if (repoForMerged && binding!.pr !== undefined && input.gh) {
          const prEv = await input.gh.getPr(repoForMerged, binding!.pr);
          if (prEv.ok && prEv.value.state === 'merged') {
            evidence.prHead = prEv.value.headSha;
            const mergeCommitSha = prEv.value.mergeCommitSha;
            if (!mergeCommitSha) {
              // No anchor means no proof. The PR head is not a substitute:
              // squash and rebase never put it on the base branch.
              return [
                makeFailure('merged_lineage_unavailable', {
                  source: 'provider',
                  pr: prEv.value.number,
                }),
              ];
            }
            const containment = await input.git.headContains(input.root.value, mergeCommitSha);
            if (!containment.ok) {
              return [
                makeFailure(containment.code, {
                  mergeCommitSha,
                  reason: containment.message,
                }),
              ];
            }
            if (!containment.value.contained) {
              return [
                makeFailure('merged_delivery_not_contained', {
                  mergeCommitSha,
                  headSha: facts.headSha,
                }),
              ];
            }
            mergedRecord = true;
            return [];
          }
        }
        return [makeFailure('branch_mismatch')];
      }
      if (binding!.context.kind === 'worktree') {
        const expectedLabel = binding!.context.label;
        if (facts.isLinkedWorktree !== true || facts.worktreeLabel !== expectedLabel) {
          return [makeFailure('worktree_mismatch')];
        }
        const entry = facts.worktrees.find((w) => w.label === expectedLabel);
        if (!entry || entry.branch !== binding!.context.branch) {
          return [makeFailure('worktree_mismatch')];
        }
      }
      return [];
    }));

  let repoRef: RepoRef | null = null;
  const g5 =
    g4 &&
    (await runGate('origin', () => {
      const facts = factsState.value;
      if (!facts || facts.originUrl === null) {
        return [makeFailure('no_origin')];
      }
      const parsed = parseRepoRef(
        facts.originUrl,
        input.gitlabHost !== undefined ? { gitlabHost: input.gitlabHost } : {}
      );
      if (!parsed.ok) {
        // 88-6 (g5 folding): the origin gate reports the classification
        // that was actually made — a GitLab origin fails as
        // gitlab_unsupported (factual, exit 1), never folded into
        // origin_unresolvable with GitHub-pointing advice.
        return [makeFailure(parsed.code === 'gitlab_unsupported' ? 'gitlab_unsupported' : 'origin_unresolvable')];
      }
      // #112 (platform routing): the origin resolved through the
      // providers.yaml GitLab declaration (platform marker on the ref —
      // the substring heuristic never resolves one). Evaluation evidence
      // flows through gh only today, so the GitLab route fails closed
      // here, factually: the declaration and the nested-group grammar
      // are accepted, the glab provider is not implemented yet. No gh
      // call ever sees a group/subgroup ref.
      const routedEv = requireGithubRoute(parsed);
      if (!routedEv.ok) {
        const routed = makeFailure(routedEv.code);
        routed.message = routedEv.message;
        routed.fix = routedEv.fix;
        return [routed];
      }
      repoRef = parsed.value;
      evidence.repo = formatRepoRef(parsed.value);
      return [];
    }));

  const gh = input.gh;
  const ready = g5 && binding !== null && policy !== null && repoRef !== null;

  const g6 =
    ready &&
    gh !== undefined &&
    (await runGate('provider', async () => {
      const preflight = await gh.preflight();
      if (!preflight.ok) {
        return [makeFailure(preflight.code)];
      }
      return [];
    }));

  const g7 =
    g6 &&
    (await runGate('issues', async () => {
      const failures: GateFailure[] = [];
      for (const issueNumber of binding!.issues) {
        const issue = await gh!.getIssue(repoRef!, issueNumber);
        if (!issue.ok) {
          if (issue.code === 'issue_not_found') {
            failures.push(makeFailure('issue_not_found', { issue: issueNumber }));
            continue;
          }
          failures.push(makeFailure(issue.code));
          break;
        }
        if (issue.value.pullRequest) {
          failures.push(makeFailure('issue_is_pull_request', { issue: issueNumber }));
        }
      }
      return failures;
    }));

  const prState: { fact: PrFact | null } = { fact: null };
  const currentPrFact = (): PrFact | null => prState.fact;

  // G7.5 sequencing: with ordered_issues on, no open issue may precede the
  // delivery's smallest bound issue — deliveries merge in ascending issue
  // order. Off (the default), the gate passes without any provider call so
  // the verdict stays complete.
  const sequencingOn = g7 && policy !== null && policy.ordered_issues === true;
  if (sequencingOn) {
    await runGate('sequence', async () => {
      const open = await gh!.getOpenIssueNumbers(repoRef!);
      if (!open.ok) {
        return [makeFailure(open.code)];
      }
      const first = Math.min(...binding!.issues);
      const earlier = open.value.filter((n) => n < first).sort((a, b) => a - b);
      if (earlier.length > 0) {
        return [
          makeFailure('issue_out_of_order', {
            earliestBound: first,
            openEarlier: earlier.slice(0, 20),
          }),
        ];
      }
      return [];
    });
  } else if (g7) {
    results.set('sequence', []);
  }

  const g8 =
    g7 &&
    (await runGate('pr', async () => {
      let queryRef: number | string;
      const bound = binding!.pr!;
      if (typeof bound === 'number') {
        queryRef = bound;
      } else {
        const parsedUrl = parsePrUrl(bound);
        if (parsedUrl.ok) {
          if (!sameRepoRef(parsedUrl.value.repo, repoRef!)) {
            return [
              makeFailure('pr_repo_mismatch', {
                prRepo: formatRepoRef(parsedUrl.value.repo),
                originRepo: formatRepoRef(repoRef!),
              }),
            ];
          }
          queryRef = parsedUrl.value.pr;
        } else {
          queryRef = bound;
        }
      }

      const pr = await gh!.getPr(repoRef!, queryRef);
      if (!pr.ok) {
        return [makeFailure(pr.code === 'pr_not_found' ? 'pr_not_found' : pr.code, { pr: bound })];
      }
      prState.fact = pr.value;
      evidence.pr = pr.value.number;
      evidence.prHead = pr.value.headSha || null;

      const failures: GateFailure[] = [];
      if (pr.value.state === 'closed') {
        failures.push(makeFailure('pr_closed_unmerged', { pr: pr.value.number }));
      }
      // A draft is a platform-level unmergeable state that never
      // auto-transitions: green checks over a draft are still not done.
      if (pr.value.draft) {
        failures.push(makeFailure('pr_draft', { pr: pr.value.number }));
      }
      if (pr.value.headBranch !== binding!.context.branch) {
        failures.push(
          makeFailure('pr_head_mismatch', {
            prHead: pr.value.headBranch,
            boundBranch: binding!.context.branch,
          })
        );
      }
      return failures;
    }));

  const g9 =
    g8 &&
    (await runGate('closing', () => {
      const closed = parseClosingRefs(currentPrFact()!.body);
      const missing = binding!.issues.filter((n) => !closed.has(n));
      if (missing.length > 0) {
        return [makeFailure('closing_refs_incomplete', { missing })];
      }
      return [];
    }));

  const prFactValue = g8 ? currentPrFact() : null;
  const factsValue = factsState.value;

  if (
    g9 &&
    factsValue !== null &&
    factsValue.headSha !== null &&
    prFactValue !== null &&
    prFactValue.headSha &&
    factsValue.headSha !== prFactValue.headSha
  ) {
    warnings.push({
      severity: 'warning',
      code: 'local_head_stale',
      message: CODE_INFO.local_head_stale.message,
      fix: CODE_INFO.local_head_stale.fix,
    });
  }

  if (g9 && gh !== undefined) {
    await runGate('checks', async () => {
      const runs = await gh.getCheckRuns(repoRef!, prFactValue!.headSha);
      if (!runs.ok) {
        return [makeFailure(runs.code)];
      }
      const failures: GateFailure[] = [];
      for (const requiredName of policy!.required_checks) {
        // #119: re-runs keep every same-name run in the Checks API. The
        // truth run is the latest by started_at, ties broken by the
        // higher check-run id (docs/reference.md, Checks G11); response
        // position is never evidence.
        const run = truthRun(runs.value, requiredName);
        if (!run) {
          failures.push(makeFailure('checks_missing', { name: requiredName }));
          continue;
        }
        if (run.status !== 'completed') {
          const pending = makeFailure('checks_pending', {
            name: requiredName,
            status: run.status,
          });
          // Honest diagnostics (#68): the message names the check and its
          // live status so pending reads as a specific, transient state.
          pending.message = `${pending.message} [check: ${requiredName}, status: ${run.status}]`;
          failures.push(pending);
          continue;
        }
        if (run.conclusion !== 'success') {
          const failed = makeFailure('checks_failed', {
            name: requiredName,
            conclusion: run.conclusion,
          });
          failed.message = `${failed.message} [check: ${requiredName}, conclusion: ${run.conclusion}]`;
          failures.push(failed);
        }
      }
      return failures;
    });
  }

  const gates: GateResult[] = GATE_ORDER.map((id) => {
    const failures = results.get(id);
    if (failures === undefined) {
      // A merged record on main has no live delivery gates left to run —
      // mark them passed-by-history rather than skipped so the verdict is
      // complete.
      if (mergedRecord) {
        return { id, status: 'pass', failures: [] };
      }
      return { id, status: 'skipped', failures: [] };
    }
    return { id, status: failures.length > 0 ? 'fail' : 'pass', failures };
  });

  const allFailures = [...results.values()].flat();
  const evaluatedAll = mergedRecord || GATE_ORDER.every((id) => results.has(id));
  const evidenceBlocked = allFailures.some((f) => isEvidenceKind(f.code));
  const classification: VerdictClassification = evidenceBlocked
    ? 'unknown'
    : allFailures.length > 0
      ? 'rejected'
      : evaluatedAll && gh !== undefined
        ? 'accepted'
        : 'unknown';

  const recordComplete =
    binding !== null && binding.issues.length > 0 && binding.pr !== undefined;

  let state: DeliveryState;
  if (!input.record.ok) {
    state = input.record.code === 'record_missing' ? 'unbound' : 'unknown';
  } else if (!recordComplete) {
    state = 'draft';
  } else if (classification === 'accepted') {
    state = 'accepted';
  } else if (classification === 'rejected') {
    state = 'rejected';
  } else {
    state = 'bound';
  }

  const exitCode: 0 | 1 | 3 = classification === 'accepted' ? 0 : classification === 'rejected' ? 1 : 3;

  if (mergedRecord && classification === 'accepted') {
    warnings.push({
      severity: 'warning',
      code: 'record_of_merged_delivery',
      message: 'This record belongs to a delivery whose pull request is already merged.',
      fix: 'Run "specgit unbind --yes" to remove the completed record.',
    });
  }

  return {
    accepted: classification === 'accepted',
    state,
    classification,
    exitCode,
    complete: evaluatedAll && gh !== undefined,
    gates,
    evidence,
    warnings,
  };
}
