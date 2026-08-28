/**
 * `specgit status` — local evidence only (G1-G5), zero network.
 *
 * Reports the record, the derived binding state, the live execution
 * context, upstream drift, the origin, and the three-tier state/asset
 * taxonomy (#69). The GitHub provider is never consulted; spec/task
 * artifacts are not inputs — only the record, the policy, and live git
 * facts.
 *
 * Exit codes follow the normative table: 0 when the record and the policy
 * are locally valid and git facts could be gathered; 2 usage; 3 fail-closed
 * (not a git repo, git unavailable, or the record/policy is invalid). One
 * pre-binding exception (#175): a MISSING record is the normal state before
 * `specgit issue` — a fully determinable, healthy snapshot — so it exits 0
 * with state `unbound` instead of the fail-closed unknown. Factual
 * mismatches (branch mismatch, drift, unresolved origin) are reported
 * through failing gates without failing the run.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import {
  completenessGate,
  contextGate,
  deriveLifecycleState,
  originGate,
  policyGate,
  recordGate,
  trackedIncludes,
} from '../gates.js';
import {
  errorDiagnostic,
  gateFailureLine,
  humanBuilder,
  issueList,
  type StatusOutcome,
} from '../output.js';
import { STATE_ASSET_TAXONOMY } from '../state-taxonomy.js';
import { catalogFor, resolveLanguage } from '../language.js';
import {
  inspectGeneratedAssets,
  renderGeneratedAssetsHuman,
  type GeneratedAssetsReport,
} from '../asset-drift.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import { RECORD_FILENAME, type CommandContext, type Evidence, type GateResult, type GitFacts, type Policy } from '../types.js';

export interface StatusOptions {
  json?: boolean;
}

/**
 * The #308 generated-asset drift report for one status snapshot, or the
 * warning that explains why none could be computed. Read-only by
 * construction: a failure here is factual evidence riding a warning — it
 * never turns an otherwise computable snapshot into exit 3.
 */
async function generatedAssetReport(
  root: string,
  ctx: CommandContext,
  policy: Evidence<Policy>,
  facts: GitFacts
): Promise<{ report: GeneratedAssetsReport | null; warning: Diagnostic | null }> {
  try {
    return { report: await inspectGeneratedAssets({ root, ctx, policy, facts }), warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      report: null,
      warning: {
        severity: 'warning',
        code: 'asset_inspection_failed',
        message: `The generated-asset drift report could not be computed: ${message}`,
        fix: 'Re-run status once the named path is readable; drift inspection is read-only and never blocks the snapshot.',
      },
    };
  }
}

/** The taxonomy plus the drift report when one was computed (#308). */
function assetsWith(report: GeneratedAssetsReport | null): Record<string, unknown> {
  return report === null
    ? { ...STATE_ASSET_TAXONOMY }
    : { ...STATE_ASSET_TAXONOMY, generated: report };
}

export async function runStatus(
  _options: StatusOptions,
  ctx: CommandContext
): Promise<StatusOutcome> {
  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const [recordEv, policyEv, facts] = await Promise.all([
    ctx.record.readRecord(root),
    ctx.record.readPolicy(root),
    ctx.git.facts(root),
  ]);

  if (!recordEv.ok) {
    if (recordEv.code === 'record_missing') {
      // Pre-binding is a determinable, healthy state, not a fail-closed
      // unknown (#175): exit 0, state `unbound`, the record gate still
      // reports `record_missing`, and the next step rides a warning.
      const { human: text } = catalogFor(resolveLanguage(policyEv.ok ? policyEv.value : null));
      const generated = await generatedAssetReport(root, ctx, policyEv, facts);
      const warnings: Diagnostic[] = [
        {
          severity: 'warning',
          code: recordEv.code,
          message: recordEv.message,
          ...(recordEv.fix !== undefined ? { fix: recordEv.fix } : {}),
        },
      ];
      if (generated.warning !== null) {
        warnings.push(generated.warning);
      }
      return {
        exit: EXIT_SUCCESS,
        state: 'unbound',
        gates: [recordGate(recordEv)],
        evidence: { root, branch: facts.branch },
        warnings,
        assets: assetsWith(generated.report),
        human: humanBuilder()
          .line(text.statusUnbound())
          .append(renderGeneratedAssetsHuman(generated.report, text))
          .build(),
      };
    }
    return {
      exit: EXIT_UNKNOWN,
      state: 'unknown',
      gates: [recordGate(recordEv)],
      errors: [
        errorDiagnostic(recordEv.code, recordEv.message, recordEv.fix ? { fix: recordEv.fix } : {}),
      ],
    };
  }
  const record = recordEv.value;
  const { human: text } = catalogFor(resolveLanguage(policyEv.ok ? policyEv.value : null));

  const gates: GateResult[] = [
    recordGate(recordEv),
    policyGate(policyEv),
    completenessGate(record),
    contextGate(record, facts),
  ];
  const origin = await originGate(facts, ctx.parseRepoRef);
  gates.push(origin.gate);

  // #351: the merged-history signal is a read-only tracked-file probe —
  // advisory like every #298 probe: a failed probe degrades to today's
  // plain state naming, never blocks the snapshot.
  const trackedEv = await ctx.git.trackedFiles(root, [RECORD_FILENAME]);
  const recordTracked = trackedIncludes(trackedEv, RECORD_FILENAME);
  const state = deriveLifecycleState(record, facts, recordTracked);
  const historical = state === 'historical-candidate';
  const historicalWarning: Diagnostic | null = historical
    ? {
        severity: 'warning',
        code: 'record_historical_candidate',
        message: `This record names branch '${record.context.branch}' but is tracked on '${facts.branch}' — the local signature of a merged delivery's history.`,
        fix: 'Run "specgit finish" to confirm the merged lineage (it reads the pull request), or start the next delivery: specgit issue "<type>: <title>" atomically replaces this record.',
      }
    : null;
  const evidence: Record<string, unknown> = {
    root,
    repo: origin.repo,
    delivery: record.delivery,
    context: record.context,
    branch: facts.branch,
    issues: record.issues,
    pr: record.pr,
    dirty: facts.dirty,
    drift: facts.upstreamDrift,
  };

  // Fail-closed axis (#69): exit 0 requires the record AND the policy to be
  // locally valid and the git facts to have been gathered. Evidence
  // mismatches (branch, origin, completeness) stay informational here.
  const failClosedErrors: Diagnostic[] = [];
  if (!policyEv.ok) {
    failClosedErrors.push(
      errorDiagnostic(policyEv.code, policyEv.message, policyEv.fix ? { fix: policyEv.fix } : {})
    );
  }
  if (!facts.gitAvailable) {
    failClosedErrors.push(
      errorDiagnostic('git_unavailable', 'The git executable could not be spawned.', {
        fix: 'Install git and ensure it is on PATH.',
      })
    );
  }
  if (failClosedErrors.length > 0) {
    return {
      exit: EXIT_UNKNOWN,
      state,
      gates,
      errors: failClosedErrors,
      assets: STATE_ASSET_TAXONOMY as unknown as Record<string, unknown>,
      human: humanBuilder()
        .line(text.statusDelivery(record.delivery, state))
        .append(
          gates.flatMap((gate) =>
            gate.failures.map((failure) => gateFailureLine(gate.id, failure.code, failure.fix))
          )
        )
        .build(),
    };
  }

  // #308: the drift report is factual local evidence — computed for every
  // computable snapshot, surfaced through `assets.generated` and the human
  // drift lines, and never an exit-code input.
  const generated = await generatedAssetReport(root, ctx, policyEv, facts);

  const human = humanBuilder()
    .line(text.statusDelivery(record.delivery, state))
    .append(historical ? [text.statusHistoricalCandidate(record.context.branch)] : [])
    .line(
      record.context.kind === 'worktree'
        ? text.statusContextWorktree(record.context.label, record.context.branch)
        : text.statusContextBranch(record.context.branch)
    )
    .line(
      record.issues.length > 0
        ? text.statusIssues(issueList(record.issues))
        : text.statusIssuesNone()
    )
    .line(record.pr !== undefined ? text.statusPr(record.pr) : text.statusPrNone())
    .line(origin.repo !== null ? text.statusRepository(origin.repo) : text.statusRepositoryUnresolved())
    .line(facts.branch !== null ? text.statusLiveBranch(facts.branch) : text.statusLiveBranchDetached())
    .line(
      'Assets: authoritative delivery files (spec_git/policy.yaml, spec_git/providers.yaml, .specgit.yaml; shielded in .gitignore by default, carried by the binding commit) · derived committed harness (regenerate via init --force) · local integration (setup entry points)'
    )
    .append(renderGeneratedAssetsHuman(generated.report, text))
    .append(
      gates.flatMap((gate) =>
        gate.failures.map((failure) => gateFailureLine(gate.id, failure.code, failure.fix))
      )
    )
    .build();

  const warnings = [historicalWarning, generated.warning].filter(
    (warning): warning is Diagnostic => warning !== null
  );

  return {
    exit: EXIT_SUCCESS,
    state,
    gates,
    evidence,
    ...(warnings.length > 0 ? { warnings } : {}),
    assets: assetsWith(generated.report),
    human,
  };
}
