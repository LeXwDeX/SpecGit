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
 * Paths in specs and reports are repo-relative with forward slashes.
 */

import * as fs from 'node:fs/promises';
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

export type ManagedStep =
  | {
      kind: 'write';
      path: string;
      mode: number;
      /**
       * Pure resolver: current bytes (null when the file is absent) →
       * desired bytes. Returning null plans no write — the resolver's
       * closure owns surfacing why (a merge refused, an optional target).
       */
      merge: (existing: string | null) => string | null;
    }
  | {
      kind: 'portWrite';
      path: string;
      /**
       * An owned write the module must not perform itself (a port call such
       * as the record port's writePolicy). The transaction still snapshots
       * the target before and classifies the outcome after.
       */
      write: () => Promise<void>;
    }
  | {
      kind: 'remove';
      path: string;
      /** True when the existing bytes prove SpecGit ownership (safe delete). */
      isOwned: (existing: string) => boolean;
    };

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
  const stat = await fs.stat(target).catch(() => null);
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
  const mode = await statMode(target);
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
    !(await fs.stat(cursor).then(() => true).catch(() => false))
  ) {
    missing.push(cursor);
    cursor = path.dirname(cursor);
  }
  return missing;
}

/** Build a full snapshot of `target` (bytes, mode, missing ancestors). */
async function buildSnapshot(target: string, root: string): Promise<Snapshot> {
  const content = await readIfExists(target);
  return {
    target,
    existed: content !== null,
    content,
    mode: await statMode(target),
    missingDirs: await missingDirsBelow(path.dirname(target), root),
  };
}

/** Public snapshot primitive: capture a file's pre-run state (bytes + mode). */
export async function snapshotManagedFile(
  root: string,
  relPath: string
): Promise<Snapshot> {
  return buildSnapshot(path.join(root, ...relPath.split('/')), root);
}

/** Public restore primitive: put a snapshot back byte-and-mode-exact. */
export async function restoreManagedSnapshot(snapshot: Snapshot): Promise<void> {
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

type PlannedAction =
  | { kind: 'write'; step: Extract<ManagedStep, { kind: 'write' }>; content: string }
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
    const target = path.join(root, ...step.path.split('/'));
    try {
      if (step.kind === 'write') {
        const existing = await readIfExists(target);
        const content = step.merge(existing);
        if (content === null) {
          continue;
        }
        if (existing === null) {
          actions.push({ kind: 'write', step, content });
          continue;
        }
        const mode = await statMode(target);
        const unchanged =
          existing === content && mode !== null && managedModeMatches(mode, step.mode);
        if (!unchanged) {
          actions.push({ kind: 'write', step, content });
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
    const target = path.join(root, ...step.path.split('/'));
    try {
      if (step.kind === 'write') {
        const existing = await readIfExists(target);
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
  const snap = async (target: string): Promise<Snapshot> => {
    // Build the snapshot fully BEFORE recording it: a read that throws must
    // never leave a half-initialized "did not exist" entry behind — rollback
    // would treat it as run-created and try to unlink it.
    const shot = await buildSnapshot(target, root);
    snapshots.push(shot);
    return shot;
  };

  let lastStep: { kind: ManagedStep['kind']; path: string } | null = null;
  try {
    for (const action of plan.actions) {
      lastStep = { kind: action.step.kind, path: action.step.path };
      const target = path.join(root, ...action.step.path.split('/'));
      if (action.kind === 'write') {
        const before = await snap(target);
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
        const before = await snap(target);
        await ensureDirTracked(path.dirname(target), createdDirs);
        await action.step.write();
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
        await snap(target);
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
