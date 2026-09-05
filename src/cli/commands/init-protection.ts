/**
 * Branch-protection guardrail for `specgit init`: GitHub requires the
 * generated acceptance check plus repository auto-merge; GitLab requires
 * a protected branch plus its project-wide pipeline-success gate. Probe,
 * warn, and (confirmed or --protect) enable the platform's exact state.
 * Provider failures do not undo a successful local init, but protection
 * reporting stays fail-closed: no proof means `unavailable`, never protected.
 */

import { ACCEPTANCE_CHECK_NAME } from '../harness-content.js';
import { humanBuilder, warningLine } from '../output.js';
import type { HumanText } from '../language.js';
import type { CommandContext } from '../types.js';
import {
  GITLAB_PIPELINE_SUCCESS_GATE,
  type BranchProtectionFact,
} from '../../github/port.js';
import type { RepoRef } from '../../gitfacts/origin.js';
import { fail, type Evidence } from '../../kernel/evidence.js';
import type { InitOptions } from './init-validation.js';

export interface ProtectionOutcome {
  [key: string]: unknown;
  branch: string;
  protected: boolean;
  requiredChecks?: string[];
  /** GitHub's repository auto-merge capability. */
  automerge?: boolean;
  /** GitLab's `only_allow_merge_if_pipeline_succeeds` project gate. */
  pipelineRequired?: boolean;
  action: 'protected' | 'already-protected' | 'warned' | 'unavailable';
  fix?: string;
}

/**
 * Non-weakening fix guidance (#62): the string printed for a human to act
 * on must not teach a command that clears reviews, push restrictions, or
 * admin enforcement. The settings-UI path preserves every existing rule
 * while adding the check; `specgit init --protect` (read-modify-write)
 * is the scripted equivalent.
 */
const GITHUB_PROTECT_FIX = (branch: string) =>
  `Require check "${ACCEPTANCE_CHECK_NAME}" on ${branch} without weakening existing rules: ` +
  'in the repository Settings → Branches, edit the existing protection and add status check ' +
  `"${ACCEPTANCE_CHECK_NAME}" (keep existing required checks, reviews, restrictions, and admin ` +
  'enforcement), then enable auto-merge under Settings → General. Scripts: `specgit init --force ' +
  '--protect` re-applies it read-modify-write.';

const GITLAB_PROTECT_FIX = (branch: string) =>
  `Run "specgit init --force --protect" to protect ${branch} and require a successful GitLab ` +
  'pipeline before merge. SpecGit does not create or rename the project-owned .gitlab-ci.yml ' +
  'acceptance job; keep that job responsible for running "specgit finish --json".';

function protectFix(platform: RepoRef['platform'], branch: string, detail?: string): string {
  const base = platform === 'github' ? GITHUB_PROTECT_FIX(branch) : GITLAB_PROTECT_FIX(branch);
  return detail === undefined ? base : `${base} Provider detail: ${detail}`;
}

function capabilityField(
  platform: RepoRef['platform'],
  enabled: boolean
): Pick<ProtectionOutcome, 'automerge' | 'pipelineRequired'> {
  return platform === 'github' ? { automerge: enabled } : { pipelineRequired: enabled };
}

function branchGateEnabled(
  platform: RepoRef['platform'],
  protection: BranchProtectionFact
): boolean {
  if (!protection.protected) return false;
  return platform === 'gitlab' || protection.requiredChecks.includes(ACCEPTANCE_CHECK_NAME);
}

function protectionFields(
  platform: RepoRef['platform'],
  protection: BranchProtectionFact,
  capabilityEnabled: boolean
): Pick<ProtectionOutcome, 'protected' | 'requiredChecks' | 'automerge' | 'pipelineRequired'> {
  return {
    protected: protection.protected,
    ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
    ...capabilityField(platform, capabilityEnabled),
  };
}

/**
 * Resolve the branch that a later protection probe or mutation may touch.
 * This preflight runs before local writes; a missing origin/HEAD is unknown
 * evidence, never permission to probe or protect a guessed `main` branch.
 */
export async function resolveProtectionDefaultBranch(
  ctx: CommandContext,
  root: string
): Promise<Evidence<string>> {
  const branchEv = await ctx.git.remoteDefaultBranch(root, { requireEvidence: true });
  if (branchEv.ok) return branchEv;
  return fail(
    'protection_default_branch_unknown',
    `Branch protection requires a proven remote default branch (${branchEv.message}).`,
    branchEv.fix ?? 'Fetch origin and establish origin/HEAD, then re-run init.'
  );
}

/**
 * Probe the default branch's protection and the platform merge gate;
 * when that state is incomplete, enable it after confirmation /
 * --protect, else warn with executable, non-weakening fix guidance.
 *
 * #352: `harnessOnTrunk` sets the interactive confirm's DEFAULT. A fresh
 * adoption (harness not yet on the default branch) must default to NO —
 * requiring a check no PR can pass yet locks out non-admin merges; the
 * protective YES is only the default once the adoption provably landed.
 */
export async function setupBranchProtection(
  options: InitOptions,
  ctx: CommandContext,
  root: string,
  text: HumanText,
  harnessOnTrunk: boolean,
  /** Proven by resolveProtectionDefaultBranch before the init mutation phase. */
  defaultBranch: string
): Promise<{ outcome?: ProtectionOutcome; human: string[] }> {
  const facts = await ctx.git.facts(root).catch(() => null);
  const originUrl = facts?.originUrl ?? null;
  if (!originUrl) {
    return { human: humanBuilder().line(warningLine('no origin remote — cannot probe branch protection.')).build() };
  }
  const repoEv = await ctx.parseRepoRef(originUrl);
  if (!repoEv.ok) {
    return {
      human: humanBuilder()
        .line(warningLine(`cannot resolve a supported forge repository from '${originUrl}' — protection not probed.`))
        .build(),
    };
  }
  const repo = repoEv.value;

  const branch = defaultBranch;

  const protectionEv = await ctx.gh.getBranchProtection(repo, branch);
  if (!protectionEv.ok) {
    const fix = protectFix(repo.platform, branch, protectionEv.fix ?? protectionEv.message);
    return {
      outcome: {
        branch,
        protected: false,
        ...capabilityField(repo.platform, false),
        action: 'unavailable',
        fix,
      },
      human: humanBuilder()
        .line(warningLine(`branch protection could not be probed (${protectionEv.message}). ${fix}`))
        .build(),
    };
  }
  const protection: BranchProtectionFact = protectionEv.value;
  const branchGate = branchGateEnabled(repo.platform, protection);

  const automergeEv = await ctx.gh.getRepoAutomerge(repo);
  if (!automergeEv.ok) {
    const noun = repo.platform === 'github' ? 'repository auto-merge' : 'GitLab pipeline-success gate';
    const fix = protectFix(repo.platform, branch, automergeEv.fix ?? automergeEv.message);
    return {
      outcome: {
        branch,
        ...protectionFields(repo.platform, protection, false),
        action: 'unavailable',
        fix,
      },
      human: humanBuilder()
        .line(warningLine(`${noun} could not be probed (${automergeEv.message}). ${fix}`))
        .build(),
    };
  }
  const capabilityEnabled = automergeEv.value.enabled;

  if (branchGate && capabilityEnabled) {
    return {
      outcome: {
        branch,
        ...protectionFields(repo.platform, protection, capabilityEnabled),
        action: 'already-protected',
      },
      human: humanBuilder().build(),
    };
  }

  let confirmed = options.protect === true;
  if (!confirmed && ctx.stdinIsTTY) {
    const { confirm } = await import('@inquirer/prompts');
    const message =
      repo.platform === 'github'
        ? `Require "${ACCEPTANCE_CHECK_NAME}" on ${branch} and enable auto-merge (blocks bypassing the acceptance gate)? ` +
          'Adopting a fresh repository: merge the adoption PR first — a required check no PR can pass yet locks out non-admin merges.'
        : `Protect ${branch} and require a successful GitLab pipeline before merge (blocks bypassing the acceptance gate)? ` +
          'Adopting a fresh repository: merge the adoption MR first so the project-owned acceptance job exists before successful pipelines become mandatory.';
    confirmed = await confirm(
      {
        message,
        default: harnessOnTrunk,
      },
      { output: process.stderr }
    );
  }

  if (!confirmed) {
    const fix = protectFix(repo.platform, branch);
    const warning =
      repo.platform === 'github'
        ? `${branch} does not require "${ACCEPTANCE_CHECK_NAME}" — the acceptance gate can be bypassed by a direct push or merge. ${fix}`
        : `GitLab protection is incomplete for ${branch}: protect the branch and require a successful pipeline before merge. ${fix}`;
    return {
      outcome: {
        branch,
        ...protectionFields(repo.platform, protection, capabilityEnabled),
        action: 'warned',
        fix,
      },
      human: humanBuilder().line(warningLine(warning)).build(),
    };
  }

  let final = protection;
  let failed: string | null = null;
  if (!branchGate) {
    const requiredGate =
      repo.platform === 'github' ? ACCEPTANCE_CHECK_NAME : GITLAB_PIPELINE_SUCCESS_GATE;
    const enableEv = await ctx.gh.enableBranchProtection(repo, branch, requiredGate);
    if (enableEv.ok) {
      final = enableEv.value;
      if (!branchGateEnabled(repo.platform, final)) {
        failed =
          repo.platform === 'github'
            ? `GitHub did not report "${ACCEPTANCE_CHECK_NAME}" as required after the update.`
            : `GitLab did not report ${branch} as protected after the update.`;
      }
    } else {
      failed = enableEv.message;
    }
  }
  let capabilityFinal = capabilityEnabled;
  if (failed === null && !capabilityEnabled) {
    const enableEv = await ctx.gh.enableRepoAutomerge(repo);
    if (enableEv.ok) {
      capabilityFinal = enableEv.value.enabled;
      if (!capabilityFinal) {
        failed =
          repo.platform === 'github'
            ? 'GitHub did not report repository auto-merge as enabled after the update.'
            : 'GitLab did not report successful pipelines as required after the update.';
      }
    } else {
      failed = enableEv.message;
    }
  }

  const proved = branchGateEnabled(repo.platform, final) && capabilityFinal;
  if (failed !== null || !proved) {
    const fix = protectFix(repo.platform, branch, failed ?? 'the returned state did not prove the required gate');
    return {
      outcome: {
        branch,
        ...protectionFields(repo.platform, final, capabilityFinal),
        action: 'unavailable',
        fix,
      },
      human: humanBuilder()
        .line(warningLine(`branch protection could not be verified (${failed ?? 'unknown'}). ${fix}`))
        .build(),
    };
  }

  const successHuman = humanBuilder();
  if (repo.platform === 'github') {
    successHuman
      .line(text.initProtectionRequired(branch, ACCEPTANCE_CHECK_NAME))
      .line(text.initAutomerge(!capabilityEnabled));
  } else {
    successHuman.line(text.initGitlabPipelineProtection(branch));
  }
  return {
    outcome: {
      branch,
      ...protectionFields(repo.platform, final, capabilityFinal),
      action: 'protected',
    },
    human: successHuman.build(),
  };
}
