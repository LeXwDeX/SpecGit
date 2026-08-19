/**
 * `specgit init` — creates `spec_git/policy.yaml` and generates the
 * delivery harness: the CI acceptance workflow, the opencode guard hooks,
 * and the managed prompt block in the agent instruction files. Harness
 * generation is idempotent; the policy itself is write-once and never
 * overwritten.
 *
 * With no arguments, required-check names are auto-detected from
 * `.github/workflows/*.{yml,yaml}` (job `name:`, falling back to the job
 * id; the generated SpecGit Acceptance job is excluded to avoid
 * self-reference). When no workflow exists, the policy falls back to the
 * GitHub aggregate check name "All checks passed".
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import {
  ACCEPTANCE_CHECK_NAME,
  writeHarnessAssets,
  type HarnessWriteResult,
} from '../harness-assets.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import { POLICY_FILENAME, SPEC_GIT_DIR, type CommandContext } from '../types.js';
import { detectInitInputs, type DetectionReport } from '../detect-checks.js';
import type { BranchProtectionFact } from '../../github/port.js';

export interface InitOptions {
  requiredCheck?: string[];
  force?: boolean;
  detect?: boolean;
  /** true (--protect): enable without asking; false (--no-protect): skip probing; undefined: ask on TTY. */
  protect?: boolean;
  json?: boolean;
}

const FALLBACK_CHECK = 'All checks passed';

interface ProtectionOutcome {
  [key: string]: unknown;
  branch: string;
  protected: boolean;
  requiredChecks?: string[];
  automerge: boolean;
  action: 'protected' | 'already-protected' | 'warned' | 'unavailable';
  fix?: string;
}

const PROTECT_FIX = (branch: string) =>
  `Require check "${ACCEPTANCE_CHECK_NAME}" on ${branch}: gh api -X PUT repos/<owner>/<repo>/branches/${branch}/protection ` +
  'with body {"required_status_checks":{"strict":false,"contexts":["' +
  ACCEPTANCE_CHECK_NAME +
  '"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}, ' +
  'then gh api -X PATCH repos/<owner>/<repo> --input - with {"allow_auto_merge":true}.';

/**
 * Post-policy guardrail: the acceptance gate only binds when the default
 * branch requires the acceptance check — otherwise a direct push or merge
 * bypasses it. Probe, warn, and (confirmed or --protect) enable protection
 * plus repository auto-merge. Every failure is fail-open: protection is a
 * guardrail, never a reason init fails.
 */
async function guardAcceptanceBypass(
  options: InitOptions,
  ctx: CommandContext,
  root: string
): Promise<{ outcome?: ProtectionOutcome; human: string[] }> {
  const facts = await ctx.git.facts(root).catch(() => null);
  const originUrl = facts?.originUrl ?? null;
  if (!originUrl) {
    return { human: ['Warning: no origin remote — cannot probe branch protection.'] };
  }
  const repoEv = ctx.parseRepoRef(originUrl);
  if (!repoEv.ok) {
    return { human: [`Warning: cannot resolve a GitHub repository from '${originUrl}' — protection not probed.`] };
  }
  const repo = repoEv.value;

  const branchEv = await ctx.git.remoteDefaultBranch(root);
  const branch = branchEv.ok ? branchEv.value : 'main';

  const protectionEv = await ctx.gh.getBranchProtection(repo, branch);
  if (!protectionEv.ok) {
    return {
      outcome: {
        branch,
        protected: false,
        automerge: false,
        action: 'unavailable',
        fix: protectionEv.message,
      },
      human: [`Warning: branch protection could not be probed (${protectionEv.message}).`],
    };
  }
  const protection: BranchProtectionFact = protectionEv.value;
  const required = protection.requiredChecks.includes(ACCEPTANCE_CHECK_NAME);

  const automergeEv = await ctx.gh.getRepoAutomerge(repo);
  if (!automergeEv.ok) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
        automerge: false,
        action: 'unavailable',
        fix: automergeEv.message,
      },
      human: [`Warning: repository auto-merge could not be probed (${automergeEv.message}).`],
    };
  }
  const automerge = automergeEv.value.enabled;

  if (required && automerge) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        requiredChecks: protection.requiredChecks,
        automerge,
        action: 'already-protected',
      },
      human: [],
    };
  }

  let confirmed = options.protect === true;
  if (!confirmed && ctx.stdinIsTTY) {
    const { confirm } = await import('@inquirer/prompts');
    confirmed = await confirm({
      message: `Require "${ACCEPTANCE_CHECK_NAME}" on ${branch} and enable auto-merge (blocks bypassing the acceptance gate)?`,
      default: true,
    });
  }

  if (!confirmed) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
        automerge,
        action: 'warned',
        fix: PROTECT_FIX(branch),
      },
      human: [
        `Warning: ${branch} does not require "${ACCEPTANCE_CHECK_NAME}" — the acceptance gate can be bypassed by a direct push or merge.`,
      ],
    };
  }

  let final: BranchProtectionFact | null = required ? protection : null;
  let failed: string | null = null;
  if (!required) {
    const enableEv = await ctx.gh.enableBranchProtection(repo, branch, ACCEPTANCE_CHECK_NAME);
    if (enableEv.ok) {
      final = enableEv.value;
    } else {
      failed = enableEv.message;
    }
  }
  let automergeFinal = automerge;
  if (failed === null && !automerge) {
    const enableEv = await ctx.gh.enableRepoAutomerge(repo);
    if (enableEv.ok) {
      automergeFinal = enableEv.value.enabled;
    } else {
      failed = enableEv.message;
    }
  }

  if (failed !== null || final === null) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
        automerge,
        action: 'unavailable',
        fix: failed ?? undefined,
      },
      human: [`Warning: enabling branch protection failed (${failed ?? 'unknown'}).`],
    };
  }

  return {
    outcome: {
      branch,
      protected: final.protected,
      requiredChecks: final.requiredChecks,
      automerge: automergeFinal,
      action: 'protected',
    },
    human: [
      `Branch protection: ${branch} now requires "${ACCEPTANCE_CHECK_NAME}"`,
      `Auto-merge: ${automergeFinal ? 'enabled' : 'already on'}`,
    ],
  };
}

export async function runInit(
  options: InitOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  let checks = (options.requiredCheck ?? []).map((value) => value.trim());
  let detected: DetectionReport | null = null;

  if (checks.length === 0) {
    if (options.detect === false) {
      // Strict legacy path: no detection, no prompt (non-interactive
      // contract) — the caller must be explicit.
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(
            'required_check_required',
            'init requires at least one required check name.',
            { fix: 'Pass --required-check <name> (repeatable), or drop --no-detect to auto-detect.' }
          ),
        ],
      };
    }
    // Auto-detect from the repo's CI files (GitHub workflows, GitLab CI);
    // when none exist, the GitHub aggregate check is the safe fail-closed
    // fallback.
    const facts = await ctx.git.facts(ctx.cwd).catch(() => null);
    detected = await detectInitInputs(ctx.cwd, facts?.originUrl ?? null);
    checks = detected.requiredChecks.length > 0 ? detected.requiredChecks : [FALLBACK_CHECK];
  }

  const invalid = checks.find((value) => value.length === 0);
  if (invalid !== undefined) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'required_check_invalid',
          'Required check names must be non-empty.',
          { fix: 'Pass the exact check name, e.g. --required-check "All checks passed".' }
        ),
      ],
    };
  }

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  let harness: HarnessWriteResult;
  try {
    harness = await writeHarnessAssets(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('harness_write_failed', message)],
    };
  }

  const existingPolicy = await ctx.record.readPolicy(root);
  if (existingPolicy.ok && !options.force) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'policy_exists',
          `${SPEC_GIT_DIR}/${POLICY_FILENAME} already exists in this repository.`,
          { fix: `Edit ${SPEC_GIT_DIR}/${POLICY_FILENAME} directly, or re-run with --force to rebuild it.` }
        ),
      ],
    };
  }
  if (!existingPolicy.ok && existingPolicy.code !== 'policy_missing') {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(existingPolicy.code, existingPolicy.message, existingPolicy.fix ? { fix: existingPolicy.fix } : {}),
      ],
    };
  }

  const policy = { version: 1 as const, required_checks: checks };
  try {
    await ctx.record.writePolicy(root, policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('policy_write_failed', message)],
    };
  }

  let protection: ProtectionOutcome | undefined;
  let protectionHuman: string[] = [];
  if (options.protect !== false) {
    const guarded = await guardAcceptanceBypass(options, ctx, root);
    protection = guarded.outcome;
    protectionHuman = guarded.human;
  }

  return {
    exit: EXIT_SUCCESS,
    policy,
    ...(protection !== undefined ? { protection } : {}),
    ...(detected !== null
      ? {
          detected: {
            platform: detected.platform,
            sources: detected.sources,
            clis: detected.clis,
            fallback: checks.length === 1 && checks[0] === FALLBACK_CHECK,
          },
        }
      : {}),
    human: [
      `Created ${SPEC_GIT_DIR}/${POLICY_FILENAME}`,
      `Required checks (${checks.length}):`,
      ...checks.map((name) => `  - ${name}`),
      ...(detected !== null
        ? [`Detected platform: ${detected.platform}`, ...detected.sources.map((s) => `  detected from ${s}`)]
        : []),
      `Created ${harness.workflow}`,
      ...harness.hooks.map((hookPath) => `Created ${hookPath}`),
      ...(harness.gitHook ? [`Installed git pre-push guard (${harness.gitHook})`] : []),
      ...harness.prompts.map((filename) => `Managed block refreshed in ${filename}`),
      ...protectionHuman,
    ],
  };
}
