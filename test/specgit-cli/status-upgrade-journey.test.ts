/**
 * #308 — the product-level old-version upgrade journey, on a real
 * temporary git repository with real CLI runs and zero forge network.
 *
 * The fixture is a realistic OLDER committed adopting repository: an
 * old SpecGit-owned acceptance workflow, a stale managed AGENTS.md block,
 * the pre-#305 single-marker `.gitignore` region, and old setup surfaces
 * carrying marker-proven retired entries, an unowned look-alike (a
 * conflict only a human may resolve), and adjacent user files — every
 * fixture path tracked in git, because this adopter chose to commit them.
 *
 * The journey is the documented sequence: `status` names the drift and
 * the exact per-surface fixes → `init --force` converges the init-owned
 * tier → `setup --tool all` converges both agent surfaces → the human
 * resolves the one conflict status flagged (delete the leftover) →
 * `status` reports current/clean with user files byte-exact and owned
 * legacy entries gone → the upgrade result is committed and
 * `git status --porcelain` is EMPTY — after the commit, no generated
 * legacy or ignored residue reappears.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS } from '../../src/cli/exit-codes.js';
import {
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  managedPromptBlock,
} from '../../src/cli/harness-content.js';
import { HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-placement.js';
import { externalAcceptanceWorkflowYaml } from '../../src/cli/external-harness.js';
import { ENTRY_POINT_MARKER } from '../../src/cli/agent-surface.js';
import {
  LOCAL_ASSET_IGNORE_MARKER,
  managedIgnoreBlock,
} from '../../src/cli/commands/init-ignore.js';
import { makeCtx, makeGitFacts, parseStdoutJson, sampleBinding, samplePolicy } from './helpers.js';
import { git, isolatedGitEnv, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

/** The exact workflow bytes this test CLI version desires for an adopting repo on `main`. */
const CURRENT_EXTERNAL_WORKFLOW = externalAcceptanceWorkflowYaml({
  defaultBranch: 'main',
  version: '0.0.0-test',
});

/** An older SpecGit-generated acceptance workflow (owned: both markers present). */
const OLD_OWNED_WORKFLOW = `name: SpecGit Acceptance

on: [pull_request]
jobs:
  specgit-acceptance:
    runs-on: ubuntu-latest
    steps:
      - run: specgit finish --json
`;

const OLD_AGENTS = `# Project notes\n${BLOCK_START_MARKER}\nSTALE GUIDANCE\n${BLOCK_END_MARKER}\nTail.\n`;
const OLD_GITIGNORE = `node_modules/\n${LOCAL_ASSET_IGNORE_MARKER}\n/.specgit.yaml\n/my-user-rule/\n`;
const MIGRATED_GITIGNORE = `node_modules/\n${managedIgnoreBlock()}\n/my-user-rule/\n`;

const oldEntryPoint = (body: string) =>
  `---\ndescription: old\n---\n\n${ENTRY_POINT_MARKER}\n\n${body}`;

/** A released pre-marker skill: authorship in frontmatter is equivalent ownership evidence. */
const OLD_SKILL = `---\nname: specgit-issue\nmetadata:\n  author: specgit\n---\n\nold skill body\n`;

const RETIRED_OPENCODE = '.opencode/command/specgit-retired.md';
const UNOWNED_OPENCODE = '.opencode/command/specgit-unowned.md';
const USER_OPENCODE = '.opencode/command/user-notes.md';
const RETIRED_SKILL = '.agents/skills/specgit-audit/SKILL.md';
const USER_SKILL_EXTRA = '.agents/skills/specgit-issue/EXTRA.md';
const USER_SKILL_BYTES = '# user notes inside a current skill directory\n';

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('the old-version upgrade journey (#308)', () => {
  let tempDir: string;
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-journey-');
    root = path.join(tempDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
    env = isolatedGitEnv(tempDir);
    git(root, ['init', '-b', 'main'], env);

    // --- the older committed adopting repository ---
    write(root, HARNESS_WORKFLOW_PATH, OLD_OWNED_WORKFLOW);
    write(root, 'AGENTS.md', OLD_AGENTS);
    write(root, '.gitignore', OLD_GITIGNORE);
    write(root, '.opencode/command/specgit-issue.md', oldEntryPoint('old issue trigger'));
    write(root, RETIRED_OPENCODE, oldEntryPoint('an entry point this version retired'));
    write(root, UNOWNED_OPENCODE, '# looks like ours, is not — no marker, no author\n');
    write(root, USER_OPENCODE, '# user content\n');
    write(root, '.agents/skills/specgit-issue/SKILL.md', OLD_SKILL);
    write(root, RETIRED_SKILL, oldEntryPoint('a skill this version retired'));
    write(root, USER_SKILL_EXTRA, USER_SKILL_BYTES);

    // The adopter chose to commit every fixture path.
    git(root, ['add', '-A'], env);
    git(root, ['commit', '-q', '-m', 'old-version specgit adoption'], env);
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  function ctxFor(repoRoot: string) {
    return makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://github.com/LeXwDeX/adopted.git' }),
      root: { ok: true, value: repoRoot },
      cwd: repoRoot,
    });
  }

  it('status → init --force → setup --tool all → resolve conflict → status → clean commit', async () => {
    // ---- 1. status names every actionable state with its exact fix. ----
    const first = ctxFor(root);
    const firstExit = await runCliWith(['node', 'specgit', 'status', '--json'], first.ctx);
    expect(firstExit).toBe(EXIT_SUCCESS);
    const firstEnvelope = parseStdoutJson(first.io);
    const generated = firstEnvelope.assets.generated;
    expect(generated.clean).toBe(false);
    expect(generated.complete).toBe(true); // drift was fully proven, not unknown

    const init = generated.surfaces.find((s: any) => s.surface === 'init');
    expect(init.state).toBe('missing'); // required assets absent outrank the stale ones
    expect(init.fix).toBe('specgit init --force --no-protect');
    expect(init.assets.find((a: any) => a.path === HARNESS_WORKFLOW_PATH)).toMatchObject({
      state: 'stale',
      code: 'asset_stale',
    });
    expect(init.assets.find((a: any) => a.path === '.gitignore')).toMatchObject({
      state: 'stale',
      code: 'asset_stale',
    });

    const opencode = generated.surfaces.find((s: any) => s.surface === 'opencode');
    expect(opencode.state).toBe('conflict'); // the unowned look-alike blocks the repair
    expect(opencode.fix).toBe('specgit setup --tool opencode');
    expect(opencode.assets.find((a: any) => a.path === RETIRED_OPENCODE)).toMatchObject({
      state: 'stale',
      code: 'asset_stale',
    });
    expect(opencode.assets.find((a: any) => a.path === UNOWNED_OPENCODE)).toMatchObject({
      state: 'conflict',
      code: 'asset_conflict',
    });

    const generic = generated.surfaces.find((s: any) => s.surface === 'generic');
    expect(generic.state).toBe('missing'); // only specgit-issue is installed; the rest are absent
    expect(generic.fix).toBe('specgit setup --tool generic');

    // ---- 2. init --force converges the init-owned tier. ----
    const initRun = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://github.com/LeXwDeX/adopted.git' }),
      root: { ok: true, value: root },
      cwd: root,
    });
    const initExit = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      initRun.ctx
    );
    expect(initExit).toBe(EXIT_SUCCESS);
    expect(fs.readFileSync(path.join(root, ...HARNESS_WORKFLOW_PATH.split('/')), 'utf-8')).toBe(
      CURRENT_EXTERNAL_WORKFLOW
    );
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8')).toBe(
      `# Project notes\n${managedPromptBlock()}\nTail.\n`
    );
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')).toBe(MIGRATED_GITIGNORE);

    // ---- 3. setup --tool all converges both agent surfaces. ----
    const setupRun = ctxFor(root);
    const setupExit = await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], setupRun.ctx);
    expect(setupExit).toBe(EXIT_SUCCESS);
    const setupEnvelope = parseStdoutJson(setupRun.io);
    expect(setupEnvelope.assets.reconciled.removed).toEqual(
      expect.arrayContaining([RETIRED_OPENCODE, RETIRED_SKILL])
    );
    expect(setupEnvelope.assets.reconciled.preserved).toEqual([UNOWNED_OPENCODE]);
    expect(fs.existsSync(path.join(root, ...RETIRED_OPENCODE.split('/')))).toBe(false);
    expect(fs.existsSync(path.join(root, ...RETIRED_SKILL.split('/')))).toBe(false);
    // User content is byte-exact and directory pruning stopped at it.
    expect(fs.readFileSync(path.join(root, ...USER_OPENCODE.split('/')), 'utf-8')).toBe('# user content\n');
    expect(fs.readFileSync(path.join(root, ...USER_SKILL_EXTRA.split('/')), 'utf-8')).toBe(
      USER_SKILL_BYTES
    );

    // ---- 3.5 the human decision status flagged: the leftover is ours to delete. ----
    fs.rmSync(path.join(root, ...UNOWNED_OPENCODE.split('/')));

    // ---- 4. status reports current/clean; nothing user-owned was touched. ----
    const second = ctxFor(root);
    const secondExit = await runCliWith(['node', 'specgit', 'status', '--json'], second.ctx);
    expect(secondExit).toBe(EXIT_SUCCESS);
    const secondEnvelope = parseStdoutJson(second.io);
    const clean = secondEnvelope.assets.generated;
    expect(clean.clean).toBe(true);
    expect(clean.complete).toBe(true); // a clean claim requires a complete proof
    expect(clean.uninspected).toEqual([]);
    expect(clean.skipped).toEqual([]);
    for (const surface of clean.surfaces) {
      expect(surface.state, surface.surface).toBe('current');
      expect(surface.fix).toBeUndefined();
    }
    expect(fs.readFileSync(path.join(root, ...USER_OPENCODE.split('/')), 'utf-8')).toBe('# user content\n');
    expect(fs.readFileSync(path.join(root, ...USER_SKILL_EXTRA.split('/')), 'utf-8')).toBe(
      USER_SKILL_BYTES
    );

    // ---- 5. commit the intended upgrade result: no residue reappears. ----
    git(root, ['add', '-A'], env);
    git(root, ['commit', '-q', '-m', 'chore: refresh specgit generated assets to current CLI'], env);
    const porcelain = git(root, ['status', '--porcelain'], env);
    expect(porcelain).toBe('');
    // Owned legacy entries are gone from the tree, not just from status.
    expect(fs.existsSync(path.join(root, ...RETIRED_OPENCODE.split('/')))).toBe(false);
    expect(fs.existsSync(path.join(root, ...RETIRED_SKILL.split('/')))).toBe(false);
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'specgit-audit'))).toBe(false);
  });

  it('the journey never contacts the forge provider', async () => {
    const t = ctxFor(root);
    await runCliWith(['node', 'specgit', 'status', '--json'], t.ctx);
    expect(t.ghProvider.calls).toEqual([]);
  });
});
