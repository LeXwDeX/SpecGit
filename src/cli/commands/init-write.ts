/**
 * Mutation phase of `specgit init` (#305): the harness write, the policy
 * write, and the local-asset ignore write reconcile as ONE reversible
 * transaction — a failure at any step rolls every prior local mutation
 * back to its pre-run bytes and mode, so an upgrade can never leave a
 * mixed-version tree. Remote mutation (branch protection) still happens
 * last and only when explicitly requested.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import {
  buildHarnessDesiredState,
  harnessResultFrom,
  legacyGitHooksDir,
  type HarnessDesiredState,
  type HarnessWriteResult,
} from '../harness-placement.js';
import {
  ManagedReconcileError,
  reconcileManagedAssets,
  type ManagedReconcileReport,
  type ManagedStep,
} from '../managed-reconcile.js';
import {
  detailLine,
  errorDiagnostic,
  humanBuilder,
  renderNextActionsHuman,
  type InitOutcome,
  type NextAction,
} from '../output.js';
import { trackedIncludes } from '../gates.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { HumanText } from '../language.js';
import { POLICY_FILENAME, SPEC_GIT_DIR, type CommandContext, type Policy } from '../types.js';
import {
  LOCAL_ASSET_IGNORE_ENTRIES,
  reconcileLocalAssetIgnore,
  type LocalAssetIgnoreResult,
} from './init-ignore.js';
import type { DetectionReport } from '../detect-checks.js';
import type { PolicyLanguage } from '../../record/policy.js';
import type { PlatformOutcome } from './init-platform.js';
import type { ProtectionOutcome } from './init-protection.js';

const POLICY_PATH = `${SPEC_GIT_DIR}/${POLICY_FILENAME}`;
const IGNORE_PATH = '.gitignore';

export interface HarnessAndPolicyWrite {
  harness: HarnessWriteResult;
  policy: Policy;
  /** #292: null when --no-ignore skipped the local-asset shielding. */
  ignore: LocalAssetIgnoreResult | null;
  /** #305: what the reconciliation transaction did (created/updated/removed/preserved). */
  reconciled: ManagedReconcileReport;
}

/**
 * Write the harness (workflow, hooks, managed prompt block — merged with
 * existing hooks), the policy, and the managed `.gitignore` region inside
 * one managed-asset reconciliation transaction (#305): every target is
 * snapshotted, a mid-transaction failure restores the whole pre-run tree,
 * and obsolete SpecGit-owned assets (a wrong-platform workflow) are
 * removed only with proven ownership. The git hook goes where git actually
 * runs hooks from: worktree and core.hooksPath aware, with a legacy
 * `.git/hooks` fallback; when neither resolves, the git hook is skipped.
 */
export async function writeHarnessAndPolicy(args: {
  root: string;
  ctx: CommandContext;
  checks: string[];
  language: PolicyLanguage;
  /** Validated prior policy: preserve fields the init options do not replace. */
  existingPolicy?: Policy;
  automation: NonNullable<Policy['automation']>;
  validation?: Policy['validation'];
  tags?: Policy['tags'];
  /** null in GitLab mode: a GitHub Actions workflow would be wrong-platform output. */
  workflowYaml: string | null;
  /** false (--no-ignore) skips the local-asset .gitignore block (#292). */
  writeIgnore: boolean;
  warnings: Diagnostic[];
}): Promise<InitOutcome | HarnessAndPolicyWrite> {
  const { root, ctx, checks, language, workflowYaml, warnings } = args;

  const resolveHooksDir = async (repoRoot: string): Promise<string | null> => {
    const hooksEv = await ctx.git.hooksPath(repoRoot);
    if (hooksEv.ok) {
      return hooksEv.value;
    }
    return legacyGitHooksDir(repoRoot);
  };

  // ---- Plan the harness desired state (reads + merges, no writes). ----
  let desired: HarnessDesiredState;
  try {
    desired = await buildHarnessDesiredState(root, { resolveHooksDir, workflowYaml, language });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('harness_content_failed', message)],
    };
  }
  for (const warning of desired.warnings) {
    warnings.push({ severity: 'warning', ...warning });
  }

  const policy: Policy = {
    ...args.existingPolicy,
    version: 1 as const,
    required_checks: checks,
    automation: args.automation,
    ...(args.validation !== undefined ? { validation: args.validation } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(language !== 'en' ? { language } : {}),
  };
  if (language === 'en') delete policy.language;
  // #298: probe BEFORE the rewrite — a tracked policy rewritten by
  // --force shows as an uncommitted modification until committed; warn
  // instead of leaving silent residue. Advisory, never a block.
  const policyTrackedEv = await ctx.git.trackedFiles(root, [POLICY_PATH]);
  const policyWasTracked = trackedIncludes(policyTrackedEv, POLICY_PATH);

  // ---- One transaction: harness → policy port write → ignore region. ----
  const steps: ManagedStep[] = [
    ...desired.steps,
    {
      kind: 'portWrite',
      path: POLICY_PATH,
      write: () => ctx.record.writePolicy(root, policy),
    },
  ];
  if (args.writeIgnore) {
    steps.push({
      kind: 'write',
      path: IGNORE_PATH,
      mode: 0o644,
      merge: (existing) => reconcileLocalAssetIgnore(existing),
    });
  }

  let report: ManagedReconcileReport;
  try {
    report = await reconcileManagedAssets(root, { steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The failing step decides the diagnostic: the policy port write and
    // the ignore write have their own codes; harness steps keep the #280
    // plan/commit distinction.
    const step = error instanceof ManagedReconcileError ? error.step : null;
    let code: string;
    if (step?.path === POLICY_PATH) {
      code = 'policy_write_failed';
    } else if (step?.path === IGNORE_PATH) {
      code = 'ignore_write_failed';
    } else if (error instanceof ManagedReconcileError && error.phase === 'plan') {
      code = 'harness_content_failed';
    } else {
      code = 'harness_write_failed';
    }
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(code, message)],
    };
  }

  if (policyWasTracked) {
    warnings.push({
      severity: 'warning',
      code: 'policy_rewrite_tracked',
      message: `${POLICY_PATH} is tracked by git — this rewrite shows as an uncommitted modification until it is committed.`,
      fix: 'Carry the policy with the delivery (the bootstrap binding commit force-stages it), or discard the rewrite if it was explorative.',
    });
  }
  // #305: a removal candidate we could not prove ownership for is
  // preserved verbatim — surfaced, never silently dropped.
  for (const path of report.preserved) {
    warnings.push({
      severity: 'warning',
      code: 'unowned_asset_preserved',
      message: `${path} is not provably SpecGit-owned (no managed markers in its content); left untouched.`,
      fix: 'If it is a leftover SpecGit artifact, remove it manually; otherwise it is yours to keep.',
    });
  }

  const ignore: LocalAssetIgnoreResult | null = args.writeIgnore
    ? {
        path: IGNORE_PATH,
        entries: [...LOCAL_ASSET_IGNORE_ENTRIES],
        created: report.created.includes(IGNORE_PATH),
      }
    : null;

  return {
    harness: harnessResultFrom(desired, report),
    policy,
    ignore,
    reconciled: report,
  };
}

/**
 * #352: the adoption hand-off. `init` succeeding is not adoption
 * completing — the harness exists only in the working tree until a
 * commit carries it to the default branch. The steps name the one trap
 * (the policy is gitignored by default, so a plain `git add` silently
 * skips it) and the moment protection becomes safe (after the adoption
 * PR merges). Codes and commands are the machine contract (verbatim);
 * the localized reasons come from the language catalog. A declared
 * GitLab platform drops the gh-only protection step and speaks glab.
 */
function adoptionNextActions(gitlab: boolean, text: HumanText): NextAction[] {
  const spec: Array<[string, string]> = [
    ['adoption_branch', 'git checkout -b specgit-adoption'],
    [
      'adoption_commit',
      `git add -A && git add -f spec_git/policy.yaml${gitlab ? ' spec_git/providers.yaml' : ''} && git commit -m "chore: adopt SpecGit"`,
    ],
    [
      'adoption_pr',
      gitlab
        ? 'git push -u origin specgit-adoption && glab mr create --fill'
        : 'git push -u origin specgit-adoption && gh pr create --fill',
    ],
    ...(gitlab ? [] : [['adoption_protect', 'specgit init --force --protect'] as [string, string]]),
    ['adoption_setup', 'specgit setup && specgit doctor && specgit status'],
  ];
  // Keyed by step code, never positional: the localized reasons and the
  // command list cannot drift out of alignment by reordering.
  const reasonFor = text.initAdoptionReasons(gitlab);
  return spec.map(([code, command]) => ({
    code,
    command,
    reason: reasonFor[code] ?? '',
  }));
}

/** Assemble the success envelope and human summary for a completed init. */
export function buildInitOutcome(args: {
  checks: string[];
  detected: DetectionReport | null;
  /** #310: how `checks` was selected — explicit | existing | detected. */
  provenance: 'explicit' | 'existing' | 'detected';
  platform: { outcome: PlatformOutcome; human: string[] };
  harness: HarnessWriteResult;
  policy: Policy;
  ignore: LocalAssetIgnoreResult | null;
  reconciled: ManagedReconcileReport;
  template: string;
  warnings: Diagnostic[];
  protection: ProtectionOutcome | undefined;
  protectionHuman: string[];
  /** #352: false on a fresh adoption (harness not yet tracked) — emit the adoption nextActions. */
  adopted: boolean;
  text: HumanText;
}): InitOutcome {
  const {
    checks,
    detected,
    provenance,
    platform,
    harness,
    policy,
    ignore,
    reconciled,
    template,
    warnings,
    protection,
    protectionHuman,
    adopted,
    text,
  } = args;
  const builder = humanBuilder()
    .line(text.initCreatedPolicy(`${SPEC_GIT_DIR}/${POLICY_FILENAME}`))
    .append(ignore ? [text.initIgnoredAssets(ignore.path)] : [])
    // #310: an upgrade says it preserved the checks (and names the
    // replacement path); a fresh init or an explicit list does not.
    .append(provenance === 'existing' ? [text.initPreservedChecks()] : [])
    .line(text.initRequiredChecks(checks.length))
    .append(checks.map((name) => text.initCheck(name)))
    .append(platform.human);
  if (detected !== null) {
    builder
      .line(text.initDetectedPlatform(detected.platform))
      .append(detected.sources.map((s) => text.initDetectedSource(s)))
      .append(
        detected.nonPrWorkflows.map((s) => detailLine(`skipped, never runs on a PR head: ${s}`))
      )
      .append(
        detected.ambiguousJobs.map((s) =>
          detailLine(`excluded, check-run name not statically provable: ${s}`)
        )
      );
  }
  builder
    // #269: a skipped workflow write (GitLab platform mode) claims
    // nothing — the gitlab_harness_pending warning is the only statement.
    .append(harness.workflow ? [text.initCreatedHook(harness.workflow)] : [])
    .append(harness.hooks.map((hookPath) => text.initCreatedHook(hookPath)))
    .append(harness.gitHook ? [text.initGitHook(harness.gitHook)] : [])
    .append(harness.prompts.map((filename) => text.initManagedRefreshed(filename)))
    // #305: convergence speaks for itself — removed owned assets and
    // preserved unowned ones are the upgrade decisions a user audits.
    .append(reconciled.removed.map((path) => text.initRemovedAsset(path)))
    .append(reconciled.preserved.map((path) => text.initPreservedAsset(path)))
    .append(protectionHuman);
  // #352/#360: a fresh adoption hands off the adoption steps — structured
  // in the envelope, the shared short-form renderer for humans — speaking
  // the platform's dialect. Built once, rendered twice.
  const nextActions = adopted ? null : adoptionNextActions(platform.outcome.mode === 'gitlab', text);
  if (nextActions !== null) {
    builder.append(renderNextActionsHuman(text.initNextAdoptionHeadline(), nextActions));
  }
  return {
    exit: EXIT_SUCCESS,
    policy,
    harness: { template },
    reconciled,
    platform: platform.outcome,
    ...(ignore !== null ? { ignore } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(protection !== undefined ? { protection } : {}),
    ...(nextActions !== null ? { nextActions } : {}),
    ...(detected !== null
      ? {
          detected: {
            platform: detected.platform,
            sources: detected.sources,
            nonPrWorkflows: detected.nonPrWorkflows,
            /** #310: jobs whose names detection could not prove (matrix/reusable). */
            ambiguousJobs: detected.ambiguousJobs,
            clis: detected.clis,
            fallback: checks.length === 0,
          },
        }
      : {}),
    human: builder.build(),
  };
}
