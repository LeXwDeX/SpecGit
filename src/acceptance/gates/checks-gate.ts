import type { CheckRunInfo } from '../../github/port.js';
import { isLaterCheckRun } from '../../github/check-runs.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

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
    if (best === undefined || isLaterCheckRun(run, best)) best = run;
  }
  return best;
}

/**
 * #315: whether the truth run predates the evidence anchor. A null or
 * unparseable started_at is treated as oldest (the CheckRunInfo
 * contract); an unparseable anchor also reads as stale — a broken
 * boundary fails toward protection instead of silently lifting it.
 * The boundary is inclusive: a run started exactly at the anchor is
 * fresh.
 */
function predatesAnchor(run: CheckRunInfo, anchor: string): boolean {
  if (run.startedAt === null) return true;
  const boundary = Date.parse(anchor);
  if (Number.isNaN(boundary)) return true;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return true;
  return started < boundary;
}

/**
 * #315: fetch the evidence anchor for the bound pull request. Three
 * states: an ISO string enforces the freshness boundary; null (or a
 * fact without the field) means the provider sets no boundary and the
 * verdict keeps its pre-#315 shape; a failed Evidence fails closed
 * with the provider's own code (an evidence-class diagnostic).
 */
async function fetchAnchor(
  ctx: GateContext
): Promise<{ anchor: string | null; failure?: undefined } | { anchor?: undefined; failure: GateFailure }> {
  const forge = ctx.input.gh!;
  // Runtime guard: doubles that predate the member behave as "no
  // boundary" — byte-for-byte the pre-#315 verdict. Typed providers
  // implement it; the port member is required (#80 discipline).
  if (typeof forge.getEvidenceAnchor !== 'function') return { anchor: null };
  const evidence = await forge.getEvidenceAnchor(ctx.repoRef!, ctx.prFact!.number);
  if (!evidence.ok) return { failure: makeFailure(evidence) };
  return {
    anchor: typeof evidence.value.anchoredAt === 'string' ? evidence.value.anchoredAt : null,
  };
}

/**
 * Gate 11 — checks: every policy-required check ran green at the PR
 * head. The walk only reaches this gate when a forge provider is
 * present (see `GATE_FNS` in `index.ts`).
 */
export async function checksGate(ctx: GateContext): Promise<GateFailure[]> {
  const runs = await ctx.input.gh!.getCheckRuns(ctx.repoRef!, ctx.prFact!.headSha, ctx.prFact!.number);
  if (!runs.ok) {
    return [makeFailure(runs)];
  }
  // #315: the freshness boundary is read before any conclusion
  // evaluation — a truth run that wholly predates the anchor pends,
  // whatever its conclusion says.
  const { anchor, failure: anchorFailure } = await fetchAnchor(ctx);
  if (anchorFailure) return [anchorFailure];
  // #269: diagnostic prose is the greppable surface — on a declared
  // GitLab origin the platform's CI is a GitLab pipeline, never GitHub
  // Actions, so the checks_missing fix is GitLab-shaped there.
  const onGitLab = ctx.input.gitlabHost !== undefined;
  const failures: GateFailure[] = [];
  for (const requiredName of ctx.policy!.required_checks) {
    // #119: re-runs keep every same-name run in the Checks API. The
    // truth run is the latest by started_at, ties broken by the
    // higher check-run id (docs/reference.md, Checks G11); response
    // position is never evidence.
    const run = truthRun(runs.value, requiredName);
    if (!run) {
      const missing = makeFailure('checks_missing', { name: requiredName });
      if (onGitLab) {
        missing.fix = 'Ensure the required GitLab CI pipeline runs on the MR head commit.';
      }
      failures.push(missing);
      continue;
    }
    // #315: anchored freshness — the truth run must start at or after
    // the evidence anchor. A run that finished before the delivery
    // became reviewable is not acceptance evidence, so it pends
    // (factual, transient) regardless of conclusion; a fresh run
    // started after the anchor clears it.
    if (anchor !== null && predatesAnchor(run, anchor)) {
      const stale = makeFailure('checks_pending', {
        name: requiredName,
        startedAt: run.startedAt,
        anchoredAt: anchor,
      });
      stale.message = `A required check's truth run predates the evidence anchor [check: ${requiredName}, started: ${run.startedAt ?? 'unknown'}, anchor: ${anchor}]`;
      stale.fix =
        'A finished run never becomes fresh by waiting: re-run the required check on the pull request head (re-running is safe and idempotent), then run "specgit accept" again.';
      failures.push(stale);
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
      // #116 (D-4″, ledger row 17): a failed `allow_failure` job
      // keeps the pipeline green. The fact above still reports the
      // truthful failure — the gate verdict follows the pipeline,
      // and only failure is affected: every other conclusion
      // (cancelled, timed out, …) still fails, allowed or not.
      if (!(run.conclusion === 'failure' && run.allowFailure === true)) {
        const failed = makeFailure('checks_failed', {
          name: requiredName,
          conclusion: run.conclusion,
        });
        failed.message = `${failed.message} [check: ${requiredName}, conclusion: ${run.conclusion}]`;
        failures.push(failed);
      }
    }
  }
  return failures;
}
