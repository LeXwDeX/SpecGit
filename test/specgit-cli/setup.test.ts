import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runSetup } from '../../src/cli/commands/setup.js';
import { detectSetupTool, writeAgentSurface } from '../../src/cli/agent-surface.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';
import { makeCtx } from './helpers.js';

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
      '.agents/skills/specgit-finish/SKILL.md',
      '.agents/skills/specgit-issue/SKILL.md',
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
      '.opencode/command/specgit-finish.md',
      '.opencode/command/specgit-issue.md',
    ]);
    const cmd = fs.readFileSync(
      path.join(tempDir, '.opencode', 'command', 'specgit-finish.md'),
      'utf-8'
    );
    expect(cmd).toContain('specgit finish --json');
  });

  it('installs both surfaces for all and is idempotent', async () => {
    gitInit(tempDir);
    const first = await writeAgentSurface(tempDir, 'all');
    expect(first.installed).toHaveLength(4);
    const second = await writeAgentSurface(tempDir, 'all');
    expect(second.installed).toHaveLength(4);
    const file = path.join(tempDir, '.opencode', 'command', 'specgit-issue.md');
    expect(fs.readFileSync(file, 'utf-8')).toEqual(fs.readFileSync(file, 'utf-8'));
  });

  it('rejects an unknown tool with usage exit', async () => {
    const t = makeCtx({ root: { ok: true, value: tempDir }, cwd: tempDir });
    const outcome = await runSetup({ tool: 'vscode-extension', json: true }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('setup_tool_invalid');
  });
});
