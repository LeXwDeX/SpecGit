/**
 * #292: `specgit init` shields the local delivery assets from git by
 * default. The record and the policy are rewritten by every bootstrap
 * and `init --force`; without shielding those rewrites leak into
 * unrelated commits. A managed, idempotent block in the root
 * `.gitignore` keeps them out of the working-tree noise floor.
 *
 * Scope notes:
 * - `.gitignore` only hides UNTRACKED files. Repositories that already
 *   commit the record/policy (the dogfood repo, or any adopter that
 *   pinned the committed-authoritative model) keep working unchanged —
 *   for those, `--no-ignore` opts out of the block entirely.
 * - The write happens in the mutation phase only: a rejected init
 *   leaves the repository byte-identical (#62).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** Rooted so a nested `spec_git/` directory elsewhere is never matched. */
export const LOCAL_ASSET_IGNORE_ENTRIES = ['/.specgit.yaml', '/spec_git/'] as const;

export const LOCAL_ASSET_IGNORE_MARKER =
  '# specgit: local delivery assets (managed by specgit init)';

export interface LocalAssetIgnoreResult {
  path: string;
  entries: string[];
  created: boolean;
}

function entryLines(content: string): Set<string> {
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
}

/**
 * Ensure the root `.gitignore` carries the managed local-asset entries.
 * Idempotent: an existing managed block or user-added entry lines are
 * never duplicated. Existing content is always preserved.
 */
export function writeLocalAssetIgnore(root: string): LocalAssetIgnoreResult {
  const gitignorePath = path.join(root, '.gitignore');
  let content: string | null = null;
  try {
    content = readFileSync(gitignorePath, 'utf-8');
  } catch {
    content = null;
  }

  const entries = [...LOCAL_ASSET_IGNORE_ENTRIES];
  if (content === null) {
    const block = [LOCAL_ASSET_IGNORE_MARKER, ...entries, ''].join('\n');
    writeFileSync(gitignorePath, block, 'utf-8');
    return { path: '.gitignore', entries, created: true };
  }

  if (content.includes(LOCAL_ASSET_IGNORE_MARKER)) {
    return { path: '.gitignore', entries, created: false };
  }

  const present = entryLines(content);
  if (entries.every((entry) => present.has(entry))) {
    return { path: '.gitignore', entries, created: false };
  }

  const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  const block = `${separator}${[LOCAL_ASSET_IGNORE_MARKER, ...entries, ''].join('\n')}`;
  writeFileSync(gitignorePath, content + block, 'utf-8');
  return { path: '.gitignore', entries, created: false };
}
