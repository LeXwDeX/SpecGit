/**
 * `specgit init` — input detection and validation phase (#62): every
 * rejection here happens BEFORE any filesystem or remote mutation, so a
 * rejected init leaves the repository byte-identical. Also owns the
 * generated-text language resolution (#118).
 */

import * as fsConstants from 'node:fs';
import { access } from 'node:fs/promises';

import { EXIT_USAGE, EXIT_UNKNOWN } from '../exit-codes.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { Evidence } from '../../kernel/evidence.js';
import type { CommandContext, Policy } from '../types.js';
import { detectInitInputs, type DetectionReport } from '../detect-checks.js';
import { POLICY_LANGUAGES, type PolicyLanguage } from '../../record/policy.js';
import { POLICY_FILENAME, SPEC_GIT_DIR } from '../types.js';

export interface InitOptions {
  requiredCheck?: string[];
  force?: boolean;
  detect?: boolean;
  /** true (--protect): enable without asking; false (--no-protect): skip probing; undefined: ask on TTY. */
  protect?: boolean;
  /** Bare hostname of a self-hosted GitLab instance matching the origin host. */
  gitlabHost?: string;
  /** Presentation language of generated text (#118): en | zh. */
  language?: string;
  json?: boolean;
}

/** Resolved required checks plus the detection report (null when explicit). */
export interface CheckResolution {
  checks: string[];
  detected: DetectionReport | null;
}

/**
 * Detection and validation of the required-check inputs: explicit names
 * win; otherwise auto-detect from the repo's CI files (unless --no-detect
 * forces the strict legacy path). A repository with no CI at all names
 * zero required checks (#63): every fallback NAME is a name the generated
 * harness can never produce as a check-run, which would deadlock the wait
 * step and make the verdict unsatisfiable. The acceptance job itself —
 * kept out of the policy and enforced through branch protection — is the
 * gate for such repositories.
 */
export async function detectAndValidateChecks(
  options: InitOptions,
  ctx: CommandContext
): Promise<InitOutcome | CheckResolution> {
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
    const facts = await ctx.git.facts(ctx.cwd).catch(() => null);
    detected = await detectInitInputs(ctx.cwd, facts?.originUrl ?? null);
    checks = detected.requiredChecks;
  }

  const invalid = checks.find((value) => value.length === 0);
  if (invalid !== undefined) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'required_check_invalid',
          'Required check names must be non-empty.',
          { fix: 'Pass the exact check name as it appears in check-runs, e.g. --required-check build.' }
        ),
      ],
    };
  }

  return { checks, detected };
}

/**
 * #62 input validation: an unsupported --language value rejects before any
 * filesystem or remote mutation. Returns a usage outcome, or null when the
 * option is absent or valid.
 */
export function validateLanguageOption(options: InitOptions): InitOutcome | null {
  if (options.language !== undefined && !POLICY_LANGUAGES.includes(options.language as PolicyLanguage)) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'language_invalid',
          `Language "${options.language}" is not supported for generated text.`,
          {
            fix: `Pass one of: ${POLICY_LANGUAGES.join(', ')} (default en), e.g. --language zh.`,
          }
        ),
      ],
    };
  }
  return null;
}

/**
 * policy_exists is the write gate: with an existing policy init refuses
 * (zero writes, zero remote calls) unless --force explicitly rebuilds.
 * Returns a rejection outcome, or null when the write may proceed.
 */
export function policyGateOutcome(
  existingPolicy: Evidence<Policy>,
  options: InitOptions
): InitOutcome | null {
  if (existingPolicy.ok && !options.force) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'policy_exists',
          `${SPEC_GIT_DIR}/${POLICY_FILENAME} already exists in this repository.`,
          { fix: `Edit ${SPEC_GIT_DIR}/${POLICY_FILENAME} directly, or re-run with --force to rebuild it (also refreshes the harness).` }
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
  return null;
}

/**
 * Writability preflight: fail usage before touching the tree rather than
 * discovering EACCES halfway through the harness write.
 */
export async function preflightRootWritable(root: string): Promise<InitOutcome | null> {
  try {
    await access(root, fsConstants.constants.W_OK);
    return null;
  } catch {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'root_not_writable',
          `The repository root ${root} is not writable.`,
          { fix: 'Fix the directory permissions (or re-run from a writable checkout) and retry.' }
        ),
      ],
    };
  }
}

/**
 * Effective generated-text language (#118): an explicit --language wins
 * (already validated); otherwise a --force rebuild inherits the existing
 * policy's language; otherwise the default. Written into the policy only
 * when it differs from the default, so default policies stay minimal.
 */
export function resolveInitLanguage(
  options: InitOptions,
  existingLanguage: PolicyLanguage | undefined
): PolicyLanguage {
  if (options.language !== undefined) {
    const match = POLICY_LANGUAGES.find((value) => value === options.language);
    if (match !== undefined) {
      return match;
    }
  }
  return existingLanguage ?? 'en';
}

/**
 * Detection trust boundary (#121): workflows whose triggers include no PR
 * trigger can never report check runs on a PR head. Their jobs are
 * excluded from the policy; the warning makes the exclusion visible and
 * the fix names the legitimate repair paths.
 */
export function nonPrWorkflowWarning(detected: DetectionReport): Diagnostic | null {
  if (detected.nonPrWorkflows.length === 0) return null;
  return {
    severity: 'warning',
    code: 'checks_not_pr_visible',
    message:
      'These workflows never run on a pull request head, so their jobs cannot ' +
      `become required checks: ${detected.nonPrWorkflows.join(', ')}.`,
    fix:
      'Detected checks are suggestions until proven on a PR head. If a job does ' +
      'report on PR heads (e.g. through another workflow), name it explicitly with ' +
      '--required-check; after CI changes, re-run init --force to re-detect — ' +
      'correcting a policy that was wrong at birth is the required repair, not a ' +
      'weakening.',
  };
}
