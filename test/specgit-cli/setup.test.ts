import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runSetup } from '../../src/cli/commands/setup.js';
import {
  detectSetupTool,
  ENTRY_POINT_MARKER,
  isSpecGitOwnedEntryPoint,
  writeAgentSurface,
} from '../../src/cli/agent-surface.js';
import { runCliWith } from '../../src/cli/index.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';
import { makeCtx, parseStdoutJson } from './helpers.js';

function gitInit(root: string): void {
  execFileSync('git', ['init', '-q', root]);
}

describe('specgit setup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-setup-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('auto-detects generic when no .opencode directory exists', async () => {
    gitInit(tempDir);
    expect(await detectSetupTool(tempDir)).toBe('generic');
  });

  it('auto-detects opencode when .opencode exists', async () => {
    gitInit(tempDir);
    fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
    expect(await detectSetupTool(tempDir)).toBe('opencode');
  });

  it('installs generic skills under .agents/skills', async () => {
    gitInit(tempDir);
    const result = await writeAgentSurface(tempDir, 'generic');
    expect(result.installed.sort()).toEqual([
      '.agents/skills/specgit-doctor/SKILL.md',
      '.agents/skills/specgit-finish/SKILL.md',
      '.agents/skills/specgit-issue/SKILL.md',
      '.agents/skills/specgit-pr/SKILL.md',
      '.agents/skills/specgit-status/SKILL.md',
    ]);
    const skill = fs.readFileSync(
      path.join(tempDir, '.agents', 'skills', 'specgit-issue', 'SKILL.md'),
      'utf-8'
    );
    expect(skill).toContain('name: specgit-issue');
    expect(skill).toContain('specgit issue');
  });

  it('installs opencode commands under .opencode/command', async () => {
    gitInit(tempDir);
    const result = await writeAgentSurface(tempDir, 'opencode');
    expect(result.installed.sort()).toEqual([
      '.opencode/command/specgit-doctor.md',
      '.opencode/command/specgit-finish.md',
      '.opencode/command/specgit-issue.md',
      '.opencode/command/specgit-pr.md',
      '.opencode/command/specgit-status.md',
    ]);
    const cmd = fs.readFileSync(
      path.join(tempDir, '.opencode', 'command', 'specgit-finish.md'),
      'utf-8'
    );
    expect(cmd).toContain('specgit finish --json');
  });

  // #164: a broken binding or an unknown verdict must have an installed
  // path — setup installs doctor, pr, and status alongside issue/finish.
  it('installs doctor, pr, and status entry points on both surfaces', async () => {
    gitInit(tempDir);
    await writeAgentSurface(tempDir, 'all');
    const doctorSkill = fs.readFileSync(
      path.join(tempDir, '.agents', 'skills', 'specgit-doctor', 'SKILL.md'),
      'utf-8'
    );
    expect(doctorSkill).toContain('name: specgit-doctor');
    expect(doctorSkill).toContain('specgit doctor --json');
    const doctorCmd = fs.readFileSync(
      path.join(tempDir, '.opencode', 'command', 'specgit-doctor.md'),
      'utf-8'
    );
    expect(doctorCmd).toContain('specgit doctor --json');
    const prSkill = fs.readFileSync(
      path.join(tempDir, '.agents', 'skills', 'specgit-pr', 'SKILL.md'),
      'utf-8'
    );
    expect(prSkill).toContain('name: specgit-pr');
    const statusCmd = fs.readFileSync(
      path.join(tempDir, '.opencode', 'command', 'specgit-status.md'),
      'utf-8'
    );
    expect(statusCmd).toContain('specgit status --json');
  });

  it('installs both surfaces for all and is idempotent', async () => {
    gitInit(tempDir);
    const first = await writeAgentSurface(tempDir, 'all');
    expect(first.installed).toHaveLength(10);
    const second = await writeAgentSurface(tempDir, 'all');
    expect(second.installed).toHaveLength(10);
    const file = path.join(tempDir, '.opencode', 'command', 'specgit-issue.md');
    expect(fs.readFileSync(file, 'utf-8')).toEqual(fs.readFileSync(file, 'utf-8'));
  });

  it('rejects an unknown tool with usage exit', async () => {
    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const outcome = await runSetup({ tool: 'vscode-extension', json: true }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('setup_tool_invalid');
  });

  // #168: setup --json emits structured assets — the detected/requested tool
  // and every installed entry point — instead of prose only.
  it('emits structured assets (tool + installed entry points) in the outcome (#168)', async () => {
    gitInit(tempDir);
    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const outcome = await runSetup({ tool: 'generic', json: true }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(outcome.assets).toBeDefined();
    expect(outcome.assets?.tool).toBe('generic');
    expect([...(outcome.assets?.installed as string[])].sort()).toEqual([
        '.agents/skills/specgit-doctor/SKILL.md',
        '.agents/skills/specgit-finish/SKILL.md',
        '.agents/skills/specgit-issue/SKILL.md',
        '.agents/skills/specgit-pr/SKILL.md',
        '.agents/skills/specgit-status/SKILL.md',
      ]);
  });

  it('keeps the human-readable output unchanged alongside the structured assets (#168)', async () => {
    gitInit(tempDir);
    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const outcome = await runSetup({ tool: 'generic', json: false }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(outcome.human).toBeDefined();
    const joined = (outcome.human ?? []).join('\n');
    expect(joined).toContain('.agents/skills/specgit-issue/SKILL.md');
  });

  it('exposes the structured assets payload through the --json envelope (#168)', async () => {
    gitInit(tempDir);
    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(
      ['node', 'specgit', 'setup', '--tool', 'opencode', '--json'],
      t.ctx
    );
    expect(code).toBe(0);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.command).toBe('setup');
    expect(envelope.assets).toBeDefined();
    expect(envelope.assets.tool).toBe('opencode');
    expect(envelope.assets.installed.sort()).toEqual([
      '.opencode/command/specgit-doctor.md',
      '.opencode/command/specgit-finish.md',
      '.opencode/command/specgit-issue.md',
      '.opencode/command/specgit-pr.md',
      '.opencode/command/specgit-status.md',
    ]);
    // Stdout carries exactly one JSON document; no prose leaks onto it.
    expect(t.io.stdout.join('').startsWith('{')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #307 — setup surface convergence: re-running setup after a CLI upgrade
// rebuilds the selected surface, removes marker-proven retired entries,
// preserves user content, and round-trips the tree on any failure.
// ---------------------------------------------------------------------------

/** A prior/future version's retired command — ownership-proven by the marker. */
const RETIRED_OWNED_COMMAND = `---
description: A retired SpecGit trigger
---

${ENTRY_POINT_MARKER}

# /specgit-retired

Retired trigger.
`;

/**
 * A prior released version's retired skill: the generic-skill shape every
 * released version writes — authorship metadata, no HTML marker yet. The
 * metadata line is released ownership evidence, so retirement still proves.
 */
const RETIRED_OWNED_SKILL = `---
name: specgit-retired
description: A retired SpecGit skill
license: MIT
metadata:
  author: specgit
---

# specgit-retired

Retired skill.
`;

/**
 * A user-authored retired candidate whose Markdown body merely mentions
 * the authorship string as prose. Body text is not frontmatter metadata,
 * so it must never prove ownership (#307 regression).
 */
const UNMARKED_SKILL_QUOTING_AUTHOR = `---
name: specgit-migration-notes
description: My own notes about released skill metadata
metadata:
  author: suntao
---

# specgit-migration-notes

Released skills self-identify with \`author: specgit\` in their frontmatter;
a file that merely discusses that line is not SpecGit's to delete.
`;

/**
 * A user-authored retired candidate whose Markdown body quotes the
 * ownership marker as prose. The marker proves ownership only at the
 * writer's anchor — the leading line without frontmatter, directly
 * after the closing frontmatter fence otherwise — so a body mention is
 * not SpecGit's to delete (#307 regression).
 */
const UNMARKED_COMMAND_QUOTING_MARKER = `---
description: My own notes about the specgit ownership marker
---

# specgit-marker-notes

Generated entries carry \`${ENTRY_POINT_MARKER}\` right after their
frontmatter; a file that merely discusses that line is not SpecGit's
to delete.
`;

/** Full-file snapshot: bytes AND mode, so round-trips are exact. */
function treeState(root: string): Map<string, { content: string; mode: number }> {
  const state = new Map<string, { content: string; mode: number }>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        state.set(path.relative(root, full), {
          content: fs.readFileSync(full, 'utf-8'),
          mode: fs.statSync(full).mode,
        });
      }
    }
  };
  walk(root);
  return state;
}

describe('specgit setup: version-upgrade convergence (#307)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-setup-upgrade-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('stamps every generated entry point with the ownership marker', async () => {
    gitInit(tempDir);
    await writeAgentSurface(tempDir, 'all');
    let marked = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, 'utf-8').includes(ENTRY_POINT_MARKER)) marked += 1;
      }
    };
    walk(tempDir);
    expect(marked).toBe(10);
  });

  it('proves ownership from the marker or the released skill authorship metadata only', () => {
    expect(isSpecGitOwnedEntryPoint(RETIRED_OWNED_COMMAND)).toBe(true);
    expect(isSpecGitOwnedEntryPoint(RETIRED_OWNED_SKILL)).toBe(true);
    // Arbitrary user files — including specgit-* names — never prove.
    expect(isSpecGitOwnedEntryPoint('# my own specgit-notes\n')).toBe(false);
    expect(isSpecGitOwnedEntryPoint('---\nname: specgit-mine\n---\n\n# mine\n')).toBe(false);
    // Prose mentioning the authorship string is not frontmatter metadata.
    expect(isSpecGitOwnedEntryPoint(UNMARKED_SKILL_QUOTING_AUTHOR)).toBe(false);
    expect(isSpecGitOwnedEntryPoint('# notes\n\ndiscussion of author: specgit in body text\n')).toBe(
      false
    );
    // Prose quoting the ownership marker is not the writer's anchor.
    expect(isSpecGitOwnedEntryPoint(UNMARKED_COMMAND_QUOTING_MARKER)).toBe(false);
    // The writer's anchors: the leading line without frontmatter…
    expect(isSpecGitOwnedEntryPoint(`${ENTRY_POINT_MARKER}\n\n# no frontmatter\n`)).toBe(true);
    // …and directly after the frontmatter close fence.
    expect(
      isSpecGitOwnedEntryPoint(`---\ndescription: x\n---\n\n${ENTRY_POINT_MARKER}\n\n# body\n`)
    ).toBe(true);
  });

  it('removes retired SpecGit-owned entry points; unmarked siblings survive byte-for-byte', async () => {
    gitInit(tempDir);
    const commandDir = path.join(tempDir, '.opencode', 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, 'specgit-retired.md'), RETIRED_OWNED_COMMAND);
    const unmarkedCommandPath = path.join(commandDir, 'specgit-mine.md');
    fs.writeFileSync(unmarkedCommandPath, '# my own trigger\n');
    fs.writeFileSync(path.join(commandDir, 'user-notes.md'), 'notes\n');
    const retiredSkillDir = path.join(tempDir, '.agents', 'skills', 'specgit-retired');
    fs.mkdirSync(retiredSkillDir, { recursive: true });
    fs.writeFileSync(path.join(retiredSkillDir, 'SKILL.md'), RETIRED_OWNED_SKILL);
    const unmarkedSkillPath = path.join(tempDir, '.agents', 'skills', 'specgit-mine', 'SKILL.md');
    fs.mkdirSync(path.dirname(unmarkedSkillPath), { recursive: true });
    fs.writeFileSync(unmarkedSkillPath, '# my own skill\n');

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], t.ctx);
    expect(code).toBe(0);

    // Retired, ownership-proven entries are gone; the emptied dir is pruned.
    expect(fs.existsSync(path.join(commandDir, 'specgit-retired.md'))).toBe(false);
    expect(fs.existsSync(path.join(retiredSkillDir, 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(retiredSkillDir)).toBe(false);
    // Unmarked specgit-* files and unrelated files survive byte-for-byte.
    expect(fs.readFileSync(unmarkedCommandPath, 'utf-8')).toBe('# my own trigger\n');
    expect(fs.readFileSync(unmarkedSkillPath, 'utf-8')).toBe('# my own skill\n');
    expect(fs.readFileSync(path.join(commandDir, 'user-notes.md'), 'utf-8')).toBe('notes\n');

    const envelope = parseStdoutJson(t.io);
    expect(envelope.assets.tool).toBe('all');
    expect(envelope.assets.installed).toHaveLength(10);
    expect(envelope.assets.reconciled.removed.sort()).toEqual([
      '.agents/skills/specgit-retired/SKILL.md',
      '.opencode/command/specgit-retired.md',
    ]);
    expect(envelope.assets.reconciled.preserved.sort()).toEqual([
      '.agents/skills/specgit-mine/SKILL.md',
      '.opencode/command/specgit-mine.md',
    ]);
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'unowned_asset_preserved')
    ).toBe(true);
  });

  it('preserves a candidate whose body mentions the authorship string; released frontmatter still proves', async () => {
    gitInit(tempDir);
    const retiredSkillDir = path.join(tempDir, '.agents', 'skills', 'specgit-retired');
    fs.mkdirSync(retiredSkillDir, { recursive: true });
    fs.writeFileSync(path.join(retiredSkillDir, 'SKILL.md'), RETIRED_OWNED_SKILL);
    const quotingSkillPath = path.join(
      tempDir,
      '.agents',
      'skills',
      'specgit-migration-notes',
      'SKILL.md'
    );
    fs.mkdirSync(path.dirname(quotingSkillPath), { recursive: true });
    fs.writeFileSync(quotingSkillPath, UNMARKED_SKILL_QUOTING_AUTHOR);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(
      ['node', 'specgit', 'setup', '--tool', 'generic', '--json'],
      t.ctx
    );
    expect(code).toBe(0);

    // The released-style frontmatter proves ownership; body prose does not.
    expect(fs.existsSync(path.join(retiredSkillDir, 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(quotingSkillPath, 'utf-8')).toBe(UNMARKED_SKILL_QUOTING_AUTHOR);

    const envelope = parseStdoutJson(t.io);
    expect(envelope.assets.reconciled.removed).toEqual(['.agents/skills/specgit-retired/SKILL.md']);
    expect(envelope.assets.reconciled.preserved).toEqual([
      '.agents/skills/specgit-migration-notes/SKILL.md',
    ]);
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'unowned_asset_preserved')
    ).toBe(true);
  });

  it('preserves a candidate whose body quotes the ownership marker; the anchored marker still proves', async () => {
    gitInit(tempDir);
    const commandDir = path.join(tempDir, '.opencode', 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, 'specgit-retired.md'), RETIRED_OWNED_COMMAND);
    const quotingCommandPath = path.join(commandDir, 'specgit-marker-notes.md');
    fs.writeFileSync(quotingCommandPath, UNMARKED_COMMAND_QUOTING_MARKER);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], t.ctx);
    expect(code).toBe(0);

    // The anchored marker proves ownership; a body mention does not.
    expect(fs.existsSync(path.join(commandDir, 'specgit-retired.md'))).toBe(false);
    expect(fs.readFileSync(quotingCommandPath, 'utf-8')).toBe(UNMARKED_COMMAND_QUOTING_MARKER);

    const envelope = parseStdoutJson(t.io);
    expect(envelope.assets.reconciled.removed).toEqual(['.opencode/command/specgit-retired.md']);
    expect(envelope.assets.reconciled.preserved).toEqual([
      '.opencode/command/specgit-marker-notes.md',
    ]);
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'unowned_asset_preserved')
    ).toBe(true);
  });

  it('removes only the owned SKILL.md from a retired skill directory holding user files', async () => {
    gitInit(tempDir);
    const huskDir = path.join(tempDir, '.agents', 'skills', 'specgit-husk');
    fs.mkdirSync(huskDir, { recursive: true });
    fs.writeFileSync(path.join(huskDir, 'SKILL.md'), RETIRED_OWNED_SKILL);
    fs.writeFileSync(path.join(huskDir, 'notes.md'), 'user notes\n');

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(
      ['node', 'specgit', 'setup', '--tool', 'generic', '--json'],
      t.ctx
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(huskDir, 'SKILL.md'))).toBe(false);
    // The directory is non-empty: pruning refuses it, user content stays.
    expect(fs.readFileSync(path.join(huskDir, 'notes.md'), 'utf-8')).toBe('user notes\n');
    expect(fs.existsSync(huskDir)).toBe(true);
  });

  it('reconciles only the selected surface: a retired command survives --tool generic', async () => {
    gitInit(tempDir);
    const commandDir = path.join(tempDir, '.opencode', 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, 'specgit-retired.md'), RETIRED_OWNED_COMMAND);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(
      ['node', 'specgit', 'setup', '--tool', 'generic', '--json'],
      t.ctx
    );
    expect(code).toBe(0);
    // The unselected surface is never written, never scanned.
    expect(fs.readdirSync(commandDir)).toEqual(['specgit-retired.md']);
    expect(
      fs.existsSync(path.join(tempDir, '.agents', 'skills', 'specgit-issue', 'SKILL.md'))
    ).toBe(true);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.assets.reconciled.removed).toEqual([]);
    expect(envelope.assets.reconciled.preserved).toEqual([]);
  });

  it('a retired generic skill survives --tool opencode', async () => {
    gitInit(tempDir);
    const retiredSkillDir = path.join(tempDir, '.agents', 'skills', 'specgit-retired');
    fs.mkdirSync(retiredSkillDir, { recursive: true });
    fs.writeFileSync(path.join(retiredSkillDir, 'SKILL.md'), RETIRED_OWNED_SKILL);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(
      ['node', 'specgit', 'setup', '--tool', 'opencode', '--json'],
      t.ctx
    );
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(retiredSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      RETIRED_OWNED_SKILL
    );
    expect(fs.existsSync(path.join(tempDir, '.agents', 'skills', 'specgit-issue'))).toBe(false);
  });

  it('refreshes stale current entry points; a second successful run is a filesystem no-op', async () => {
    gitInit(tempDir);
    const stalePath = path.join(tempDir, '.opencode', 'command', 'specgit-issue.md');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, 'stale bytes\n');

    const first = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    expect(await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], first.ctx)).toBe(0);
    const refreshed = fs.readFileSync(stalePath, 'utf-8');
    // #368: `$ARGUMENTS` must stay unquoted in the command — quoting folds
    // N title arguments into one; the skill's "Multiple arguments = N
    // issues" contract needs each quoted title to arrive as its own argv.
    expect(refreshed).toContain('specgit issue $ARGUMENTS');
    expect(refreshed).not.toContain('"$ARGUMENTS"');
    // The enumeration may wrap across template lines; assert it flattened.
    expect(refreshed.replace(/\s+/g, ' ')).toContain(
      'Why / What changed / Evidence / Checklist'
    );
    expect(refreshed).toContain(ENTRY_POINT_MARKER);

    const converged = treeState(tempDir);
    const second = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    expect(await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], second.ctx)).toBe(0);
    expect(treeState(tempDir)).toEqual(converged);
    const envelope = parseStdoutJson(second.io);
    expect(envelope.assets.tool).toBe('all');
    expect(envelope.assets.installed).toHaveLength(10);
    expect(envelope.assets.reconciled).toEqual({
      created: [],
      updated: [],
      removed: [],
      preserved: [],
    });
  });

  it('a later-step failure restores the pre-run tree — bytes, modes, and the retired entry', async () => {
    gitInit(tempDir);
    const commandDir = path.join(tempDir, '.opencode', 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    const staleCommandPath = path.join(commandDir, 'specgit-issue.md');
    fs.writeFileSync(staleCommandPath, 'stale managed bytes\n');
    fs.chmodSync(staleCommandPath, 0o600);
    fs.writeFileSync(path.join(commandDir, 'specgit-retired.md'), RETIRED_OWNED_COMMAND);
    // Block the generic phase at commit time (#314): a regular FILE where
    // the first skill directory belongs, so the write of
    // `.agents/skills/specgit-issue/SKILL.md` fails AFTER the whole
    // opencode surface already reconciled (stale rewrite + retired
    // removal landed). A file-shaped blocker is portable — the old
    // injection (a non-writable `.agents/skills`) never fires on Windows,
    // where a directory's read-only attribute does not block creation.
    const skillsDir = path.join(tempDir, '.agents', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'specgit-issue'), 'not a directory');
    const before = treeState(tempDir);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], t.ctx);
    expect(code).toBe(3);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors?.[0]?.code).toBe('setup_write_failed');
    // The opencode reconciliation round-trips: stale bytes, stale mode,
    // and the removed-then-restored retired entry point. The blocker file
    // is pre-existing user content and stays.
    expect(treeState(tempDir)).toEqual(before);
  });

  it('a failure after fresh writes removes every directory the run created', async () => {
    gitInit(tempDir);
    const skillsDir = path.join(tempDir, '.agents', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    // Portable commit-time blocker (#314): the first generic skill write
    // needs `.agents/skills/specgit-issue` as a directory — a regular file
    // there fails it after the fresh opencode writes already landed.
    fs.writeFileSync(path.join(skillsDir, 'specgit-issue'), 'not a directory');
    const before = treeState(tempDir);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const code = await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], t.ctx);
    expect(code).toBe(3);
    expect(treeState(tempDir)).toEqual(before);
    // No empty residue: the run-created .opencode chain is gone and no
    // run-created skill directory was left behind (the blocker file is
    // pre-existing user content, not residue).
    expect(fs.existsSync(path.join(tempDir, '.opencode'))).toBe(false);
    expect(fs.readdirSync(skillsDir)).toEqual(['specgit-issue']);
  });

  // #311: the portable status skill must teach the full #175 contract — a
  // missing record is the healthy unbound state on exit 0, distinct from a
  // genuine exit-3 evidence failure — so an agent neither treats unbound as
  // broken nor unknown as success. Both branches are pinned; removing
  // either fails here.
  it('pins the unbound/exit-3 contract in the portable status skill (#311)', async () => {
    gitInit(tempDir);
    await writeAgentSurface(tempDir, 'generic');
    const skill = fs.readFileSync(
      path.join(tempDir, '.agents', 'skills', 'specgit-status', 'SKILL.md'),
      'utf-8'
    );
    // Unbound branch: explicitly not an error, exit 0, normal pre-binding.
    expect(skill).toContain('`state: "unbound"` with exit `0`');
    expect(skill).toMatch(/normal pre-binding state/);
    expect(skill).toContain('not an error');
    // Next action for unbound: bootstrap; the envelope rides a warning (#175).
    expect(skill).toContain('bootstrap with `specgit issue`');
    expect(skill).toContain('`warnings[].fix`');
    // Exit-3 branch: a genuine evidence failure; the exact fix rides errors[].
    expect(skill).toMatch(/[Ee]xit `3`/);
    expect(skill).toContain('`errors[].fix`');
  });

  // #311 equivalence: the opencode status COMMAND must teach the same
  // unbound/exit-3 contract as the portable skill — any equivalent command
  // surface installs the same semantics. Both branches are pinned.
  it('pins the unbound/exit-3 contract in the opencode status command (#311)', async () => {
    gitInit(tempDir);
    await writeAgentSurface(tempDir, 'opencode');
    const command = fs.readFileSync(
      path.join(tempDir, '.opencode', 'command', 'specgit-status.md'),
      'utf-8'
    );
    // Unbound branch: explicitly not an error, exit 0, normal pre-binding.
    expect(command).toContain('`state: "unbound"` with exit `0`');
    expect(command).toMatch(/normal pre-binding state/);
    expect(command).toContain('not an error');
    // Next action for unbound: bootstrap; the envelope rides a warning (#175).
    expect(command).toContain('bootstrap with `specgit issue`');
    // Exit-3 branch: a genuine evidence failure; the exact fix rides errors[].
    expect(command).toMatch(/[Ee]xit `3`/);
    expect(command).toContain('`errors[].fix`');
  });

  it('human output reports removed entry points alongside the installed set', async () => {
    gitInit(tempDir);
    const commandDir = path.join(tempDir, '.opencode', 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, 'specgit-retired.md'), RETIRED_OWNED_COMMAND);

    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const outcome = await runSetup({ tool: 'opencode', json: false }, t.ctx);
    expect(outcome.exit).toBe(0);
    const joined = (outcome.human ?? []).join('\n');
    expect(joined).toContain('.opencode/command/specgit-retired.md');
    expect(joined).toContain('.opencode/command/specgit-issue.md');
  });
});
