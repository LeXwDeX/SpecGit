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

import { harnessWorkflowYaml } from '../harness-assets.js';
import { externalAcceptanceWorkflowYaml } from '../external-harness.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { CommandContext } from '../types.js';

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
