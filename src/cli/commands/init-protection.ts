/**
 * Branch-protection guardrail for `specgit init`: the acceptance gate
 * only binds when the default branch requires the acceptance check —
 * otherwise a direct push or merge bypasses it. Probe, warn, and
 * (confirmed or --protect) enable protection plus repository auto-merge.
 * Every failure is fail-open: protection is a guardrail, never a reason
 * init fails.
 */

import { ACCEPTANCE_CHECK_NAME } from '../harness-content.js';
import { humanBuilder, warningLine } from '../output.js';
import type { HumanText } from '../language.js';
import type { CommandContext } from '../types.js';
import type { BranchProtectionFact } from '../../github/port.js';
import type { InitOptions } from './init-validation.js';

export interface ProtectionOutcome {
  [key: string]: unknown;
  branch: string;
  protected: boolean;
  requiredChecks?: string[];
  automerge: boolean;
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
const PROTECT_FIX = (branch: string) =>
  `Require check "${ACCEPTANCE_CHECK_NAME}" on ${branch} without weakening existing rules: ` +
  'in the repository Settings → Branches, edit the existing protection and add status check ' +
  `"${ACCEPTANCE_CHECK_NAME}" (keep existing required checks, reviews, restrictions, and admin ` +
  'enforcement), then enable auto-merge under Settings → General. Scripts: `specgit init --force ' +
  '--protect` re-applies it read-modify-write.';

/**
 * Probe the default branch's protection and the repository auto-merge;
 * when the acceptance check is not required (or auto-merge is off),
 * enable both after confirmation / --protect, else warn with the
 * non-weakening fix guidance.
 */
export async function setupBranchProtection(
  options: InitOptions,
  ctx: CommandContext,
  root: string,
  text: HumanText
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
        .line(warningLine(`cannot resolve a GitHub repository from '${originUrl}' — protection not probed.`))
        .build(),
    };
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
      human: humanBuilder().line(warningLine(`branch protection could not be probed (${protectionEv.message}).`)).build(),
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
      human: humanBuilder().line(warningLine(`repository auto-merge could not be probed (${automergeEv.message}).`)).build(),
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
      human: humanBuilder().build(),
    };
  }

  let confirmed = options.protect === true;
  if (!confirmed && ctx.stdinIsTTY) {
    const { confirm } = await import('@inquirer/prompts');
    confirmed = await confirm(
      {
        message: `Require "${ACCEPTANCE_CHECK_NAME}" on ${branch} and enable auto-merge (blocks bypassing the acceptance gate)?`,
        default: true,
      },
      { output: process.stderr }
    );
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
      human: humanBuilder()
        .line(
          warningLine(
            `${branch} does not require "${ACCEPTANCE_CHECK_NAME}" — the acceptance gate can be bypassed by a direct push or merge.`
          )
        )
        .build(),
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
      human: humanBuilder().line(warningLine(`enabling branch protection failed (${failed ?? 'unknown'}).`)).build(),
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
    human: humanBuilder()
      .line(text.initProtectionRequired(branch, ACCEPTANCE_CHECK_NAME))
      .line(text.initAutomerge(automergeFinal))
      .build(),
  };
}
