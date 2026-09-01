#!/usr/bin/env node
// Regenerates the tracked portable-skills mirror (skills/) from the built
// CLI — the exact bytes `specgit setup --tool generic` installs, marker and
// frontmatter included. One authoritative generation path (#368): the
// skill text lives in src/cli/agent-surface.ts; this script and
// test/specgit-cli/skills-mirror.test.ts keep the tracked copy from
// drifting into a second, stale source.
//
// Usage: pnpm run build && pnpm run build:skills

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirrorDir = path.join(repoRoot, 'skills');
const SKILL_NAMES = [
  'specgit-doctor',
  'specgit-finish',
  'specgit-issue',
  'specgit-pr',
  'specgit-status',
];

const { writeAgentSurface } = await import(
  path.join(repoRoot, 'dist', 'cli', 'agent-surface.js')
);

const tempRoot = await mkdtemp(path.join(tmpdir(), 'specgit-build-skills-'));
execFileSync('git', ['init', '-q', tempRoot]);
try {
  await writeAgentSurface(tempRoot, 'generic');
  let changed = 0;
  for (const name of SKILL_NAMES) {
    const generated = await readFile(
      path.join(tempRoot, '.agents', 'skills', name, 'SKILL.md'),
      'utf8'
    );
    const target = path.join(mirrorDir, name, 'SKILL.md');
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current !== generated) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, generated);
      changed += 1;
      console.log(`  updated skills/${name}/SKILL.md`);
    }
  }
  console.log(
    changed === 0
      ? 'skills/ mirror already current — no writes.'
      : `skills/ mirror regenerated (${changed} file${changed === 1 ? '' : 's'} changed).`
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
