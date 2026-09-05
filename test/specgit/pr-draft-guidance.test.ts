import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODE_INFO } from '../../src/acceptance/codes.js';
import { writeAgentSurface } from '../../src/cli/agent-surface.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

// #162 (audit P-1): a draft PR is the most frequent one-shot `finish`
// rejection, yet nothing told the agent that marking the PR ready for
// review is the repair. These pins lock the executable fix: the
// `pr_draft` diagnostic carries the concrete ready commands, and every
// finish skill surface names the pre-verdict draft check.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('#162: pr_draft carries an executable ready-for-review fix', () => {
  it('CODE_INFO.pr_draft is factual and names the concrete ready commands', () => {
    const info = CODE_INFO.pr_draft;
    expect(info.kind).toBe('factual');
    expect(info.fix).toBeDefined();
    // GitHub: the exact gh invocation with a number placeholder.
    expect(info.fix).toContain('gh pr ready <number>');
    // GitLab deliveries evaluate through glab — the equivalent is named too.
    expect(info.fix).toContain('glab mr update <number> --ready');
    // The fix closes the loop: re-run the verdict after the transition.
    expect(info.fix).toContain('specgit finish');
    expect(info.fix).not.toContain('specgit accept');
  });

  it('skills/specgit-finish/SKILL.md checks draft state before the verdict', () => {
    const skill = fs.readFileSync(
      path.join(REPO_ROOT, 'skills', 'specgit-finish', 'SKILL.md'),
      'utf-8'
    );
    expect(skill).toMatch(/## Steps/);
    // The pre-verdict step names the draft gate and the ready command.
    expect(skill).toMatch(/not a\s+draft/i);
    expect(skill).toContain('gh pr ready');
  });

  describe('the setup-installed finish skill carries the same guidance', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir('specgit-finish-skill-');
    });

    afterEach(() => {
      rmDir(tempDir);
    });

    it('generic install writes the draft-check step into the finish skill', async () => {
      await writeAgentSurface(tempDir, 'generic');
      const skill = fs.readFileSync(
        path.join(tempDir, '.agents', 'skills', 'specgit-finish', 'SKILL.md'),
        'utf-8'
      );
      expect(skill).toMatch(/## Steps/);
      expect(skill).toMatch(/not a\s+draft/i);
      expect(skill).toContain('gh pr ready');
    });
  });
});
