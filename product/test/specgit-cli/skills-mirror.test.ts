import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeAgentSurface } from '../../src/cli/agent-surface.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

// #368 — the tracked portable skills under skills/ are the distribution
// mirror of the setup generator's generic surface, not a second hand-held
// source. Byte-exact equality with what `specgit setup --tool generic`
// installs means: one authoritative generation path (the templates in
// src/cli/agent-surface.ts), and semantic/version drift between the
// generated and distributed copies is structurally impossible to miss.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIRROR_DIR = path.join(REPO_ROOT, 'skills');
const SKILL_NAMES = [
  'specgit-doctor',
  'specgit-finish',
  'specgit-issue',
  'specgit-pr',
  'specgit-status',
] as const;

function gitInit(root: string): void {
  execFileSync('git', ['init', '-q', root]);
}

async function renderedGenericSkills(): Promise<Map<string, string>> {
  const tempDir = makeTempDir('specgit-skills-mirror-');
  gitInit(tempDir);
  try {
    await writeAgentSurface(tempDir, 'generic');
    const rendered = new Map<string, string>();
    for (const name of SKILL_NAMES) {
      rendered.set(
        name,
        fs.readFileSync(path.join(tempDir, '.agents', 'skills', name, 'SKILL.md'), 'utf-8')
      );
    }
    return rendered;
  } finally {
    rmDir(tempDir);
  }
}

describe('portable skills distribution mirror (#368)', () => {
  it.each(SKILL_NAMES)('%s/SKILL.md is byte-identical to the setup generic surface', async (name) => {
    const rendered = await renderedGenericSkills();
    const generated = rendered.get(name);
    expect(generated, `setup must render ${name}/SKILL.md`).toBeDefined();
    const distributed = fs.readFileSync(path.join(MIRROR_DIR, name, 'SKILL.md'), 'utf-8');
    expect(distributed).toBe(generated);
  });

  it('the mirror carries exactly the five skills plus the index README', () => {
    const entries = fs.readdirSync(MIRROR_DIR).sort();
    expect(entries).toEqual([...SKILL_NAMES, 'README.md'].sort());
  });
});
