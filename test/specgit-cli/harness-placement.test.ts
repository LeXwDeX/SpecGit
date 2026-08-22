/**
 * Harness placement (#280): takes content bytes and owns planning,
 * writing, and rollback. Existing files are seeded with trivial fixture
 * bytes — placement must carry them through without inspecting them —
 * and the two failure phases report distinguishable errors: `plan`
 * (content) before anything is written, `commit` (write) with rollback.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BLOCK_START_MARKER } from '../../src/cli/harness-content.js';
import {
  HARNESS_WORKFLOW_PATH,
  HarnessWriteError,
  writeHarnessAssets,
} from '../../src/cli/harness-placement.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const skipGitHook = { resolveHooksDir: async () => null };

function read(target: string): string {
  return fs.readFileSync(target, 'utf-8');
}

function treeBytes(root: string): Map<string, string> {
  const bytes = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes.set(path.relative(root, full), read(full));
    }
  };
  walk(root);
  return bytes;
}

describe('writeHarnessAssets placement', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-placement-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('carries trivial fixture bytes through the merge, writes every target', async () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# trivial notes\n');
    fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.opencode', 'hooks.json'), '{ "custom": true }\n');

    const result = await writeHarnessAssets(root, { ...skipGitHook, workflowYaml: 'name: fixture\n' });

    expect(result.workflow).toBe(HARNESS_WORKFLOW_PATH);
    expect(result.warnings).toEqual([]);
    // The fixture bytes survive; the managed region is added after them.
    const agents = read(path.join(root, 'AGENTS.md'));
    expect(agents.startsWith('# trivial notes\n')).toBe(true);
    expect(agents).toContain(BLOCK_START_MARKER);
    const hooksJson = JSON.parse(read(path.join(root, '.opencode', 'hooks.json'))) as {
      custom: boolean;
    };
    expect(hooksJson.custom).toBe(true);
    // The caller-supplied workflow bytes are written verbatim: placement
    // never inspects what the bytes say.
    expect(read(path.join(root, ...HARNESS_WORKFLOW_PATH.split('/')))).toBe('name: fixture\n');
  });

  it('is byte-stable: a second write leaves the whole tree identical', async () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# trivial notes\n');
    await writeHarnessAssets(root, skipGitHook);
    const first = treeBytes(root);
    await writeHarnessAssets(root, skipGitHook);
    expect(treeBytes(root)).toEqual(first);
  });

  it('a commit-phase failure reports phase `commit` and rolls back the tree', async () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# trivial notes\n');
    // `.opencode` as a regular file: mkdir inside it fails mid-commit.
    fs.writeFileSync(path.join(root, '.opencode'), 'not a directory');

    let caught: unknown;
    try {
      await writeHarnessAssets(root, skipGitHook);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HarnessWriteError);
    expect((caught as HarnessWriteError).phase).toBe('commit');
    // Rollback restored the fixture bytes and removed everything created.
    expect(read(path.join(root, 'AGENTS.md'))).toBe('# trivial notes\n');
    expect(read(path.join(root, '.opencode'))).toBe('not a directory');
    expect(fs.existsSync(path.join(root, '.github'))).toBe(false);
  });

  it('a plan-phase failure reports phase `plan` before any write happens', async () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# trivial notes\n');
    const before = treeBytes(root);

    let caught: unknown;
    try {
      await writeHarnessAssets(root, {
        workflowYaml: 'name: fixture\n',
        resolveHooksDir: async () => {
          throw new Error('hooks resolution exploded');
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HarnessWriteError);
    expect((caught as HarnessWriteError).phase).toBe('plan');
    expect((caught as HarnessWriteError).message).toContain('hooks resolution exploded');
    // Nothing was written: the phases are distinguishable by tree state too.
    expect(treeBytes(root)).toEqual(before);
  });
});
