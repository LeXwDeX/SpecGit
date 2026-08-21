import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCliWith } from '../../src/cli/index.js';
import {
  ISSUE_TITLE_TYPES,
  ISSUE_TYPE_LIST,
  validateIssueTitles,
} from '../../src/cli/commands/issue.js';
import { writeAgentSurface } from '../../src/cli/agent-surface.js';
import { makeCtx, stdoutText } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

// #174: `specgit issue` rejects titles without a conventional type
// prefix, but the allowed set was never listed where an agent looks
// before running the command. These pins lock the validator's source of
// truth into the help text, the skill, and the usage-error fix, so the
// documented list and the validator cannot drift.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('#174: the allowed issue-title type list is documented', () => {
  it('exposes the 14 accepted conventional types as the single source of truth', () => {
    expect(ISSUE_TITLE_TYPES).toEqual([
      'feat',
      'fix',
      'refactor',
      'perf',
      'docs',
      'test',
      'chore',
      'style',
      'build',
      'ci',
      'revert',
      'security',
      'deprecate',
      'dogfood',
    ]);
    expect(ISSUE_TYPE_LIST).toBe(ISSUE_TITLE_TYPES.join(', '));
  });

  it('specgit issue --help lists every accepted conventional type', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', 'issue', '--help'], t.ctx);
    const help = stdoutText(t.io);
    for (const type of ISSUE_TITLE_TYPES) {
      expect(help, `issue help must list the type '${type}'`).toContain(type);
    }
  });

  it('the usage-error fix lists exactly the validator source of truth', () => {
    const error = validateIssueTitles(['bogus: not a real type']);
    expect(error).not.toBeNull();
    expect(error!.fix).toContain(ISSUE_TYPE_LIST);
  });

  it('skills/specgit-issue/SKILL.md lists the exact allowed set', () => {
    const skill = fs.readFileSync(
      path.join(REPO_ROOT, 'skills', 'specgit-issue', 'SKILL.md'),
      'utf-8'
    );
    expect(skill).toContain(ISSUE_TYPE_LIST);
  });

  describe('the setup-installed issue skill carries the same list', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir('specgit-issue-types-');
    });

    afterEach(() => {
      rmDir(tempDir);
    });

    it('generic install writes the issue skill with the allowed set', async () => {
      await writeAgentSurface(tempDir, 'generic');
      const skill = fs.readFileSync(
        path.join(tempDir, '.agents', 'skills', 'specgit-issue', 'SKILL.md'),
        'utf-8'
      );
      expect(skill).toContain(ISSUE_TYPE_LIST);
    });
  });
});
