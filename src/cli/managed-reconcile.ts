/**
 * Managed-asset reconciliation (#305): the one deep module that converges a
 * repository's SpecGit-owned init assets to a desired state inside a single
 * reversible transaction. Callers describe the desired state — files with
 * pure merge resolvers, owned port writes, ownership-proven removals — and
 * get back a structured report; every filesystem detail (snapshots, mode
 * round-trips, directory bookkeeping, rollback) stays in here.
 *
 * Transaction contract:
 *
 * 1. Plan — read every target and run its resolver. A failure here (unreadable
 *    target, throwing resolver) is a `plan` failure: nothing was written.
 * 2. Commit — apply the planned steps in order; every target is snapshotted
 *    (bytes and mode) right before it is touched.
 * 3. Rollback — if any commit step fails, prior snapshots are restored
 *    byte-and-mode-exact (mode to the full extent the platform enforces,
 *    per the capability note below), paths this run created are removed,
 *    and directories this run created are removed deepest-first (rmdir
 *    refuses non-empty dirs, so user content can never be deleted here).
 *    Deletes are inside the transaction: a removed owned asset comes
 *    back if a later step fails.
 *    The same holds for the public snapshot/restore pair: a restore returns
 *    the COMPLETE pre-run tree — it prunes the directories the snapshot
 *    watched being created (rmdir only, up to the repository root), and a
 *    restore that cannot complete THROWS instead of failing silently.
 *
 * Replaceability (#314): an existing managed target that has drifted
 * write-protected (a read-only attribute on Windows, a mode without the
 * owner-write bit anywhere) is made replaceable — only the owner-write
 * bit added — before its bytes are rewritten, it is unlinked, or a
 * snapshot restore rewrites it, so repairing the drift cannot crash and
 * the final chmod puts the intended protection back.
 *
 * Deletion safety: a removal is applied only when the caller's ownership
 * predicate proves SpecGit ownership of the current bytes; anything else is
 * preserved verbatim and reported, never guessed at. After a successful
 * removal the directories it emptied are pruned (again only-empty rmdir).
 *
 * Path safety: repository-managed targets and every existing ancestor below
 * the repository root must be real filesystem entries, never symbolic links.
 * The read-only inspector and the writer use the same lstat-based boundary,
 * before reading target bytes. Git's separately verified hooks directory is
 * the sole explicit exception: its ancestors are owned by the git adapter,
 * while the hook file itself still may not be a symbolic link.
 *
 * Commit-time ownership: a write re-reads bytes, re-applies its ownership
 * predicate, and requires the exact input used by its merge resolver before
 * its snapshot enters the rollback stack. A removal re-reads and re-proves
 * ownership before its snapshot enters that stack. Node's portable filesystem
 * API has no compare-and-swap write/unlink primitive, so one residual TOCTOU
 * window remains: another process can change a target after that final
 * lstat/read and before SpecGit's write or unlink (including an ABA change),
 * or after an earlier successful mutation but before a later rollback.
 *
 * Paths in specs and reports are repo-relative with forward slashes.
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Platform mode capability (#314): POSIX permission bits are product-
// significant only where the filesystem can represent and enforce them.
// Node on Windows stats every regular file as 0o666 (writable) or 0o444
// (read-only), and chmod only toggles the read-only attribute from the
// owner-write bit — no 0o644/0o755/0o600 can ever be observed or produced
// there. One shared equivalence rule (below) keeps plan, inspect, commit,
// and restore converged on every platform instead of looping forever on
// bits chmod cannot set.
// ---------------------------------------------------------------------------

/**
 * Whether this platform's filesystem enforces full POSIX permission bits
 * (everywhere except Windows). When false, only the read-only contract —
 * the owner-write bit — is representable, and that is the entire mode
 * surface SpecGit compares, chmods, or restores.
 */
export function posixModesEnforced(): boolean {
  return process.platform !== 'win32';
}

/**
 * The mode equivalence the platform can actually enforce (#314): exact
 * permission bits where POSIX modes are enforced; on Windows only the
 * owner-write bit (writable vs read-only), because that is all Node can
 * observe or change there. Differences confined to unenforceable bits
 * (executable, group/other masks) cannot be repaired on such a filesystem
 * and must not manufacture false stale/updated states — while enforceable
 * drift (a read-only file a writable step desires) is still detected and
 * repaired on every platform.
 */
export function managedModeMatches(actual: number, desired: number): boolean {
  if (posixModesEnforced()) {
    return (actual & 0o777) === (desired & 0o777);
  }
  return (actual & 0o200) === (desired & 0o200);
}

export type ManagedPathScope = 'repo' | 'git-hooks';

interface ManagedPathScoped {
  /** Repository paths are the default; git hooks require explicit adapter-backed trust. */
  scope?: ManagedPathScope;
}

export type ManagedStep =
  | {
      kind: 'write';
      path: string;
      mode: number;
      /** Existing whole-file targets require proof of ownership before replacement. */
      isOwned?: (existing: string) => boolean;
      /**
       * Pure resolver: current bytes (null when the file is absent) →
       * desired bytes. Returning null plans no write — the resolver's
       * closure owns surfacing why (a merge refused, an optional target).
       */
      merge: (existing: string | null) => string | null;
    } & ManagedPathScoped
  | {
      kind: 'portWrite';
      path: string;
      /**
       * An owned write the module must not perform itself (a port call such
       * as the record port's writePolicy). The transaction still snapshots
       * the target before and classifies the outcome after.
       */
      write: () => Promise<void>;
    } & ManagedPathScoped
  | {
      kind: 'remove';
      path: string;
      /** True when the existing bytes prove SpecGit ownership (safe delete). */
      isOwned: (existing: string) => boolean;
    } & ManagedPathScoped;

export interface DesiredManagedAssets {
  steps: ManagedStep[];
}

export interface ManagedReconcileReport {
  created: string[];
  updated: string[];
  removed: string[];
  /** Removal candidates left untouched because ownership was not proven. */
  preserved: string[];
}

/**
 * A reconciliation failure carrying its phase and the step that failed:
 * `plan` — a read or resolver failed before any write touched the tree;
 * `commit` — an apply step failed and rollback ran.
 */
export class ManagedReconcileError extends Error {
  readonly phase: 'plan' | 'commit';
  readonly step: { kind: ManagedStep['kind']; path: string } | null;
  constructor(
    phase: 'plan' | 'commit',
    message: string,
    step: { kind: ManagedStep['kind']; path: string } | null = null
  ) {
    super(message);
    this.name = 'ManagedReconcileError';
    this.phase = phase;
    this.step = step;
  }
}

export interface Snapshot {
  root: string;
  path: string;
  scope: ManagedPathScope;
  target: string;
  existed: boolean;
  content: string | null;
  mode: number | null;
  /**
   * Ancestor directories of the target that did NOT exist when the
   * snapshot was taken (deepest-first, strictly below the repository
   * root). A restore that removes the file prunes exactly these — rmdir
   * only, so a directory that picked up user content stays.
   */
  missingDirs: string[];
}

export interface ManagedPathBoundary {
  /** Fully resolved lexical target. No realpath call follows managed links. */
  target: string;
  /** The first symbolic-link component, expressed relative to root when possible. */
  symlink: string | null;
  /** True only when that link is the leaf itself, which can be unlinked safely. */
  symlinkAtTarget: boolean;
}

function isInsideOrEqual(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Inspect the lexical path without following a managed symbolic link.
 *
 * Repo scope checks the repository root, target, and every component between
 * them. An out-of-root git-hooks step is already physically bounded by
 * GitPort.hooksPath; only its leaf remains unchecked by that adapter, so only
 * the leaf is lstat'd here. An in-repo hook keeps the full repository check.
 * Returning the link instead of throwing lets read-only inspection turn the
 * unsafe path into an ordinary conflict finding.
 */
export async function inspectManagedPathBoundary(
  root: string,
  relPath: string,
  scope: ManagedPathScope = 'repo'
): Promise<ManagedPathBoundary> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relPath.split('/'));

  if (scope === 'git-hooks' && !isInsideOrEqual(target, resolvedRoot)) {
    const entry = await lstatIfExists(target);
    return {
      target,
      symlink: entry?.isSymbolicLink() ? relPath : null,
      symlinkAtTarget: entry?.isSymbolicLink() ?? false,
    };
  }

  if (!isInsideOrEqual(target, resolvedRoot) || target === resolvedRoot) {
    throw new Error(`Managed path "${relPath}" must stay strictly inside the repository root.`);
  }

  const relative = path.relative(resolvedRoot, target);
  const components = relative.split(path.sep).filter((part) => part.length > 0);
  let cursor = resolvedRoot;
  for (const component of ['', ...components]) {
    if (component !== '') cursor = path.join(cursor, component);
    const entry = await lstatIfExists(cursor);
    if (entry === null) break;
    if (entry.isSymbolicLink()) {
      const relativeLink = path.relative(resolvedRoot, cursor).split(path.sep).join('/');
      return { target, symlink: relativeLink || '.', symlinkAtTarget: cursor === target };
    }
  }
  return { target, symlink: null, symlinkAtTarget: false };
}

function symbolicLinkBoundaryMessage(relPath: string, symlink: string): string {
  return `Managed path "${relPath}" crosses symbolic link "${symlink}"; replace it with a real repository path before retrying.`;
}

async function safeManagedTarget(
  root: string,
  step: Pick<ManagedStep, 'path' | 'scope'>
): Promise<string> {
  const boundary = await inspectManagedPathBoundary(root, step.path, step.scope ?? 'repo');
  if (boundary.symlink !== null) {
    throw new Error(symbolicLinkBoundaryMessage(step.path, boundary.symlink));
  }
  return boundary.target;
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

async function statMode(target: string): Promise<number | null> {
  const stat = await lstatIfExists(target);
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to inspect mode through symbolic link ${target}.`);
  }
  return stat?.mode ?? null;
}

/**
 * Make an existing managed target replaceable before SpecGit mutates it
 * (#314): a drifted asset may be write-protected — a read-only attribute
 * on Windows, a mode without the owner-write bit anywhere — and without
 * this guard the repair itself would crash (EPERM/EACCES replacing bytes,
 * EPERM unlinking on Windows) and so would the rollback that must restore
 * them. Adds ONLY the owner-write bit, keeping every other bit; the final
 * chmod — the step's desired mode in commit, the snapshot mode in
 * restore — puts the intended protection back. A no-op for targets that
 * do not exist or are already writable.
 */
async function ensureReplaceable(target: string): Promise<void> {
  const entry = await lstatIfExists(target);
  if (entry?.isSymbolicLink()) {
    throw new Error(`Refusing to chmod symbolic link ${target}.`);
  }
  const mode = entry?.mode ?? null;
  if (mode === null || (mode & 0o200) !== 0) {
    return;
  }
  await fs.chmod(target, mode | 0o200);
}

/** True when `child` names a path strictly inside `ancestor`. */
function isStrictlyBelow(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Deepest-first list of `dir` and its ancestors (strictly below `stopAt`)
 * that do not exist — the directories a later write would have to create.
 * Bounded by the repository root: an out-of-root target (a `core.hooksPath`
 * git hook) never prunes anything.
 */
async function missingDirsBelow(dir: string, stopAt: string): Promise<string[]> {
  const missing: string[] = [];
  let cursor = dir;
  while (
    isStrictlyBelow(cursor, stopAt) &&
    (await lstatIfExists(cursor)) === null
  ) {
    missing.push(cursor);
    cursor = path.dirname(cursor);
  }
  return missing;
}

/** Build a full snapshot of one already-bounded target (bytes, mode, missing ancestors). */
async function buildSnapshot(
  root: string,
  relPath: string,
  scope: ManagedPathScope = 'repo'
): Promise<Snapshot> {
  const target = await safeManagedTarget(root, { path: relPath, scope });
  const entry = await lstatIfExists(target);
  const content = entry === null ? null : await readIfExists(target);
  return {
    root,
    path: relPath,
    scope,
    target,
    existed: content !== null,
    content,
    mode: entry?.mode ?? null,
    missingDirs: await missingDirsBelow(path.dirname(target), root),
  };
}

/** Public snapshot primitive: capture a file's pre-run state (bytes + mode). */
export async function snapshotManagedFile(
  root: string,
  relPath: string
): Promise<Snapshot> {
  return buildSnapshot(root, relPath);
}

/** Public restore primitive: put a snapshot back byte-and-mode-exact. */
export async function restoreManagedSnapshot(snapshot: Snapshot): Promise<void> {
  const boundary = await inspectManagedPathBoundary(snapshot.root, snapshot.path, snapshot.scope);
  const current = await lstatIfExists(snapshot.target);
  if (boundary.symlink !== null && !boundary.symlinkAtTarget) {
    // A leaf link can be unlinked without following it. A linked ancestor
    // would redirect every later mkdir/write and therefore blocks rollback.
    throw new Error(symbolicLinkBoundaryMessage(snapshot.path, boundary.symlink));
  }
  if (current?.isSymbolicLink()) {
    // Removing the link itself never touches its referent. This is required
    // when a failed port write replaced an originally safe leaf with a link.
    await fs.unlink(snapshot.target);
  }
  if (snapshot.existed && snapshot.content !== null) {
    await fs.mkdir(path.dirname(snapshot.target), { recursive: true });
    // The pre-run state itself may have been write-protected: the restore
    // must be able to rewrite it before the final chmod below protects it
    // again (#314).
    await ensureReplaceable(snapshot.target);
    await fs.writeFile(snapshot.target, snapshot.content, 'utf-8');
    // Full-mode chmod is already the platform-maximal restore (#314): exact
    // bits where enforced, the read-only contract where that is all there is.
    if (snapshot.mode !== null) await fs.chmod(snapshot.target, snapshot.mode);
    return;
  }
  // The file did not exist before the run: removing it must actually
  // remove it — only "already gone" is tolerable, everything else means
  // the tree did not round-trip and must surface, not be swallowed.
  // ENOTDIR is the same absence proof `readIfExists` uses (a path
  // component is a regular file — the target cannot exist), so a failed
  // create under a file-shaped blocker does not masquerade as an
  // incomplete rollback on POSIX (#314); Windows reports ENOENT here.
  // A run-created target can carry a write-protected desired mode; unlink
  // must stay able to remove it (EPERM on Windows) before the walk prunes.
  await ensureReplaceable(snapshot.target);
  await fs.unlink(snapshot.target).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  });
  // Prune the directories this run created (deepest-first): rmdir refuses
  // a non-empty directory, so user content can never be deleted here.
  // ENOTEMPTY stops the walk — the parents of a non-empty dir are
  // non-empty too; any other failure means the tree did not round-trip.
  for (const dir of snapshot.missingDirs) {
    try {
      await fs.rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') break;
      throw error;
    }
  }
}

/**
 * Restore a snapshot only while the target still contains the exact bytes
 * written by this run. A missing, replaced, non-file, linked, or byte-changed
 * target is preserved and reported as `false`; it may belong to a concurrent
 * writer. This is the strongest portable compare-before-restore available
 * through Node's file APIs. A process can still race the final check and the
 * restore itself, so callers must treat the result as conflict avoidance, not
 * an atomic filesystem compare-and-swap.
 */
export async function restoreManagedSnapshotIfCurrent(
  snapshot: Snapshot,
  expectedCurrentContent: string
): Promise<boolean> {
  const boundary = await inspectManagedPathBoundary(snapshot.root, snapshot.path, snapshot.scope);
  if (boundary.symlink !== null) return false;
  const entry = await lstatIfExists(snapshot.target);
  if (entry === null || !entry.isFile()) return false;
  const currentContent = await readIfExists(snapshot.target);
  if (currentContent !== expectedCurrentContent) return false;
  await restoreManagedSnapshot(snapshot);
  return true;
}

/** mkdir -p that records the directory chain it had to create. */
async function ensureDirTracked(dir: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cursor = dir;
  let entry = await lstatIfExists(cursor);
  while (entry === null) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
    entry = await lstatIfExists(cursor);
  }
  if (entry?.isSymbolicLink()) {
    throw new Error(`Refusing to create a managed directory through symbolic link ${cursor}.`);
  }
  if (missing.length > 0) {
    await fs.mkdir(dir, { recursive: true });
    created.push(...missing);
  }
}

type PlannedAction =
  | {
      kind: 'write';
      step: Extract<ManagedStep, { kind: 'write' }>;
      /** Exact bytes the pure merge resolver used to derive `content`. */
      basis: string | null;
      content: string;
    }
  | { kind: 'portWrite'; step: Extract<ManagedStep, { kind: 'portWrite' }> }
  | { kind: 'remove'; step: Extract<ManagedStep, { kind: 'remove' }> };

interface Plan {
  actions: PlannedAction[];
  preserved: string[];
}

/** The plan phase: reads + pure resolvers; never writes. */
async function planManaged(root: string, desired: DesiredManagedAssets): Promise<Plan> {
  const actions: PlannedAction[] = [];
  const preserved: string[] = [];
  for (const step of desired.steps) {
    try {
      const target = await safeManagedTarget(root, step);
      if (step.kind === 'write') {
        const existing = await readIfExists(target);
        if (existing !== null && step.isOwned !== undefined && !step.isOwned(existing)) {
          throw new Error(`${step.path} is not provably SpecGit-owned; preserve or relocate the user file before retrying.`);
        }
        const content = step.merge(existing);
        if (content === null) {
          continue;
        }
        if (existing === null) {
          actions.push({ kind: 'write', step, basis: existing, content });
          continue;
        }
        const mode = await statMode(target);
        const unchanged =
          existing === content && mode !== null && managedModeMatches(mode, step.mode);
        if (!unchanged) {
          actions.push({ kind: 'write', step, basis: existing, content });
        }
      } else if (step.kind === 'remove') {
        const existing = await readIfExists(target);
        if (existing !== null && !step.isOwned(existing)) {
          preserved.push(step.path);
        } else if (existing !== null) {
          actions.push({ kind: 'remove', step });
        }
      } else {
        actions.push({ kind: 'portWrite', step });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedReconcileError('plan', message, { kind: step.kind, path: step.path });
    }
  }
  return { actions, preserved };
}

/** Best-effort prune of the directories a removal emptied (rmdir only). */
async function pruneEmptyDirs(root: string, removedAt: string): Promise<void> {
  let cursor = path.dirname(removedAt);
  while (cursor.length > root.length) {
    try {
      await fs.rmdir(cursor);
    } catch {
      return; // non-empty (or already gone): user content stays put
    }
    cursor = path.dirname(cursor);
  }
}

/**
 * Best-effort restore to the pre-run state: rewritten/removed files get
 * their original bytes and mode back, files this run created are removed,
 * and directories this run created are removed deepest-first (both via
 * each snapshot's missingDirs and the tracked createdDirs). Returns the
 * first failure encountered, or null.
 */
async function rollback(snapshots: Snapshot[], createdDirs: string[]): Promise<string | null> {
  let failure: string | null = null;
  for (const snap of [...snapshots].reverse()) {
    try {
      await restoreManagedSnapshot(snap);
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

// ---------------------------------------------------------------------------
// Read-only inspection (#308): the same desired states the writer converges,
// answered without mutating anything. One shared notion of "drift" — the
// inspector walks the identical step list `reconcileManagedAssets` plans,
// with the identical path resolution, byte/mode equality, and ownership
// predicates — so the read side can never drift from the write side.
// ---------------------------------------------------------------------------

/** The state of one managed asset relative to the desired state (#308). */
export type ManagedAssetState = 'current' | 'stale' | 'missing' | 'conflict';

/** Stable machine diagnostic code for a non-current asset (#308). */
export type ManagedAssetDriftCode = 'asset_stale' | 'asset_missing' | 'asset_conflict';

export interface ManagedAssetFinding {
  /** Repo-relative, forward slashes — never localized. */
  path: string;
  state: ManagedAssetState;
  /** Present exactly when `state` is not `current`; never localized. */
  code?: ManagedAssetDriftCode;
}

export interface ManagedInspection {
  /**
   * One entry per step that makes a claim: every `write` step (current /
   * stale / missing — the resolver declining plans nothing and claims
   * nothing), and every `remove` step whose target exists (stale when the
   * bytes prove ownership, conflict when they do not). An absent removal
   * target is clean by absence and produces no entry.
   */
  findings: ManagedAssetFinding[];
  /**
   * `portWrite` step paths: inspecting one would mean executing its owned
   * closure, and a port write mutates. They are excluded BY KIND here and
   * named so a caller can never silently lose coverage; the closure is
   * never invoked.
   */
  notInspected: string[];
}

/**
 * Inspect `root` against the desired managed-asset state without touching
 * the tree: no writes, no deletes, no chmods, no port writes. Throws
 * `ManagedReconcileError('plan', …)` with the failing step when a read or
 * resolver fails — the same failure shape the writer's plan phase reports.
 */
export async function inspectManagedAssets(
  root: string,
  desired: DesiredManagedAssets
): Promise<ManagedInspection> {
  const findings: ManagedAssetFinding[] = [];
  const notInspected: string[] = [];
  for (const step of desired.steps) {
    try {
      const boundary = await inspectManagedPathBoundary(root, step.path, step.scope ?? 'repo');
      if (boundary.symlink !== null) {
        findings.push({ path: step.path, state: 'conflict', code: 'asset_conflict' });
        continue;
      }
      const target = boundary.target;
      if (step.kind === 'write') {
        const existing = await readIfExists(target);
        if (existing !== null && step.isOwned !== undefined && !step.isOwned(existing)) {
          findings.push({ path: step.path, state: 'conflict', code: 'asset_conflict' });
          continue;
        }
        const content = step.merge(existing);
        if (content === null) {
          continue; // the resolver declined (an optional target): no claim
        }
        if (existing === null) {
          findings.push({ path: step.path, state: 'missing', code: 'asset_missing' });
          continue;
        }
        const mode = await statMode(target);
        const unchanged =
          existing === content && mode !== null && managedModeMatches(mode, step.mode);
        findings.push(
          unchanged
            ? { path: step.path, state: 'current' }
            : { path: step.path, state: 'stale', code: 'asset_stale' }
        );
      } else if (step.kind === 'remove') {
        const existing = await readIfExists(target);
        if (existing === null) {
          continue; // nothing to remove: clean by absence, no claim
        }
        findings.push(
          step.isOwned(existing)
            ? { path: step.path, state: 'stale', code: 'asset_stale' }
            : { path: step.path, state: 'conflict', code: 'asset_conflict' }
        );
      } else {
        notInspected.push(step.path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedReconcileError('plan', message, { kind: step.kind, path: step.path });
    }
  }
  return { findings, notInspected };
}

/**
 * Converge `root` to the desired managed-asset state in one reversible
 * transaction and report what happened. Throws `ManagedReconcileError`;
 * after a `commit` failure the tree is back to its pre-run state.
 */
export async function reconcileManagedAssets(
  root: string,
  desired: DesiredManagedAssets
): Promise<ManagedReconcileReport> {
  // ---- Plan phase: reads and resolvers, nothing written yet. ----
  // planManaged throws ManagedReconcileError('plan', …) with the failing step.
  const plan = await planManaged(root, desired);

  // ---- Commit phase: snapshots precede every mutation; rollback on failure. ----
  const report: ManagedReconcileReport = {
    created: [],
    updated: [],
    removed: [],
    preserved: plan.preserved,
  };
  const snapshots: Snapshot[] = [];
  const createdDirs: string[] = [];
  const snap = async (step: Pick<ManagedStep, 'path' | 'scope'>): Promise<Snapshot> => {
    // Build the snapshot fully BEFORE recording it: a read that throws must
    // never leave a half-initialized "did not exist" entry behind — rollback
    // would treat it as run-created and try to unlink it.
    const shot = await buildSnapshot(root, step.path, step.scope ?? 'repo');
    snapshots.push(shot);
    return shot;
  };

  let lastStep: { kind: ManagedStep['kind']; path: string } | null = null;
  try {
    for (const action of plan.actions) {
      lastStep = { kind: action.step.kind, path: action.step.path };
      // Re-check immediately before the mutation: planning and commit share
      // the boundary, and a link inserted after planning is still rejected.
      const target = await safeManagedTarget(root, action.step);
      if (action.kind === 'write') {
        // Build but do not record the snapshot until the write has re-proven
        // both its plan basis and (for whole-file targets) ownership. If an
        // earlier port write or another process changed these bytes after the
        // plan, rollback must restore earlier actions without touching this
        // newly user-owned target.
        const before = await buildSnapshot(
          root,
          action.step.path,
          action.step.scope ?? 'repo'
        );
        if (
          before.content !== null &&
          action.step.isOwned !== undefined &&
          !action.step.isOwned(before.content)
        ) {
          throw new Error(
            `${action.step.path} changed after planning and is no longer provably SpecGit-owned; refusing to replace it.`
          );
        }
        if (before.content !== action.basis) {
          throw new Error(
            `${action.step.path} changed after planning; refusing to overwrite bytes that were not used by its merge resolver.`
          );
        }
        snapshots.push(before);
        await ensureDirTracked(path.dirname(target), createdDirs);
        // Repairing an enforceable drift can mean the target is currently
        // write-protected: make it replaceable, then let the final chmod
        // land the desired (possibly protected) mode (#314).
        await ensureReplaceable(target);
        await fs.writeFile(target, action.content, 'utf-8');
        // Full-mode chmod is the platform-maximal enforcement (#314): exact
        // POSIX bits where enforced, the read-only contract on Windows.
        await fs.chmod(target, action.step.mode);
        (before.existed ? report.updated : report.created).push(action.step.path);
      } else if (action.kind === 'portWrite') {
        const before = await snap(action.step);
        await ensureDirTracked(path.dirname(target), createdDirs);
        await action.step.write();
        await safeManagedTarget(root, action.step);
        const after = await readIfExists(target);
        if (after === null) {
          // The port write did not touch the file — no claim of change.
          continue;
        }
        if (!before.existed) {
          report.created.push(action.step.path);
        } else if (after !== before.content) {
          report.updated.push(action.step.path);
        }
      } else {
        // Ownership is a claim about the bytes at the moment of deletion,
        // not the bytes observed during planning. An intervening user change
        // turns this action into a preserved conflict and never enters the
        // rollback stack; a changed but still-owned target remains removable.
        const before = await buildSnapshot(
          root,
          action.step.path,
          action.step.scope ?? 'repo'
        );
        if (before.content === null) {
          continue;
        }
        if (!action.step.isOwned(before.content)) {
          if (!report.preserved.includes(action.step.path)) {
            report.preserved.push(action.step.path);
          }
          continue;
        }
        snapshots.push(before);
        // A write-protected owned asset is still SpecGit's to retire — on
        // Windows unlink refuses read-only files (EPERM), so clear the
        // protection first; ownership was already proven from the bytes.
        await ensureReplaceable(target);
        await fs.unlink(target);
        await pruneEmptyDirs(root, target);
        report.removed.push(action.step.path);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollbackNote = await rollback(snapshots, createdDirs);
    throw new ManagedReconcileError(
      'commit',
      rollbackNote !== null ? `${message} (rollback incomplete: ${rollbackNote})` : message,
      lastStep
    );
  }

  return report;
}
