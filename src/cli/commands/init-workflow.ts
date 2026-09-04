/**
 * Acceptance-workflow template selection for `specgit init` (#63): the
 * SpecGit repository itself (root package name `specgit`) keeps the
 * local-build template — the anti-drift lock pins it byte-exactly to this
 * repo's own workflow. Every other (adopting) repository gets the
 * portable external template: it installs the published CLI at the exact
 * running version, sets up only Node, parameterizes the default branch,
 * and never assumes the adopting project's toolchain, lockfile, layout,
 * or build.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { harnessWorkflowYaml } from '../harness-content.js';
import { externalAcceptanceWorkflowYaml } from '../external-harness.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { CommandContext } from '../types.js';
import { completionWorkflowYaml, gitlabRoutingWorkflowYaml } from '../completion-workflow.js';
import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';

/** The root package name that marks the SpecGit repository itself. */
const SELF_PACKAGE_NAME = 'specgit';

export interface WorkflowSelection {
  yaml: string;
  template: 'self' | 'external';
  warning?: Diagnostic;
}

/**
 * Template selection (#63): true only for the SpecGit repository itself,
 * identified by the root package name. Self-detection keeps this repo on
 * the local-build template (pinned byte-exactly by the anti-drift lock);
 * every other repository is an adopting repo and gets the portable
 * external template.
 */
async function isSelfRepository(root: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(root, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.name === SELF_PACKAGE_NAME;
  } catch {
    // Missing, unreadable, or unparseable package.json: an adopting repo.
    return false;
  }
}

/**
 * Compute the acceptance-workflow bytes for this repository (validation
 * phase — a pure function of inputs, no writes). External inputs are the
 * adopting repo's remote default branch and the running CLI's exact
 * version; an unresolvable remote falls back to `main` with a warning,
 * mirroring the branch fallback the protection guard already uses.
 */
export async function selectWorkflowYaml(
  ctx: CommandContext,
  root: string
): Promise<WorkflowSelection> {
  if (await isSelfRepository(root)) {
    return { yaml: harnessWorkflowYaml(), template: 'self' };
  }
  const branchEv = await ctx.git.remoteDefaultBranch(root);
  let warning: Diagnostic | undefined;
  let defaultBranch = 'main';
  if (branchEv.ok) {
    defaultBranch = branchEv.value;
  } else {
    warning = {
      severity: 'warning',
      code: 'default_branch_unresolved',
      message: `The remote default branch could not be resolved (${branchEv.message}).`,
      fix: 'Fetch the remote (git fetch) and set origin/HEAD, then re-run init --force to re-pin the branch.',
    };
  }
  return {
    yaml: externalAcceptanceWorkflowYaml({ defaultBranch, version: ctx.version }),
    template: 'external',
    ...(warning !== undefined ? { warning } : {}),
  };
}

export interface CompletionSelection {
  platform: 'github' | 'gitlab';
  yaml: string;
  routingYaml?: string;
}

/** Verify the actual project entry point without changing its remote CI settings. */
export async function validateGitlabCiConfig(
  ctx: CommandContext, root: string, gitlabHost?: string
): Promise<InitOutcome | null> {
  const facts = await ctx.git.facts(root);
  if (!facts.originUrl) {
    return { exit: 3, errors: [errorDiagnostic('gitlab_ci_config_unknown', 'GitLab CI configuration requires a readable origin.')] };
  }
  const forge = gitlabHost === undefined ? ctx : ctx.withGitlabHost?.(gitlabHost) ?? ctx;
  const repo = await forge.parseRepoRef(facts.originUrl);
  if (!repo.ok) return { exit: 3, errors: [errorDiagnostic(repo.code, repo.message, repo.fix ? { fix: repo.fix } : {})] };
  const config = await forge.gh.getCiConfigPath(repo.value);
  if (!config.ok) return { exit: 3, errors: [errorDiagnostic(config.code, config.message, config.fix ? { fix: config.fix } : {})] };
  if (config.value !== null && config.value !== '' && config.value !== '.gitlab-ci.yml') {
    return { exit: 2, errors: [errorDiagnostic('gitlab_ci_config_unsupported', 'The GitLab project uses a custom CI configuration path; automatic completion cannot safely replace its root entry point.', {
      fix: 'Keep the custom configuration unchanged. Configure an independently reviewed completion integration for that entry point.',
    })] };
  }
  return null;
}

/** A write-capable continuation must run on the proven remote default branch. */
export async function selectCompletionWorkflow(
  ctx: CommandContext,
  root: string,
  platform: 'github' | 'gitlab' | 'undecided',
  enabled: boolean
): Promise<Evidence<CompletionSelection | null>> {
  if (!enabled) return ok(null);
  if (platform === 'undecided') {
    return fail('automation_platform_unknown', 'Automatic completion requires a declared repository platform.',
      'Choose the origin platform during init before enabling automatic completion.');
  }
  const branch = await ctx.git.remoteDefaultBranch(root, { requireEvidence: true });
  if (!branch.ok) {
    return fail('automation_default_branch_unknown', 'Automatic completion requires a proven remote default branch.',
      'Fetch origin and establish origin/HEAD, then retry. The merge target does not identify the trusted default branch.');
  }
  try {
    const input = {
      defaultBranch: branch.value, version: ctx.version, selfHosted: await isSelfRepository(root), platform,
    };
    return ok({ platform, yaml: completionWorkflowYaml(input),
      ...(platform === 'gitlab' ? { routingYaml: gitlabRoutingWorkflowYaml(input) } : {}),
    });
  } catch (error) {
    return fail('automation_workflow_invalid', error instanceof Error ? error.message : String(error));
  }
}
