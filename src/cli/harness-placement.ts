/**
 * Harness PLACEMENT (#280): takes the content bytes from
 * `harness-content.ts` and owns planning, writing, and rollback —
 * merging is delegated to the pure content transforms, so this module
 * never inspects what the bytes say. Content failures and write failures
 * report distinguishable diagnostics via `HarnessWriteError.phase`.
 *
 * The whole write sequence is error-atomic (#62): every target is read
 * and transformed first; if any write fails, prior targets are restored
 * to their pre-write bytes and newly created files/directories are
 * removed. Crash-atomicity is out of scope; remote mutations happen
 * later in init and are never attempted when the local harness could not
 * be written.
 *
 * Paths surfaced in output are repo-relative with forward slashes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PolicyLanguage } from '../record/policy.js';
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
   * The written workflow's repo-relative path, or null when the write
   * was skipped (#269: GitLab platform mode). Output must equal real
   * side effects — a skipped write reports no path.
   */
  workflow: string | null;
  prompts: string[];
  hooks: string[];
  gitHook: string | null;
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
   * atomically with the rest of the harness. `null` (#117: GitLab
   * platform mode) skips the workflow write entirely — a GitHub Actions
   * workflow is wrong-platform output for a GitLab repository; every
   * platform-neutral asset is still written.
   */
  workflowYaml?: string | null;
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

interface Snapshot {
  target: string;
  existed: boolean;
  content: string | null;
  mode: number | null;
}

async function snapshot(target: string): Promise<Snapshot> {
  const [content, stat] = await Promise.all([
    readIfExists(target),
    fs.stat(target).catch(() => null),
  ]);
  return { target, existed: content !== null, content, mode: stat?.mode ?? null };
}

interface PlannedWrite {
  target: string;
  content: string;
  mode: number;
}

/**
 * Write the full harness (#62 non-destructive contract):
 *
 * 1. Plan — read every target and compute its final bytes up front
 *    (merging user hooks, injecting the managed block). A failure here
 *    surfaces as a `HarnessWriteError` with phase `plan` — a content
 *    failure, before any write touched the tree.
 * 2. Commit — create directories and write files in order.
 * 3. Rollback — if any commit step fails, restore every prior target to
 *    its snapshot (bytes and mode) and remove files/directories this run
 *    created, then rethrow with phase `commit` so init reports exit 3
 *    with a clean tree.
 */
interface HarnessPlan {
  planned: PlannedWrite[];
  workflowWritten: boolean;
  prompts: string[];
  hooksJsonWritten: boolean;
  gitHook: string | null;
  warnings: Array<{ code: string; message: string }>;
}

/** The plan phase: reads + pure content transforms; never writes. */
async function planHarnessWrites(root: string, options: HarnessWriteOptions): Promise<HarnessPlan> {
  const warnings: Array<{ code: string; message: string }> = [];
  const block = managedPromptBlock(options.language);
  const planned: PlannedWrite[] = [];
  const prompts: string[] = [];

  const workflowWritten = options.workflowYaml !== null;
  if (workflowWritten) {
    planned.push({
      target: path.join(root, ...HARNESS_WORKFLOW_SEGMENTS),
      content: options.workflowYaml ?? harnessWorkflowYaml(),
      mode: 0o644,
    });
  }

  for (const filename of [AGENTS_FILENAME, CLAUDE_FILENAME]) {
    const target = path.join(root, filename);
    const existing = await readIfExists(target);
    if (existing === null && filename === CLAUDE_FILENAME) {
      continue;
    }
    planned.push({ target, content: injectManagedBlock(existing ?? '', block), mode: 0o644 });
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
    planned.push({ target: hooksJsonTarget, content: hooksJsonMerge.json, mode: 0o644 });
  }

  const guardTarget = path.join(root, ...HOOKS_SEGMENTS, 'specgit-merge-guard.sh');
  planned.push({ target: guardTarget, content: GUARD_SCRIPT, mode: 0o755 });

  const hooksDir = options.resolveHooksDir
    ? await options.resolveHooksDir(root)
    : await legacyGitHooksDir(root);
  let gitHook: string | null = null;
  let gitHookTarget: string | null = null;
  if (hooksDir !== null) {
    gitHookTarget = path.join(hooksDir, 'pre-push');
    const existing = await readIfExists(gitHookTarget);
    planned.push({ target: gitHookTarget, content: mergeGitPrePush(existing), mode: 0o755 });
    gitHook = path.relative(root, gitHookTarget).split(path.sep).join('/');
  }

  return { planned, workflowWritten, prompts, hooksJsonWritten, gitHook, warnings };
}

export async function writeHarnessAssets(
  root: string,
  options: HarnessWriteOptions = {}
): Promise<HarnessWriteResult> {
  // ---- Plan phase: content failures, nothing written yet ----
  let plan: HarnessPlan;
  try {
    plan = await planHarnessWrites(root, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessWriteError('plan', message);
  }

  // ---- Commit phase (writes; rollback restores on failure) ----
  const snapshots: Snapshot[] = [];
  const createdDirs: string[] = [];
  try {
    for (const step of plan.planned) {
      snapshots.push(await snapshot(step.target));
      await ensureDirTracked(path.dirname(step.target), createdDirs);
      await fs.writeFile(step.target, step.content, 'utf-8');
      await fs.chmod(step.target, step.mode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollbackNote = await rollback(snapshots, createdDirs);
    throw new HarnessWriteError(
      'commit',
      rollbackNote !== null ? `${message} (rollback incomplete: ${rollbackNote})` : message
    );
  }

  const hooks = [...(plan.hooksJsonWritten ? [HOOKS_JSON_PATH] : []), GUARD_HOOK_PATH];
  return {
    workflow: plan.workflowWritten ? HARNESS_WORKFLOW_PATH : null,
    prompts: plan.prompts,
    hooks,
    gitHook: plan.gitHook,
    warnings: plan.warnings,
  };
}

/** mkdir -p that records the directory chain it had to create. */
async function ensureDirTracked(dir: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cursor = dir;
  while (!(await fs.stat(cursor).then(() => true).catch(() => false))) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (missing.length > 0) {
    await fs.mkdir(dir, { recursive: true });
    created.push(...missing);
  }
}

/**
 * Best-effort restore to the pre-write state: rewritten files get their
 * original bytes and mode back, files this run created are removed, and
 * directories this run created are removed deepest-first (rmdir refuses
 * non-empty dirs, so user content can never be deleted here).
 */
async function rollback(snapshots: Snapshot[], createdDirs: string[]): Promise<string | null> {
  let failure: string | null = null;
  for (const snap of [...snapshots].reverse()) {
    try {
      if (snap.existed && snap.content !== null) {
        await fs.writeFile(snap.target, snap.content, 'utf-8');
        if (snap.mode !== null) await fs.chmod(snap.target, snap.mode);
      } else {
        await fs.unlink(snap.target).catch(() => undefined);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(dir);
    } catch {
      // Non-empty (or already gone) — nothing more we can safely do.
    }
  }
  return failure;
}
