/**
 * #292: `specgit init` shields the local delivery assets from git by
 * default. Bootstrap rewrites the record, and `init --force` rewrites the
 * policy; without shielding those writes leak into unrelated commits. A
 * managed, idempotent region in the root `.gitignore` keeps them out of the
 * working-tree noise floor.
 *
 * #305: the region is delimited by start/end markers and RECONCILED — an
 * old-version region (the pre-#305 single-marker block, or a damaged
 * delimited block that lost its end marker) is replaced with the current
 * complete entry set, so entries introduced by a newer CLI version appear
 * inside the existing managed region. Migration consumes ONLY the marker
 * lines and the entry lines SpecGit knows it has ever written — an
 * adjacent user rule glued directly beneath with no blank separator keeps
 * its bytes and its position (adjacency is never treated as ownership).
 * Unrelated rules and formatting outside the region are preserved
 * byte-for-byte; a user who already lists every current entry without any
 * marker keeps their file untouched (the #292 no-duplication contract).
 *
 * Scope notes:
 * - `.gitignore` only hides UNTRACKED files. Repositories that already
 *   commit the record/policy (the dogfood repo, or any adopter that
 *   pinned the committed-authoritative model) keep working unchanged —
 *   for those, `--no-ignore` opts out of the block entirely.
 * - The write happens inside the managed-asset reconciliation transaction
 *   (#305): a failed init leaves the repository byte-identical (#62).
 */

import * as fs from 'node:fs/promises';

import { inspectManagedPathBoundary } from '../managed-reconcile.js';
import type { CommandContext } from '../types.js';

/** Rooted so a nested `spec_git/` directory elsewhere is never matched. */
export const LOCAL_ASSET_IGNORE_ENTRIES = [
  '/.specgit.yaml', '/spec_git/',
  '/.opencode/hooks/specgit-merge-guard.sh',
  ...['issue', 'finish', 'doctor', 'pr', 'status'].flatMap((command) => [
    `/.opencode/command/specgit-${command}.md`,
    `/.agents/skills/specgit-${command}/SKILL.md`,
  ]),
  '/.local/state/', '/.local/cache/',
] as const;

/** The pre-#305 managed block: a single marker line above the entries. */
export const LOCAL_ASSET_IGNORE_MARKER =
  '# specgit: local delivery assets (managed by specgit init)';

/** #305: the managed region is delimited by both markers, like the prompt block. */
export const LOCAL_ASSET_IGNORE_START =
  '# >>> specgit: local delivery assets (managed by specgit init) >>>';
export const LOCAL_ASSET_IGNORE_END =
  '# <<< specgit: local delivery assets (managed by specgit init) <<<';

export interface LocalAssetIgnoreResult {
  path: string;
  entries: string[];
  created: boolean;
}

/** The current managed region: start marker, complete entry set, end marker. */
export function managedIgnoreBlock(outsideRegion: string | null = null): string {
  const present = entryLines(outsideRegion ?? '');
  return [LOCAL_ASSET_IGNORE_START, ...LOCAL_ASSET_IGNORE_ENTRIES.filter((entry) => !present.has(entry)), LOCAL_ASSET_IGNORE_END].join(
    '\n'
  );
}

/**
 * True when the bytes carry a managed region SpecGit wrote — the current
 * delimited form, the damaged start-only form, or the legacy single-marker
 * block (#308). Read-side only: `status` distinguishes "a region exists,
 * keep it current" from "this repository opted out of the ignore block
 * entirely" before it dares to call an absent region drift.
 */
export function hasManagedIgnoreRegion(content: string | null): boolean {
  if (content === null) {
    return false;
  }
  const lines = content.split('\n');
  return (
    lines.some((line) => isMarkerLine(line, LOCAL_ASSET_IGNORE_START)) ||
    lines.some((line) => isMarkerLine(line, LOCAL_ASSET_IGNORE_MARKER))
  );
}

/** The tracked probe that distinguishes the committed-authoritative model. */
const AUTHORITATIVE_PATHS = ['.specgit.yaml', 'spec_git/policy.yaml'];

/**
 * Decide whether the `.gitignore` region may be claimed at all. `inspect`
 * when a managed region exists (keep it current) or when the local-asset
 * model applies. A repository that commits the authoritative tier has
 * deliberately opted out. Failed tracked-file or read evidence remains
 * unknown, so callers fail closed instead of guessing that the block is
 * missing.
 */
export type LocalAssetIgnoreClaim =
  | 'inspect'
  | 'ignore_committed_authoritative'
  | 'ignore_tracked_unknown'
  | 'ignore_unreadable';

/** Shared read-only decision used by status, guided init, and setup. */
export async function localAssetIgnoreClaim(
  root: string,
  ctx: CommandContext
): Promise<LocalAssetIgnoreClaim> {
  const gitignorePath = await inspectManagedPathBoundary(root, '.gitignore').catch(() => null);
  if (gitignorePath === null) {
    return 'ignore_unreadable';
  }
  if (gitignorePath.symlink !== null) {
    // Do not read through the link. `inspect` carries it into the shared
    // managed-path inspector as asset_conflict, and the writer rejects it
    // in its plan phase before any setup/init target is touched.
    return 'inspect';
  }
  let gitignore: string | null;
  try {
    gitignore = await fs.readFile(gitignorePath.target, 'utf-8');
  } catch (error) {
    // ENOENT and ENOTDIR are the only absence proofs accepted by the
    // reconciler. EISDIR, EACCES, and every other failure are unknown.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return 'ignore_unreadable';
    }
    gitignore = null;
  }
  if (hasManagedIgnoreRegion(gitignore)) {
    return 'inspect';
  }
  const trackedEv = await ctx.git.trackedFiles(root, [...AUTHORITATIVE_PATHS]);
  if (!trackedEv.ok) {
    return 'ignore_tracked_unknown';
  }
  return trackedEv.value.length > 0 ? 'ignore_committed_authoritative' : 'inspect';
}

function entryLines(content: string): Set<string> {
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
}

function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

/**
 * Every `.gitignore` line any released SpecGit generation has written
 * inside the managed region: entries have only ever been ADDED, so the
 * current entry set is the historical union. A future version that
 * RETIRES an entry must add it here anyway — a legacy migration may still
 * have to consume it out of an old region.
 */
const KNOWN_MANAGED_ENTRY_LINES: ReadonlySet<string> = new Set(LOCAL_ASSET_IGNORE_ENTRIES);

/**
 * Replace the line range [start, end) with the managed block lines,
 * preserving every other line byte-for-byte.
 */
function replaceLines(content: string, start: number, end: number): string {
  const lines = content.split('\n');
  const rebuilt = [
    ...lines.slice(0, start),
    ...managedIgnoreBlock([...lines.slice(0, start), ...lines.slice(end)].join('\n')).split('\n'),
    ...lines.slice(end),
  ];
  return rebuilt.join('\n');
}

/**
 * Pure reconciliation transform (#305): current `.gitignore` bytes → desired
 * bytes. Cases, all byte-stable on re-run:
 * - absent: the managed region alone (the file is created by the writer);
 * - current start/end markers: only the delimited region is replaced;
 * - start marker without its end (damaged region), or a legacy
 *   single-marker block (pre-#305): the marker line plus the consecutive
 *   run of KNOWN SpecGit entry lines after it is replaced — an unknown
 *   line (a user rule glued right beneath, no blank separator) ends the
 *   consumed run and keeps its bytes and position;
 * - no marker, but every current entry already listed: untouched (the
 *   #292 no-duplication contract — a user-managed listing is respected);
 * - otherwise: the managed region is appended after the existing content.
 */
export function reconcileLocalAssetIgnore(existing: string | null): string {
  const block = managedIgnoreBlock();
  if (existing === null) {
    return `${block}\n`;
  }

  const lines = existing.split('\n');

  let startIndex = -1;
  let pairedEnd = -1;
  for (let index = 0; index < lines.length; index++) {
    if (isMarkerLine(lines[index], LOCAL_ASSET_IGNORE_START)) startIndex = index;
    else if (startIndex !== -1 && isMarkerLine(lines[index], LOCAL_ASSET_IGNORE_END)) {
      pairedEnd = index;
      break;
    }
  }
  if (startIndex !== -1) {
    // An end marker BEFORE the start marker is a stray from an older
    // damage — only an end marker AFTER the start closes this region.
    const endIndex = pairedEnd;
    if (endIndex !== -1) {
      // A stray start before the nearest complete pair is only a marker,
      // never ownership of intervening user rules. Consume stray markers
      // so subsequent refreshes cannot expand the replaced region.
      const before = lines.slice(0, startIndex).filter((line) =>
        !isMarkerLine(line, LOCAL_ASSET_IGNORE_START) && !isMarkerLine(line, LOCAL_ASSET_IGNORE_END));
      const after = lines.slice(endIndex + 1);
      return [...before, ...managedIgnoreBlock([...before, ...after].join('\n')).split('\n'), ...after].join('\n');
    }
    // Start marker without its end (damaged region): migrate from the
    // marker through the known entries, same proof as the legacy shape.
    const before = lines.slice(0, startIndex).filter((line) =>
      !isMarkerLine(line, LOCAL_ASSET_IGNORE_START) && !isMarkerLine(line, LOCAL_ASSET_IGNORE_END));
    return [...before, replaceMarkerAndKnownEntries(lines.slice(startIndex).join('\n'), 0)].join('\n');
  }

  const legacyIndex = lines.findIndex((line) => isMarkerLine(line, LOCAL_ASSET_IGNORE_MARKER));
  if (legacyIndex !== -1) {
    return replaceMarkerAndKnownEntries(existing, legacyIndex);
  }

  const present = entryLines(existing);
  if (LOCAL_ASSET_IGNORE_ENTRIES.every((entry) => present.has(entry))) {
    return existing;
  }

  const separator = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  return `${existing}${separator}${managedIgnoreBlock(existing)}\n`;
}

/**
 * Replace the marker line at `from` plus ONLY the consecutive known SpecGit
 * entry lines after it with the managed block. Migration works by proof,
 * never by adjacency: an unknown line — a user rule glued directly beneath
 * the marker with no blank line — ends the consumed run and keeps its
 * bytes and position.
 */
function replaceMarkerAndKnownEntries(content: string, from: number): string {
  const lines = content.split('\n');
  let end = from + 1;
  while (end < lines.length && KNOWN_MANAGED_ENTRY_LINES.has(lines[end].trim())) {
    end++;
  }
  return replaceLines(content, from, end);
}
