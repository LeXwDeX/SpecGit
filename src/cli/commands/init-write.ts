/**
 * Mutation phase of `specgit init`: the harness write (error-atomic) and
 * the policy write, plus the final success envelope assembly. Local
 * writes happen first, remote mutation (branch protection) last and only
 * when explicitly requested.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import {
  HarnessWriteError,
  legacyGitHooksDir,
  writeHarnessAssets,
  type HarnessWriteResult,
} from '../harness-placement.js';
import { detailLine, errorDiagnostic, humanBuilder, type InitOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { HumanText } from '../language.js';
import { POLICY_FILENAME, SPEC_GIT_DIR, type CommandContext, type Policy } from '../types.js';
import { writeLocalAssetIgnore, type LocalAssetIgnoreResult } from './init-ignore.js';
import type { DetectionReport } from '../detect-checks.js';
import type { PolicyLanguage } from '../../record/policy.js';
import type { PlatformOutcome } from './init-platform.js';
import type { ProtectionOutcome } from './init-protection.js';

export interface HarnessAndPolicyWrite {
  harness: HarnessWriteResult;
  policy: Policy;
  /** #292: null when --no-ignore skipped the local-asset shielding. */
  ignore: LocalAssetIgnoreResult | null;
}

/**
 * Write the harness (workflow, hooks, managed prompt block — merged with
 * existing hooks, rolled back on failure) and then the policy. The git
 * hook goes where git actually runs hooks from: worktree and
 * core.hooksPath aware, with a legacy `.git/hooks` fallback; when neither
 * resolves, the git hook is skipped.
 */
export async function writeHarnessAndPolicy(args: {
  root: string;
  ctx: CommandContext;
  checks: string[];
  language: PolicyLanguage;
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

  let harness: HarnessWriteResult;
  try {
    harness = await writeHarnessAssets(root, {
      resolveHooksDir,
      workflowYaml,
      language,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Distinguishable diagnostics (#280): a plan-phase failure is a
    // content failure; a commit-phase failure is a write failure.
    const code =
      error instanceof HarnessWriteError && error.phase === 'plan'
        ? 'harness_content_failed'
        : 'harness_write_failed';
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(code, message)],
    };
  }
  for (const warning of harness.warnings) {
    warnings.push({ severity: 'warning', ...warning });
  }

  const policy: Policy = {
    version: 1 as const,
    required_checks: checks,
    ...(language !== 'en' ? { language } : {}),
  };
  // #298: probe BEFORE the rewrite — a tracked policy rewritten by
  // --force shows as an uncommitted modification until committed; warn
  // instead of leaving silent residue. Advisory, never a block.
  const policyPath = `${SPEC_GIT_DIR}/${POLICY_FILENAME}`;
  const policyTrackedEv = await ctx.git.trackedFiles(root, [policyPath]);
  const policyWasTracked =
    policyTrackedEv.ok && policyTrackedEv.value.includes(policyPath);
  try {
    await ctx.record.writePolicy(root, policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('policy_write_failed', message)],
    };
  }
  if (policyWasTracked) {
    warnings.push({
      severity: 'warning',
      code: 'policy_rewrite_tracked',
      message: `${policyPath} is tracked by git — this rewrite shows as an uncommitted modification until it is committed.`,
      fix: 'Carry the policy with the delivery (the bootstrap binding commit force-stages it), or discard the rewrite if it was explorative.',
    });
  }

  // #292: shield the local delivery assets by default (after the
  // policy write — same mutation phase, still before any remote call).
  let ignore: LocalAssetIgnoreResult | null = null;
  if (args.writeIgnore) {
    try {
      ignore = writeLocalAssetIgnore(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exit: EXIT_UNKNOWN,
        errors: [errorDiagnostic('ignore_write_failed', message)],
      };
    }
  }

  return { harness, policy, ignore };
}

/** Assemble the success envelope and human summary for a completed init. */
export function buildInitOutcome(args: {
  checks: string[];
  detected: DetectionReport | null;
  platform: { outcome: PlatformOutcome; human: string[] };
  harness: HarnessWriteResult;
  policy: Policy;
  ignore: LocalAssetIgnoreResult | null;
  template: string;
  warnings: Diagnostic[];
  protection: ProtectionOutcome | undefined;
  protectionHuman: string[];
  text: HumanText;
}): InitOutcome {
  const {
    checks,
    detected,
    platform,
    harness,
    policy,
    ignore,
    template,
    warnings,
    protection,
    protectionHuman,
    text,
  } = args;
  const builder = humanBuilder()
    .line(text.initCreatedPolicy(`${SPEC_GIT_DIR}/${POLICY_FILENAME}`))
    .append(ignore ? [text.initIgnoredAssets(ignore.path)] : [])
    .line(text.initRequiredChecks(checks.length))
    .append(checks.map((name) => text.initCheck(name)))
    .append(platform.human);
  if (detected !== null) {
    builder
      .line(text.initDetectedPlatform(detected.platform))
      .append(detected.sources.map((s) => text.initDetectedSource(s)))
      .append(
        detected.nonPrWorkflows.map((s) => detailLine(`skipped, never runs on a PR head: ${s}`))
      );
  }
  builder
    // #269: a skipped workflow write (GitLab platform mode) claims
    // nothing — the gitlab_harness_pending warning is the only statement.
    .append(harness.workflow ? [text.initCreatedHook(harness.workflow)] : [])
    .append(harness.hooks.map((hookPath) => text.initCreatedHook(hookPath)))
    .append(harness.gitHook ? [text.initGitHook(harness.gitHook)] : [])
    .append(harness.prompts.map((filename) => text.initManagedRefreshed(filename)))
    .append(protectionHuman);
  return {
    exit: EXIT_SUCCESS,
    policy,
    harness: { template },
    platform: platform.outcome,
    ...(ignore !== null ? { ignore } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(protection !== undefined ? { protection } : {}),
    ...(detected !== null
      ? {
          detected: {
            platform: detected.platform,
            sources: detected.sources,
            nonPrWorkflows: detected.nonPrWorkflows,
            clis: detected.clis,
            fallback: checks.length === 0,
          },
        }
      : {}),
    human: builder.build(),
  };
}
