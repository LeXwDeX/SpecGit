/**
 * `specgit init` — input detection and validation phase (#62): every
 * rejection here happens BEFORE any filesystem or remote mutation, so a
 * rejected init leaves the repository byte-identical. Also owns the
 * generated-text language resolution (#118).
 */

import * as fsConstants from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { EXIT_USAGE, EXIT_UNKNOWN } from '../exit-codes.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { Evidence } from '../../kernel/evidence.js';
import type { CommandContext, Policy } from '../types.js';
import { detectInitInputs, type DetectionReport } from '../detect-checks.js';
import { POLICY_LANGUAGES, isAutomationTargetBranch, type PolicyAutomation, type PolicyLanguage } from '../../record/policy.js';
import { POLICY_FILENAME, SPEC_GIT_DIR } from '../types.js';
import type { ProjectRuleInteraction } from './init-rules.js';
import { classifyPlatformMode } from './init-platform.js';

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
  configureRules?: boolean;
  titleCheck?: string;
  labelCheck?: string;
  allowedLabel?: string[];
  /** false (--no-ignore): skip the local-asset .gitignore block (#292); default writes it. */
  ignore?: boolean;
  /** Explicit user answer to the automation question. Absent defaults to no off a TTY. */
  automation?: string;
  /** Merge destination chosen by the user; otherwise resolve the remote default after a yes. */
  mergeTarget?: string;
  json?: boolean;
}

export interface InitInteraction extends ProjectRuleInteraction {
  promptAutomation?: (message: string) => Promise<string | null>;
}

function terminalAutomationPrompt(message: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    terminal.once('SIGINT', () => {
      const error = new Error('Interrupted.');
      error.name = 'ExitPromptError';
      reject(error);
      terminal.close();
    });
    terminal.once('close', () => resolve(null));
    terminal.question(message, (answer) => {
      resolve(answer);
      terminal.close();
    });
  });
}

export function validateAutomationOptions(options: InitOptions): InitOutcome | null {
  if (options.automation !== undefined && options.automation !== 'yes' && options.automation !== 'no') {
    return {
      exit: EXIT_USAGE,
      errors: [errorDiagnostic('automation_invalid', 'Automation must be answered yes or no.', {
        fix: 'Pass --automation yes or --automation no; the default is no.',
      })],
    };
  }
  if (options.mergeTarget !== undefined && !isAutomationTargetBranch(options.mergeTarget)) {
    return {
      exit: EXIT_USAGE,
      errors: [errorDiagnostic('automation_target_invalid', 'The automation target must be a branch name.', {
        fix: 'Pass --merge-target <branch>, such as main or release/stable, without revision syntax or options.',
      })],
    };
  }
  return null;
}

/** Every init invocation asks anew; a previous yes is never the prompt default. */
export async function resolveInitAutomation(
  options: InitOptions,
  ctx: CommandContext,
  root: string,
  language: PolicyLanguage,
  interaction: InitInteraction
): Promise<InitOutcome | { automation: PolicyAutomation }> {
  let answer = options.automation;
  let defaulted = answer === undefined;
  if (answer === undefined && ctx.stdinIsTTY) {
    const question = language === 'zh'
      ? '启用自动化合并和关闭已绑定 issue？ [yes/no]（默认 no）： '
      : 'Enable automatic merge and closure of bound issues? [yes/no] (default no): ';
    const response = (await (interaction.promptAutomation ?? terminalAutomationPrompt)(question))?.trim().toLowerCase();
    defaulted = !response;
    answer = response || 'no';
    if (answer !== 'yes' && answer !== 'no') {
      return {
        exit: EXIT_USAGE,
        errors: [errorDiagnostic('automation_invalid', 'Automation must be answered yes or no.', {
          fix: 'Re-run init and answer yes or no (default no), or pass --automation yes|no.',
        })],
      };
    }
  }
  if (answer !== 'yes') {
    ctx.io.stderr(language === 'zh'
      ? `自动化合并和关闭：no（${defaulted ? '默认；未明确选择 yes' : '已选择 no'}）。`
      : `Automatic merge and issue closure: no (${defaulted ? 'default; no explicit yes was supplied' : 'selected no'}).`);
    return { automation: { merge: false, close_issues: false } };
  }

  let target = options.mergeTarget;
  if (target === undefined) {
    const branch = await ctx.git.remoteDefaultBranch(root, { requireEvidence: true });
    if (!branch.ok || !isAutomationTargetBranch(branch.value)) {
      return {
        exit: EXIT_UNKNOWN,
        errors: [errorDiagnostic('automation_target_unknown', 'Cannot prove a valid remote default branch for automation.', {
          fix: 'Check the remote HEAD, or pass the intended branch explicitly with --merge-target <branch>.',
        })],
      };
    }
    target = branch.value;
  }
  ctx.io.stderr(language === 'zh'
    ? `自动化合并和关闭：yes；目标分支 ${target}。`
    : `Automatic merge and issue closure: yes; target branch ${target}.`);
  return { automation: { merge: true, target_branch: target, close_issues: true } };
}

/** Where the resolved required checks came from — the selection provenance (#310). */
export type CheckProvenance = 'explicit' | 'existing' | 'detected';

/** Resolved required checks plus the detection report (null unless detection ran). */
export interface CheckResolution {
  checks: string[];
  detected: DetectionReport | null;
  provenance: CheckProvenance;
}

/**
 * Selection and validation of the required-check inputs (#310): ONE seam,
 * resolved after the existing policy is known, with an explicit
 * precedence — explicit `--required-check` (repeatable) is the
 * intentional replacement path; otherwise a valid existing policy is
 * PRESERVED (a no-argument `init --force` is a version upgrade of the
 * generated assets, not a policy re-birth — detection must never replace
 * a working policy's checks); only a fresh init (no policy) detects.
 * `--no-detect` refuses guessing, not preserving: without a policy the
 * strict legacy path still demands explicit names. A repository with no
 * CI at all names zero required checks (#63): every fallback NAME is a
 * name the generated harness can never produce as a check-run, which
 * would deadlock the wait step and make the verdict unsatisfiable. The
 * acceptance job itself — kept out of the policy and enforced through
 * branch protection — is the gate for such repositories.
 */
export async function resolveRequiredChecks(
  options: InitOptions,
  ctx: CommandContext,
  root: string,
  existingPolicy: Evidence<Policy>
): Promise<InitOutcome | CheckResolution> {
  const explicit = (options.requiredCheck ?? []).map((value) => value.trim());
  const invalid = explicit.find((value) => value.length === 0);
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
  if (explicit.length > 0) {
    return { checks: explicit, detected: null, provenance: 'explicit' };
  }
  if (existingPolicy.ok) {
    // Preserve-on-upgrade: exact names, exact order (a no-check policy
    // stays no-check — #63 round-trips through upgrades).
    return {
      checks: [...existingPolicy.value.required_checks],
      detected: null,
      provenance: 'existing',
    };
  }
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
  // Fresh init: detection reads the DISCOVERED root (never the cwd the
  // command happened to run from).
  const facts = await ctx.git.facts(root).catch(() => null);
  const originUrl = facts?.originUrl ?? null;
  const platform = options.gitlabHost !== undefined
    ? 'gitlab'
    : await classifyPlatformMode(root, originUrl);
  const detected = await detectInitInputs(
    root,
    originUrl,
    platform === 'github' || platform === 'gitlab' ? platform : undefined
  );
  return { checks: detected.requiredChecks, detected, provenance: 'detected' };
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

/**
 * #310 detection truth boundary: a job whose check-run name depends on
 * matrix expansion or a reusable-workflow call was EXCLUDED from the
 * detected checks — ambiguity is evidence, never a guessed name. The
 * warning names every excluded job and the legitimate naming paths.
 */
export function ambiguousJobWarning(detected: DetectionReport): Diagnostic | null {
  if (detected.ambiguousJobs.length === 0) return null;
  return {
    severity: 'warning',
    code: 'checks_name_ambiguous',
    message:
      'These jobs fan out through a matrix or a reusable workflow, so their ' +
      `check-run names are not statically provable: ${detected.ambiguousJobs.join(', ')}.`,
    fix:
      'A matrix job reports one check run per combination (e.g. "Test (linux-bash)" ' +
      'for a label matrix), and a reusable call reports the called job\'s name — ' +
      'name the real expanded names explicitly with --required-check, or gate ' +
      'deliveries on an aggregator job whose flat name never churns.',
  };
}

/**
 * #310 preserve-on-upgrade: the run kept the existing policy's required
 * checks and language and rebuilt the versioned harness assets. The fix
 * names the one intentional replacement path.
 */
export function preservedChecksWarning(): Diagnostic {
  return {
    severity: 'warning',
    code: 'checks_preserved',
    message:
      'Preserved the required checks from the existing spec_git/policy.yaml ' +
      '(this run is a version upgrade of the generated assets, not a policy re-birth).',
    fix:
      'To replace the checks, re-run with --required-check <name> (repeatable) — ' +
      'the explicit list fully replaces the preserved one.',
  };
}
