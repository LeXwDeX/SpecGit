/**
 * Harness PLACEMENT (#280): takes the content bytes from
 * `harness-content.ts` and owns planning them against the live tree —
 * merging is delegated to the pure content transforms, so this module
 * never inspects what the bytes say. Since #305 the writes, snapshots,
 * rollback, and safe removals run inside the shared managed-asset
 * reconciliation transaction (`managed-reconcile.ts`); this module stays
 * the harness-specific desired-state builder. Content failures and write
 * failures report distinguishable diagnostics via `HarnessWriteError.phase`.
 *
 * Paths surfaced in output are repo-relative with forward slashes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PolicyLanguage } from '../record/policy.js';
import { COMPLETION_WORKFLOW_PATH, GITLAB_COMPLETION_WORKFLOW_PATH } from './completion-workflow.js';
import type { CompletionSelection } from './commands/init-workflow.js';
import {
  AGENTS_FILENAME,
  CLAUDE_FILENAME,
  GUARD_SCRIPT,
  HOOKS_JSON_PATH,
  harnessWorkflowYaml,
  injectManagedBlock,
  managedPromptBlock,
  mergeGitPrePush,
  mergeHooksJson,
} from './harness-content.js';
import {
  ManagedReconcileError,
  reconcileManagedAssets,
  type ManagedReconcileReport,
  type ManagedStep,
} from './managed-reconcile.js';

const HARNESS_WORKFLOW_SEGMENTS = ['.github', 'workflows', 'specgit-accept.yml'];

export const HARNESS_WORKFLOW_PATH = HARNESS_WORKFLOW_SEGMENTS.join('/');

/**
 * A harness failure carrying its phase: `plan` — content assembly or
 * merging failed before any write touched the tree; `commit` — a write
 * failed and rollback ran. `specgit init` maps the phases to distinct
 * diagnostic codes (`harness_content_failed` vs `harness_write_failed`).
 */
export class HarnessWriteError extends Error {
  readonly phase: 'plan' | 'commit';
  constructor(phase: 'plan' | 'commit', message: string) {
    super(message);
    this.name = 'HarnessWriteError';
    this.phase = phase;
  }
}

export interface HarnessWriteResult {
  /**
   * The written workflow's repo-relative path, or null when no workflow
   * belongs to this platform (#269 GitLab mode — an old SpecGit-owned
   * workflow is REMOVED there instead, reported via `removed`).
   */
  workflow: string | null;
  completionWorkflow: string | null;
  prompts: string[];
  hooks: string[];
  gitHook: string | null;
  /** #305: obsolete SpecGit-owned assets removed by the write (repo-relative). */
  removed: string[];
  /** Non-fatal merge refusals (e.g. an unmergeable hooks.json), surfaced by init as warnings. */
  warnings: Array<{ code: string; message: string }>;
}

const HOOKS_SEGMENTS = ['.opencode', 'hooks'];
const GUARD_HOOK_PATH = [...HOOKS_SEGMENTS, 'specgit-merge-guard.sh'].join('/');
export const GUARD_SCRIPT_PATH = GUARD_HOOK_PATH;

/**
 * Legacy resolution used when no git-backed resolver is available: install
 * into `<root>/.git/hooks` only when `.git` is a real directory (a linked
 * worktree's `.git` is a file, so the git hook is skipped there).
 */
export async function legacyGitHooksDir(root: string): Promise<string | null> {
  const gitDir = path.join(root, '.git');
  const gitStat = await fs.stat(gitDir).catch(() => null);
  return gitStat?.isDirectory() ?? false ? path.join(gitDir, 'hooks') : null;
}

export interface HarnessWriteOptions {
  /**
   * Resolve the directory git actually runs hooks from (absolute), or
   * null to skip the git hook. Production wires this to
   * `git rev-parse --git-path hooks` via the git port so linked
   * worktrees and `core.hooksPath` (husky/lefthook) behave correctly.
   */
  resolveHooksDir?: (root: string) => Promise<string | null>;
  /**
   * Workflow bytes to write (#63 template selection). Defaults to the
   * self-hosted template (the SpecGit repository's own workflow);
   * `specgit init` passes the portable external template for adopting
   * repositories. Either way the write is planned and rolled back
   * atomically with the rest of the harness. `null` (#117/#305: GitLab
   * platform mode) plans no workflow write AND removes a previous
   * SpecGit-owned workflow at the managed path — a GitHub Actions
   * workflow is obsolete output for a GitLab repository; every
   * platform-neutral asset is still written. A file at that path that
   * does not prove SpecGit ownership is preserved and reported.
   */
  workflowYaml?: string | null;
  /** Authorized completion only; disabled or wrong-platform owned copies are retired. */
  completion?: CompletionSelection | null;
  /**
   * Guidance language (#118): the managed prompt block renders in the
   * policy's language. Defaults to `en`; the workflow YAML and guard
   * scripts are machine artifacts and never localize.
   */
  language?: PolicyLanguage;
}

async function readIfExists(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

/**
 * Structural ownership proof for the managed workflow path: both SpecGit
 * workflow generations (self and external template) carry the acceptance
 * job name and the `specgit finish` invocation. A file at the managed path
 * without both markers is user content — preserved, never removed (#305).
 */
export function isSpecGitOwnedWorkflow(content: string): boolean {
  return content.includes('name: SpecGit Acceptance') && content.includes('specgit finish');
}

export function isSpecGitOwnedCompletion(content: string): boolean {
  return /^# Managed by SpecGit: (?:trusted delivery completion\.|include in a trusted default-branch pipeline\.)\r?\n/.test(content);
}

export interface HarnessDesiredState {
  /** Ordered reconciliation steps for every harness asset (#305). */
  steps: ManagedStep[];
  workflowWritten: boolean;
  completionWorkflow: string | null;
  prompts: string[];
  hooksJsonWritten: boolean;
  gitHook: string | null;
  warnings: Array<{ code: string; message: string }>;
}

/**
 * Build the harness desired state (#305): reads every target and turns the
 * content merges into reconciliation steps. Pure with respect to the tree —
 * no writes happen here; a failure surfaces as a plan-phase
 * `HarnessWriteError` from the caller.
 */
export async function buildHarnessDesiredState(
  root: string,
  options: HarnessWriteOptions
): Promise<HarnessDesiredState> {
  const warnings: Array<{ code: string; message: string }> = [];
  const block = managedPromptBlock(options.language);
  const steps: ManagedStep[] = [];
  const prompts: string[] = [];

  const completionWorkflow = options.completion
    ? (options.completion.platform === 'github' ? COMPLETION_WORKFLOW_PATH : GITLAB_COMPLETION_WORKFLOW_PATH)
    : null;
  const completionBytes = options.completion?.yaml;
  for (const completionPath of [COMPLETION_WORKFLOW_PATH, GITLAB_COMPLETION_WORKFLOW_PATH]) {
    steps.push(completionPath === completionWorkflow && completionBytes !== undefined ? {
      kind: 'write', path: completionPath, mode: 0o644,
      isOwned: isSpecGitOwnedCompletion, merge: () => completionBytes,
    } : { kind: 'remove', path: completionPath, isOwned: isSpecGitOwnedCompletion });
  }

  const workflowWritten = options.workflowYaml !== null;
  if (workflowWritten) {
    steps.push({
      kind: 'write',
      path: HARNESS_WORKFLOW_PATH,
      mode: 0o644,
      isOwned: isSpecGitOwnedWorkflow,
      // The current template wholesale: an init-owned artifact is
      // regenerated, local drift repaired.
      merge: () => options.workflowYaml ?? harnessWorkflowYaml(),
    });
  } else {
    // #305: wrong-platform workflow — remove it when (and only when) the
    // bytes prove SpecGit ownership; anything else is preserved + reported.
    steps.push({
      kind: 'remove',
      path: HARNESS_WORKFLOW_PATH,
      isOwned: isSpecGitOwnedWorkflow,
    });
  }

  for (const filename of [AGENTS_FILENAME, CLAUDE_FILENAME]) {
    const target = path.join(root, filename);
    const existing = await readIfExists(target);
    if (existing === null && filename === CLAUDE_FILENAME) {
      continue;
    }
    steps.push({
      kind: 'write',
      path: filename,
      mode: 0o644,
      merge: (current) => (current === null && filename === CLAUDE_FILENAME ? null : injectManagedBlock(current ?? '', block)),
    });
    prompts.push(filename);
  }

  const hooksJsonTarget = path.join(root, ...HOOKS_JSON_PATH.split('/'));
  const hooksJsonExisting = await readIfExists(hooksJsonTarget);
  const hooksJsonMerge = mergeHooksJson(hooksJsonExisting);
  let hooksJsonWritten = true;
  if (hooksJsonMerge.warning !== undefined) {
    warnings.push({ code: 'hooks_json_unmerged', message: hooksJsonMerge.warning });
    hooksJsonWritten = false;
  } else {
    steps.push({
      kind: 'write',
      path: HOOKS_JSON_PATH,
      mode: 0o644,
      merge: () => hooksJsonMerge.json,
    });
  }

  steps.push({
    kind: 'write',
    path: GUARD_HOOK_PATH,
    mode: 0o755,
    isOwned: (content) => /^#!\/bin\/sh\r?\n# SpecGit guard \(managed by specgit init\):/.test(content),
    merge: () => GUARD_SCRIPT,
  });

  const hooksDir = options.resolveHooksDir
    ? await options.resolveHooksDir(root)
    : await legacyGitHooksDir(root);
  let gitHook: string | null = null;
  if (hooksDir !== null) {
    const gitHookTarget = path.join(hooksDir, 'pre-push');
    const existing = await readIfExists(gitHookTarget);
    steps.push({
      kind: 'write',
      path: path.relative(root, gitHookTarget).split(path.sep).join('/'),
      mode: 0o755,
      merge: () => mergeGitPrePush(existing),
    });
    gitHook = path.relative(root, gitHookTarget).split(path.sep).join('/');
  }

  return { steps, workflowWritten, completionWorkflow, prompts, hooksJsonWritten, gitHook, warnings };
}

/** Assemble the #280 result shape from the desired state and the #305 report. */
export function harnessResultFrom(
  desired: HarnessDesiredState,
  report: ManagedReconcileReport
): HarnessWriteResult {
  const hooks = [...(desired.hooksJsonWritten ? [HOOKS_JSON_PATH] : []), GUARD_HOOK_PATH];
  return {
    workflow: desired.workflowWritten ? HARNESS_WORKFLOW_PATH : null,
    completionWorkflow: desired.completionWorkflow,
    prompts: desired.prompts,
    hooks,
    gitHook: desired.gitHook,
    removed: report.removed,
    warnings: desired.warnings,
  };
}

/**
 * Write the full harness (#62 non-destructive contract, #305 transaction):
 * build the desired state (plan — content failures surface as phase
 * `plan`), then reconcile it in one reversible transaction (commit —
 * rollback on failure, phase `commit`).
 */
export async function writeHarnessAssets(
  root: string,
  options: HarnessWriteOptions = {}
): Promise<HarnessWriteResult> {
  let desired: HarnessDesiredState;
  try {
    desired = await buildHarnessDesiredState(root, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessWriteError('plan', message);
  }

  let report: ManagedReconcileReport;
  try {
    report = await reconcileManagedAssets(root, { steps: desired.steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const phase =
      error instanceof ManagedReconcileError && error.phase === 'plan' ? 'plan' : 'commit';
    throw new HarnessWriteError(phase, message);
  }

  return harnessResultFrom(desired, report);
}
