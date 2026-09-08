import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAgentSurface } from '../../src/cli/agent-surface.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

// #165: exit 3 is the one verdict outcome an agent cannot resolve by
// editing the delivery. These pins lock the exit-3 diagnostic loop into
// a dedicated skill: run `specgit doctor`, read the failing probe, apply
// its fix, re-run `finish` — and parse only `--json` output.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('#165: specgit-doctor skill describes the exit-3 diagnostic loop', () => {
  it('skills/specgit-doctor/SKILL.md exists and names the loop', () => {
    const skill = fs.readFileSync(
      path.join(REPO_ROOT, 'skills', 'specgit-doctor', 'SKILL.md'),
      'utf-8'
    );
    expect(skill).toContain('name: specgit-doctor');
    // The loop itself: doctor → read the failing probe → fix → re-run.
    expect(skill).toContain('specgit doctor --json');
    expect(skill).toMatch(/exit\s+3|exit code 3|`3`/);
    expect(skill).toContain('specgit finish --json');
    // The machine contract: `--json` is the only parse surface.
    expect(skill).toMatch(/only parse surface|--json/);
    // Never mask an unknown verdict: the record and policy stay untouched.
    expect(skill).toMatch(/never.*(record|policy)/i);
  });

  describe('the setup-installed doctor skill carries the same loop', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir('specgit-doctor-skill-');
    });

    afterEach(() => {
      rmDir(tempDir);
    });

    it('generic install writes the doctor skill with the loop', async () => {
      await writeAgentSurface(tempDir, 'generic');
      const skill = fs.readFileSync(
        path.join(tempDir, '.agents', 'skills', 'specgit-doctor', 'SKILL.md'),
        'utf-8'
      );
      expect(skill).toContain('name: specgit-doctor');
      expect(skill).toContain('specgit doctor --json');
      expect(skill).toContain('specgit finish --json');
    });
  });
});
