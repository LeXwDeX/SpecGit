/**
 * `specgit init` — creates `spec_git/policy.yaml` and generates the
 * delivery harness: the CI acceptance workflow, the opencode guard hooks,
 * and the managed prompt block in the agent instruction files. The
 * harness generation is idempotent and merges with existing hooks; the
 * policy itself is write-once and never overwritten.
 *
 * Non-destructive contract (#62): every check that can reject the run —
 * input validation, `--gitlab-host` validation, `policy_exists`, and a
 * root-writability preflight — happens BEFORE any filesystem or remote
 * mutation. A rejected init leaves the repository byte-identical. The
 * harness write itself is error-atomic (rolled back on failure). Remote
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
 * auto-detects from `.github/workflows/*.{yml,yaml}` (job `name:` or the
 * job id; the generated SpecGit Acceptance job is excluded to avoid
 * self-reference; a matrix/reusable shape is never claimed as a proven
 * check-run name — it is reported as ambiguous). When no CI exists at
 * all, the policy names zero checks (#63: a fallback name the harness
 * cannot produce would deadlock the wait step and make the verdict
 * unsatisfiable) — the acceptance job itself, enforced through branch
 * protection, is then the gate.
 *
 * Structure (#171): `runInit` below only orchestrates named steps; the
 * concerns live in focused modules — detection and validation in
 * `init-validation.ts`, platform resolution in `init-platform.ts`,
 * workflow template selection in `init-workflow.ts`, the harness and
 * policy write in `init-write.ts`, and branch protection in
 * `init-protection.ts`.
 */

import * as path from 'node:path';

import { EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import { catalogFor } from '../language.js';
import { SPEC_GIT_DIR, POLICY_FILENAME, type CommandContext } from '../types.js';
import {
  restoreManagedSnapshot,
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
  resolveRequiredChecks,
  validateLanguageOption,
  type InitOptions,
} from './init-validation.js';
import { persistGitlabHost, resolvePlatformMode, validateGitlabHost } from './init-platform.js';
import { selectWorkflowYaml } from './init-workflow.js';
import { setupBranchProtection, type ProtectionOutcome } from './init-protection.js';
import { HARNESS_WORKFLOW_PATH } from '../harness-placement.js';
import { trackedIncludes } from '../gates.js';
import { buildInitOutcome, writeHarnessAndPolicy } from './init-write.js';

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
  root: string
): Promise<
  | InitOutcome
  | {
      declaredEndpoint: { host: string; port: string | null } | null;
      existingPolicy: Awaited<ReturnType<CommandContext['record']['readPolicy']>>;
      selection: Awaited<ReturnType<typeof selectWorkflowYaml>>;
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
  const policyGate = policyGateOutcome(existingPolicy, options);
  if (policyGate !== null) return policyGate;

  const writableError = await preflightRootWritable(root);
  if (writableError !== null) return writableError;

  // Workflow template selection (#63) closes the validation phase: a pure
  // computation over already-read inputs, still rejecting before writes.
  let selection: Awaited<ReturnType<typeof selectWorkflowYaml>>;
  try {
    selection = await selectWorkflowYaml(ctx, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exit: EXIT_USAGE, errors: [errorDiagnostic('workflow_input_invalid', message)] };
  }
  return { declaredEndpoint, existingPolicy, selection };
}

export async function runInit(
  options: InitOptions,
  ctx: CommandContext
): Promise<InitOutcome> {
  // ---- Input validation (#62: before any mutation). ----
  const languageError = validateLanguageOption(options);
  if (languageError !== null) return languageError;

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const validated = await runValidationPhase(options, ctx, root);
  if ('exit' in validated) return validated;
  const { declaredEndpoint, existingPolicy, selection } = validated;

  // ---- Required-check selection (#310: one seam, after the existing
  // policy is known — still before any mutation). Explicit --required-check
  // replaces; a valid existing policy upgrades by preservation; only a
  // fresh init detects. ----
  const resolved = await resolveRequiredChecks(options, ctx, root, existingPolicy);
  if ('exit' in resolved) return resolved;
  const { checks, detected, provenance } = resolved;

  // ---- Mutation phase: local writes first (error-atomic), remote last. ----
  const warnings: Diagnostic[] = [];
  if (selection.warning !== undefined) warnings.push(selection.warning);
  if (detected !== null) {
    const nonPrWarning = nonPrWorkflowWarning(detected);
    if (nonPrWarning !== null) warnings.push(nonPrWarning);
    const ambiguousWarning = ambiguousJobWarning(detected);
    if (ambiguousWarning !== null) warnings.push(ambiguousWarning);
  } else if (provenance === 'existing') {
    warnings.push(preservedChecksWarning());
  }

  // #117: the platform resolves BEFORE the harness write — GitLab mode
  // changes what the harness is. The declaration persists first so
  // resolvePlatformMode reads the declaration this run just validated.
  // #305: that early persist is inside the run's logical transaction — a
  // later reconcile failure restores the providers file from this snapshot
  // (including the directories this run created under spec_git/, so the
  // tree — not just the file — round-trips). A pre-run state that cannot
  // even be established fails closed HERE, through the outcome path, before
  // any mutation happens.
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
  if (declaredEndpoint !== null) {
    await persistGitlabHost(declaredEndpoint.host, declaredEndpoint.port, root, warnings);
  }

  // #118: the effective generated-text language — explicit --language,
  // else the existing policy's language on --force, else the default.
  const language = resolveInitLanguage(
    options,
    existingPolicy.ok ? existingPolicy.value.language : undefined
  );
  const { human: text } = catalogFor(language);

  const platform = await resolvePlatformMode(options, ctx, root, warnings, text);
  const gitlabMode = platform.outcome.mode === 'gitlab';
  if (gitlabMode) {
    warnings.push({
      severity: 'warning',
      code: 'gitlab_harness_pending',
      message:
        'The GitLab CI harness template is not generated yet; a GitHub Actions workflow would be wrong-platform output here — carry your own .gitlab-ci.yml.',
      fix: 'Its top-level job keys become the required checks (detect from the file or pass --required-check); see docs/gitlab-support.md.',
    });
  }

  const written = await writeHarnessAndPolicy({
    root,
    ctx,
    checks,
    language,
    workflowYaml: gitlabMode ? null : selection.yaml,
    writeIgnore: options.ignore !== false,
    warnings,
  });
  if ('exit' in written) {
    // #305: the reconcile transaction already restored every asset it
    // touched (harness, policy, ignore); the providers declaration may
    // have persisted earlier in this phase — restore it too, so a failed
    // upgrade leaves no mixed-version local state. A restore that cannot
    // complete is never swallowed: it becomes an ADDITIONAL error
    // diagnostic next to the failure that triggered it.
    let restoreFailure: string | null = null;
    try {
      await restoreManagedSnapshot(providersSnapshot);
    } catch (error) {
      restoreFailure = error instanceof Error ? error.message : String(error);
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
  if (options.protect !== false) {
    const guarded = await setupBranchProtection(options, ctx, root, text, adopted);
    protection = guarded.outcome;
    protectionHuman = guarded.human;
  }

  return buildInitOutcome({
    checks,
    detected,
    provenance,
    platform,
    harness: written.harness,
    policy: written.policy,
    ignore: written.ignore,
    reconciled: written.reconciled,
    template: gitlabMode ? 'gitlab-pending' : selection.template,
    warnings,
    protection,
    protectionHuman,
    adopted,
    text,
  });
}
