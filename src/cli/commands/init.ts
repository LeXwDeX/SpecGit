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
 * With no arguments, required-check names are auto-detected from
 * `.github/workflows/*.{yml,yaml}` (job `name:`, falling back to the job
 * id; the generated SpecGit Acceptance job is excluded to avoid
 * self-reference). When no CI exists at all, the policy names zero
 * checks (#63: a fallback name the harness cannot produce would deadlock
 * the wait step and make the verdict unsatisfiable) — the acceptance
 * job itself, enforced through branch protection, is then the gate.
 *
 * Structure (#171): `runInit` below only orchestrates named steps; the
 * concerns live in focused modules — detection and validation in
 * `init-validation.ts`, platform resolution in `init-platform.ts`,
 * workflow template selection in `init-workflow.ts`, the harness and
 * policy write in `init-write.ts`, and branch protection in
 * `init-protection.ts`.
 */

import { EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import { catalogFor } from '../language.js';
import type { CommandContext } from '../types.js';
import {
  detectAndValidateChecks,
  nonPrWorkflowWarning,
  policyGateOutcome,
  preflightRootWritable,
  resolveInitLanguage,
  validateLanguageOption,
  type InitOptions,
} from './init-validation.js';
import { persistGitlabHost, resolvePlatformMode, validateGitlabHost } from './init-platform.js';
import { selectWorkflowYaml } from './init-workflow.js';
import { setupBranchProtection, type ProtectionOutcome } from './init-protection.js';
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
  // ---- Detection and input validation (#62: before any mutation). ----
  const resolved = await detectAndValidateChecks(options, ctx);
  if ('exit' in resolved) return resolved;
  const { checks, detected } = resolved;

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

  // ---- Mutation phase: local writes first (error-atomic), remote last. ----
  const warnings: Diagnostic[] = [];
  if (selection.warning !== undefined) warnings.push(selection.warning);
  if (detected !== null) {
    const nonPrWarning = nonPrWorkflowWarning(detected);
    if (nonPrWarning !== null) warnings.push(nonPrWarning);
  }

  // #117: the platform resolves BEFORE the harness write — GitLab mode
  // changes what the harness is. The declaration persists first so
  // resolvePlatformMode reads the declaration this run just validated.
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
  if ('exit' in written) return written;

  let protection: ProtectionOutcome | undefined;
  let protectionHuman: string[] = [];
  if (options.protect !== false) {
    const guarded = await setupBranchProtection(options, ctx, root, text);
    protection = guarded.outcome;
    protectionHuman = guarded.human;
  }

  return buildInitOutcome({
    checks,
    detected,
    platform,
    harness: written.harness,
    policy: written.policy,
    ignore: written.ignore,
    template: gitlabMode ? 'gitlab-pending' : selection.template,
    warnings,
    protection,
    protectionHuman,
    text,
  });
}
