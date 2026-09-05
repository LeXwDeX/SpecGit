/**
 * `specgit init` — creates `spec_git/policy.yaml` and generates the
 * delivery harness: the CI acceptance workflow, the opencode guard hooks,
 * and the managed prompt block in the agent instruction files. The
 * harness generation is idempotent and merges with existing hooks. A current
 * plain init does not rewrite policy; explicit --force or guided consent does,
 * while preserving every omitted policy choice.
 *
 * Non-destructive contract (#62): every check that can reject the run —
 * input validation, `--gitlab-host` validation, `policy_exists`, and a
 * root-writability preflight — happens BEFORE any filesystem or remote
 * mutation. A validation-phase rejection or init-writer failure leaves the
 * repository byte-identical. The harness write itself is error-atomic (rolled
 * back on failure); the later setup phase is a separate transaction. Remote
 * mutation (branch protection) happens last and only when explicitly
 * requested (`--protect` or an interactive confirmation).
 *
 * Workflow template selection (#63): the SpecGit repository itself
 * (root package name `specgit`) keeps the local-build template — the
 * anti-drift lock pins it byte-exactly to this repo's own workflow.
 * Every other (adopting) repository gets the portable external template:
 * it installs the published CLI at the exact running version, sets up
 * only Node, parameterizes the default branch, and never assumes the
 * adopting project's toolchain, lockfile, layout, or build.
 *
 * Required-check selection (#310) happens in ONE seam after the existing
 * policy is known: explicit `--required-check` (repeatable) fully replaces
 * the list; a no-argument `init --force` PRESERVES a valid existing
 * policy's required checks and language while rebuilding the versioned
 * harness/config/ignore assets; only a fresh init (no policy yet)
 * auto-detects from the selected platform's CI config. GitHub reads job names
 * or ids from `.github/workflows/*.{yml,yaml}` and excludes the generated
 * SpecGit Acceptance job to avoid self-reference. Declared GitLab reads
 * top-level jobs from `.gitlab-ci.yml`; its project-owned MR acceptance job
 * remains the adopter's responsibility. Matrix, reusable, dynamic, and other
 * ambiguous shapes are reported rather than guessed. When no product CI exists,
 * the policy names zero checks (#63: a fabricated fallback would make the
 * verdict unsatisfiable); GitHub then relies on the protected generated
 * acceptance job, while GitLab relies on its reviewed project-owned job.
 *
 * Structure (#171): `runInit` below only orchestrates named steps; the
 * concerns live in focused modules — detection and validation in
 * `init-validation.ts`, platform resolution in `init-platform.ts`,
 * workflow template selection in `init-workflow.ts`, the harness and
 * policy write in `init-write.ts`, guided read/consent and setup composition in
 * `init-upgrade.ts`, and branch protection in `init-protection.ts`.
 */

import * as path from 'node:path';

import { EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import { catalogFor } from '../language.js';
import { SPEC_GIT_DIR, POLICY_FILENAME, type CommandContext } from '../types.js';
import {
  restoreManagedSnapshot,
  restoreManagedSnapshotIfCurrent,
  snapshotManagedFile,
  type Snapshot,
} from '../managed-reconcile.js';
import { providersPath } from '../../record/io.js';
import {
  ambiguousJobWarning,
  nonPrWorkflowWarning,
  policyGateOutcome,
  preflightRootWritable,
  preservedChecksWarning,
  resolveInitLanguage,
  resolveInitAutomation,
  resolveRequiredChecks,
  validateLanguageOption,
  validateAutomationOptions,
  type InitInteraction,
  type InitOptions,
} from './init-validation.js';
import { persistGitlabHost, platformSelectionHuman, resolvePlatformMode, validateGitlabHost } from './init-platform.js';
import { selectCompletionWorkflow, selectWorkflowYaml, validateGitlabCiConfig } from './init-workflow.js';
import {
  resolveProtectionDefaultBranch,
  setupBranchProtection,
  type ProtectionOutcome,
} from './init-protection.js';
import { HARNESS_WORKFLOW_PATH } from '../harness-placement.js';
import { trackedIncludes } from '../gates.js';
import { buildInitOutcome, writeHarnessAndPolicy } from './init-write.js';
import { resolveProjectRules, resolveRepairLabels } from './init-rules.js';
import { buildGitlabRoutingSteps, GitlabRoutingError } from '../gitlab-routing.js';
import { runSetup } from './setup.js';
import { finishGuidedUpgrade, guidedUpgradeDecision } from './init-upgrade.js';

export type { InitOptions } from './init-validation.js';

/**
 * #62 validation-phase rejections: every outcome returned here happens
 * before any filesystem or remote mutation, so a rejected init leaves
 * the repository byte-identical. The validated `--gitlab-host`
 * declaration is handed back for the mutation phase to persist.
 */
async function runValidationPhase(
  options: InitOptions,
  ctx: CommandContext,
  root: string,
  interaction: InitInteraction
): Promise<
  | InitOutcome
  | {
      declaredEndpoint: { host: string; port: string | null } | null;
      existingPolicy: Awaited<ReturnType<CommandContext['record']['readPolicy']>>;
      options: InitOptions;
      guidedUpgrade: boolean;
    }
> {
  // Validate the --gitlab-host declaration now; persist it only after the
  // policy_exists gate passes.
  let declaredEndpoint: { host: string; port: string | null } | null = null;
  if (options.gitlabHost !== undefined) {
    const declared = await validateGitlabHost(options, ctx, root);
    if ('exit' in declared) return declared;
    declaredEndpoint = declared;
  }

  const existingPolicy = await ctx.record.readPolicy(root);
  const guided = await guidedUpgradeDecision({ root, ctx, options, policy: existingPolicy, interaction });
  if ('outcome' in guided) return guided.outcome;
  const effectiveOptions: InitOptions = guided.upgrade
    ? {
        ...options,
        force: true,
        protect: false,
        ...(guided.preserveIgnoreOptOut ? { ignore: false } : {}),
      }
    : options;
  const policyGate = policyGateOutcome(existingPolicy, effectiveOptions);
  if (policyGate !== null) return policyGate;

  const writableError = await preflightRootWritable(root);
  if (writableError !== null) return writableError;

  return { declaredEndpoint, existingPolicy, options: effectiveOptions, guidedUpgrade: guided.upgrade };
}

export async function runInit(
  options: InitOptions,
  ctx: CommandContext,
  interaction: InitInteraction = {}
): Promise<InitOutcome> {
  // ---- Input validation (#62: before any mutation). ----
  const languageError = validateLanguageOption(options);
  if (languageError !== null) return languageError;
  const automationError = validateAutomationOptions(options);
  if (automationError !== null) return automationError;

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const validated = await runValidationPhase(options, ctx, root, interaction);
  if ('exit' in validated) return validated;
  const { declaredEndpoint, existingPolicy, options: effectiveOptions, guidedUpgrade } = validated;

  // Explicit inputs and preserved policy checks need no platform evidence.
  // Keep their usage errors ahead of the interactive platform question.
  const needsDetection = !existingPolicy.ok && effectiveOptions.detect !== false && (effectiveOptions.requiredCheck?.length ?? 0) === 0;
  const configuredChecks = needsDetection ? null : await resolveRequiredChecks(effectiveOptions, ctx, root, existingPolicy);
  if (configuredChecks !== null && 'exit' in configuredChecks) return configuredChecks;
  const warnings: Diagnostic[] = [];
  const platformSelection = await resolvePlatformMode(
    ctx, root, interaction, declaredEndpoint ?? undefined
  );
  if ('exit' in platformSelection) return platformSelection;
  const gitlabMode = platformSelection.outcome.mode === 'gitlab';

  // ---- Required-check selection (#310: one seam, after the existing
  // policy is known — still before any mutation). Explicit --required-check
  // replaces; a valid existing policy upgrades by preservation; only a
  // fresh init detects. ----
  const resolved = configuredChecks ?? await resolveRequiredChecks(effectiveOptions, ctx, root, existingPolicy, platformSelection.outcome.mode);
  if ('exit' in resolved) return resolved;
  const { checks, detected, provenance } = resolved;

  const initialLanguage = resolveInitLanguage(
    effectiveOptions,
    existingPolicy.ok ? existingPolicy.value.language : undefined
  );
  const rules = await resolveProjectRules(effectiveOptions, ctx, root, initialLanguage,
    existingPolicy.ok ? existingPolicy.value : undefined, interaction,
    platformSelection.outcome.gitlabHost);
  if ('exit' in rules) return rules;
  const { language } = rules;
  const automation = await resolveInitAutomation(effectiveOptions, ctx, root, language, interaction,
    existingPolicy.ok ? existingPolicy.value : undefined);
  if ('exit' in automation) return automation;
  const repair = await resolveRepairLabels(effectiveOptions, ctx, {
    ...(existingPolicy.ok ? existingPolicy.value : {}), version: 1, required_checks: checks, language,
    validation: rules.validation ?? (existingPolicy.ok ? existingPolicy.value.validation : undefined),
    tags: rules.tags ?? (existingPolicy.ok ? existingPolicy.value.tags : undefined),
    automation: automation.automation,
  }, interaction, existingPolicy.ok ? existingPolicy.value.automation?.repair_labels : undefined);
  if ('exit' in repair) return repair;
  const completion = await selectCompletionWorkflow(ctx, root, platformSelection.outcome.mode, automation.automation.merge);
  if (!completion.ok) {
    return { exit: EXIT_UNKNOWN, errors: [errorDiagnostic(completion.code, completion.message,
      completion.fix ? { fix: completion.fix } : {})] };
  }
  if (completion.value?.platform === 'gitlab') {
    const configurationError = await validateGitlabCiConfig(ctx, root, platformSelection.outcome.gitlabHost);
    if (configurationError !== null) return configurationError;
  }
  let routingSteps;
  try {
    routingSteps = await buildGitlabRoutingSteps(root, completion.value?.routingYaml ?? null);
  } catch (error) {
    return { exit: error instanceof GitlabRoutingError ? EXIT_USAGE : EXIT_UNKNOWN,
      errors: [errorDiagnostic(error instanceof GitlabRoutingError ? error.code : 'gitlab_ci_unreadable',
        error instanceof Error ? error.message : String(error), {
          fix: 'Preserve the current CI files and resolve the reported include, path or ownership conflict before re-running init.',
        })] };
  }

  // Branch-dependent desired state closes the read-only phase. A GitHub
  // acceptance workflow always needs a proven remote default. Protection
  // independently proves its target before any local or provider mutation;
  // if origin/HEAD changed between probes, refuse a mixed-branch harness.
  let workflowYaml: string | null = null;
  let workflowTemplate: 'self' | 'external' | 'gitlab' | 'gitlab-pending';
  let workflowBranch: string | undefined;
  if (!gitlabMode) {
    try {
      const selectionEv = await selectWorkflowYaml(ctx, root);
      if (!selectionEv.ok) {
        return { exit: EXIT_UNKNOWN, errors: [errorDiagnostic(
          selectionEv.code,
          selectionEv.message,
          selectionEv.fix ? { fix: selectionEv.fix } : {}
        )] };
      }
      workflowYaml = selectionEv.value.yaml;
      workflowTemplate = selectionEv.value.template;
      workflowBranch = selectionEv.value.defaultBranch;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exit: EXIT_USAGE, errors: [errorDiagnostic('workflow_input_invalid', message)] };
    }
  } else {
    workflowTemplate = completion.value === null ? 'gitlab-pending' : 'gitlab';
  }

  let protectionBranch: string | null = null;
  if (effectiveOptions.protect !== false) {
    const branchEv = await resolveProtectionDefaultBranch(ctx, root);
    if (!branchEv.ok) {
      return { exit: EXIT_UNKNOWN, errors: [errorDiagnostic(
        branchEv.code,
        branchEv.message,
        branchEv.fix ? { fix: branchEv.fix } : {}
      )] };
    }
    protectionBranch = branchEv.value;
  }
  const branchClaims = [
    workflowBranch,
    completion.value?.defaultBranch,
    protectionBranch ?? undefined,
  ].filter((branch): branch is string => branch !== undefined);
  if (new Set(branchClaims).size > 1) {
    return { exit: EXIT_UNKNOWN, errors: [errorDiagnostic(
      'default_branch_changed',
      `The proven remote default branch changed during init (${branchClaims.join(' -> ')}).`,
      { fix: 'Refresh origin/HEAD and re-run init so every generated workflow and protection target uses one branch.' }
    )] };
  }

  // ---- Mutation phase: local writes first (error-atomic), remote last. ----
  if (detected !== null) {
    const nonPrWarning = nonPrWorkflowWarning(detected);
    if (nonPrWarning !== null) warnings.push(nonPrWarning);
    const ambiguousWarning = ambiguousJobWarning(detected);
    if (ambiguousWarning !== null) warnings.push(ambiguousWarning);
  } else if (provenance === 'existing') {
    warnings.push(preservedChecksWarning());
  }

  // Only a pending declaration mutates providers.yaml. Track both the
  // pre-run state and the exact bytes this process wrote; an unrelated
  // harness failure must never restore a file this run did not touch, and a
  // later concurrent edit must never be overwritten by compensation.
  let providersMutation: { before: Snapshot; writtenContent: string } | null = null;
  if (platformSelection.declaration !== undefined) {
    let providersSnapshot: Snapshot;
    try {
      providersSnapshot = await snapshotManagedFile(
        root,
        path.relative(root, providersPath(root)).split(path.sep).join('/')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exit: EXIT_UNKNOWN,
        errors: [
          errorDiagnostic(
            'providers_snapshot_failed',
            `Could not read the pre-run state of ${SPEC_GIT_DIR}/providers.yaml: ${message}`,
            {
              fix: `Make ${SPEC_GIT_DIR}/providers.yaml a readable file (or remove it), then re-run init.`,
            }
          ),
        ],
      };
    }
    const { host, port } = platformSelection.declaration;
    const persisted = await persistGitlabHost(host, port, root);
    if ('exit' in persisted) {
      let restoreFailure: string | null = null;
      try {
        await restoreManagedSnapshot(providersSnapshot);
      } catch (error) {
        restoreFailure = error instanceof Error ? error.message : String(error);
      }
      const errors = [...(persisted.errors ?? [])];
      if (restoreFailure !== null) {
        errors.push(
          errorDiagnostic(
            'providers_restore_failed',
            `Could not restore ${SPEC_GIT_DIR}/providers.yaml to its pre-run state after the failed provider write: ${restoreFailure}`,
            {
              fix: `Compare ${SPEC_GIT_DIR}/providers.yaml against its pre-run state and re-run init once the cause is fixed.`,
            }
          )
        );
      }
      return { ...persisted, errors };
    }
    providersMutation = { before: providersSnapshot, writtenContent: persisted.content };
  }

  // #118: the effective generated-text language — explicit --language,
  // else the existing policy's language on --force, else the default.
  const { human: text } = catalogFor(language);

  const platform = {
    outcome: platformSelection.outcome,
    human: platformSelectionHuman(platformSelection, text),
  };
  if (gitlabMode && completion.value === null) {
    warnings.push({
      severity: 'warning',
      code: 'gitlab_harness_pending',
      message:
        'SpecGit does not generate or own the GitLab CI acceptance job; the project-owned .gitlab-ci.yml must run "specgit finish --json" for merge requests.',
      fix: 'Keep a top-level job in the project-owned .gitlab-ci.yml responsible for "specgit finish --json"; SpecGit can detect its job key or you can declare it explicitly with "--required-check <name>".',
    });
  }

  const written = await writeHarnessAndPolicy({
    root,
    ctx,
    checks,
    language,
    existingPolicy: existingPolicy.ok ? existingPolicy.value : undefined,
    automation: repair.automation,
    validation: rules.validation,
    tags: rules.tags,
    workflowYaml,
    completion: completion.value,
    routingSteps,
    writeIgnore: effectiveOptions.ignore !== false,
    warnings,
  });
  if ('exit' in written) {
    // The reconcile transaction already restored its own assets. Restore a
    // declaration only if this run persisted one and providers.yaml still
    // contains the exact bytes that persistence wrote. Concurrent changes
    // are preserved and surfaced instead of being overwritten.
    let restoreFailure: string | null = null;
    let restoreConflict = false;
    if (providersMutation !== null) {
      try {
        restoreConflict = !(await restoreManagedSnapshotIfCurrent(
          providersMutation.before,
          providersMutation.writtenContent
        ));
      } catch (error) {
        restoreFailure = error instanceof Error ? error.message : String(error);
      }
    }
    // OutcomeBase declares `errors` optional — every 'exit' path here sets
    // it, but the empty fallback keeps the spread total at the type level.
    const errors = [...(written.errors ?? [])];
    if (restoreFailure !== null) {
      errors.push(
        errorDiagnostic(
          'providers_restore_failed',
          `Could not restore ${SPEC_GIT_DIR}/providers.yaml to its pre-run state after the failed init: ${restoreFailure}`,
          {
            fix: `Compare ${SPEC_GIT_DIR}/providers.yaml against its pre-run state and re-run init once the cause is fixed.`,
          }
        )
      );
    } else if (restoreConflict) {
      errors.push(
        errorDiagnostic(
          'providers_restore_conflict',
          `Did not restore ${SPEC_GIT_DIR}/providers.yaml because it changed after this init persisted its declaration.`,
          {
            fix: `Preserve the current ${SPEC_GIT_DIR}/providers.yaml, reconcile it with the intended declaration, and re-run init.`,
          }
        )
      );
    }
    return { ...written, errors };
  }

  // #352: the adoption signal — the tracked status of the file the
  // platform's adoption commit carries: the acceptance workflow on
  // GitHub (gitlab mode never writes one), the force-added policy on
  // GitLab. Tracked means the adoption rode a commit (the adoption PR)
  // into this lineage; untracked means fresh adoption: the files exist
  // only in the working tree, so the protection confirm must default to
  // NO and the output must hand off the adoption steps.
  const adoptionSignalPath = gitlabMode
    ? `${SPEC_GIT_DIR}/${POLICY_FILENAME}`
    : HARNESS_WORKFLOW_PATH;
  const adoptedEv = await ctx.git.trackedFiles(root, [adoptionSignalPath]);
  const adopted = trackedIncludes(adoptedEv, adoptionSignalPath);

  let protection: ProtectionOutcome | undefined;
  let protectionHuman: string[] = [];
  if (protectionBranch !== null) {
    const guarded = await setupBranchProtection(
      effectiveOptions,
      ctx,
      root,
      text,
      adopted,
      protectionBranch
    );
    protection = guarded.outcome;
    protectionHuman = guarded.human;
  }

  const initialized = buildInitOutcome({
    checks,
    detected,
    provenance,
    platform,
    harness: written.harness,
    policy: written.policy,
    ignore: written.ignore,
    reconciled: written.reconciled,
    template: workflowTemplate,
    warnings,
    protection,
    protectionHuman,
    adopted,
    text,
  });
  if (!guidedUpgrade) return initialized;
  const setup = await runSetup({ tool: 'all', json: effectiveOptions.json }, ctx);
  return finishGuidedUpgrade(initialized, setup);
}
