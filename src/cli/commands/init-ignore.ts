/**
 * #292: `specgit init` shields the local delivery assets from git by
 * default. The record and the policy are rewritten by every bootstrap and
 * `init --force`; without shielding those rewrites leak into unrelated
 * commits. A managed, idempotent region in the root `.gitignore` keeps
 * them out of the working-tree noise floor.
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

/** Rooted so a nested `spec_git/` directory elsewhere is never matched. */
export const LOCAL_ASSET_IGNORE_ENTRIES = ['/.specgit.yaml', '/spec_git/'] as const;

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
export function managedIgnoreBlock(): string {
  return [LOCAL_ASSET_IGNORE_START, ...LOCAL_ASSET_IGNORE_ENTRIES, LOCAL_ASSET_IGNORE_END].join(
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
    ...managedIgnoreBlock().split('\n'),
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

  const startIndex = lines.findIndex((line) => isMarkerLine(line, LOCAL_ASSET_IGNORE_START));
  if (startIndex !== -1) {
    // An end marker BEFORE the start marker is a stray from an older
    // damage — only an end marker AFTER the start closes this region.
    const endIndex = lines.findIndex(
      (line, index) => index > startIndex && isMarkerLine(line, LOCAL_ASSET_IGNORE_END)
    );
    if (endIndex !== -1) {
      return replaceLines(existing, startIndex, endIndex + 1);
    }
    // Start marker without its end (damaged region): migrate from the
    // marker through the known entries, same proof as the legacy shape.
    return replaceMarkerAndKnownEntries(existing, startIndex);
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
  return `${existing}${separator}${block}\n`;
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
