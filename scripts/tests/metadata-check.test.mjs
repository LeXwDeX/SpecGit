import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkStableEntry } from '../documentation-check.mjs';
import { checkRepositoryMetadata } from '../ci-metadata-check.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const specgitV2Hook = event => ({
  type: 'command',
  command: `'/usr/local/bin/specgit' hook --event ${event}`,
  inputFormat: 'claude-code',
  shell: 'bash',
  timeout: 5,
});

// Real SpecGit v2 receipt shape: top-level event entries, one single-quoted
// command string (<executable> hook --event <event>), inputFormat claude-code.
const v2Hooks = {
  PostToolUse: [{
    matcher: 'Write|Edit|MultiEdit|Bash|PowerShell|apply_patch|functions.apply_patch|mcp__functions__apply_patch',
    hooks: [specgitV2Hook('PostToolUse')],
  }],
  PreToolUse: [{
    matcher: 'Write|Edit|MultiEdit|Bash|PowerShell|apply_patch|functions.apply_patch|mcp__functions__apply_patch',
    hooks: [specgitV2Hook('PreToolUse')],
  }],
  SessionStart: [{ matcher: '*', hooks: [specgitV2Hook('SessionStart')] }],
  Stop: [{ matcher: '*', hooks: [specgitV2Hook('Stop')] }],
};

// Verbatim retired v1 integration content (git history, commit eaf9bbb9^).
const v1Hooks = {
  PreToolUse: [{
    matcher: 'Bash|Edit|Write',
    hooks: [{ type: 'command', command: '.opencode/hooks/specgit-merge-guard.sh', timeout: 600 }],
  }],
};

// Legal content owned by another tool: other event names, its own commands.
const foreignHooks = {
  Notification: [{ hooks: [{ type: 'command', command: '/bin/echo host-notify' }] }],
  PreToolUse: [{
    matcher: 'Write',
    hooks: [{ type: 'command', command: 'node /opt/host/guard.js', inputFormat: 'claude-code' }],
  }],
};

function fixtureTree(hooks) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specgit-metadata-'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9', private: true }));
  writeFileSync(path.join(root, 'runtime/Cargo.toml'), '[package]\nname = "fixture"\nversion = "9.9.9"\n');
  if (hooks !== undefined) {
    mkdirSync(path.join(root, '.opencode'), { recursive: true });
    writeFileSync(path.join(root, '.opencode/hooks.json'), JSON.stringify(hooks, null, 2));
  }
  return root;
}

function digest(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .map(({ name }) => {
      const target = path.join(directory, name);
      if (!statSync(target).isFile()) return `${name}/\n${digest(target)}`;
      return `${name}\n${createHash('sha256').update(readFileSync(target)).digest('hex')}`;
    })
    .sort()
    .join('\n');
}

function withInitializedDeclaration(root, present) {
  const declaration = path.join(root, '.specgit.yaml');
  if (present) writeFileSync(declaration, 'version: 2\ntarget: main\n');
  return () => existsSync(declaration) && rmSync(declaration);
}

test('supported project v2 hooks and unrelated host content pass unchanged', () => {
  for (const hooks of [v2Hooks, foreignHooks]) {
    const root = fixtureTree(hooks);
    const hooksPath = path.join(root, '.opencode/hooks.json');
    const before = readFileSync(hooksPath);
    const treeBefore = digest(root);
    try {
      for (const initialized of [false, true]) {
        const cleanup = withInitializedDeclaration(root, initialized);
        checkRepositoryMetadata(root);
        cleanup();
        assert.deepEqual(readFileSync(hooksPath), before, 'hooks fixture was rewritten');
        assert.equal(digest(root), treeBefore, 'fixture tree was modified');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('retired v1 hook commands and retired v1 entry points stay rejected', () => {
  const hooksRoot = fixtureTree(v1Hooks);
  try {
    assert.throws(() => checkRepositoryMetadata(hooksRoot), /Retired v1 entry point: \.opencode\/hooks\.json/);
  } finally { rmSync(hooksRoot, { recursive: true, force: true }); }
  for (const entry of ['src/index.ts', 'bin/specgit.js', 'build.js', 'vitest.config.ts', 'spec_git/policy.yaml',
    '.github/workflows/specgit-accept.yml', '.github/workflows/specgit-complete.yml', '.github/workflows/rc-verify.yml']) {
    const root = fixtureTree(undefined);
    mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
    writeFileSync(path.join(root, entry), 'retired\n');
    try {
      assert.throws(() => checkRepositoryMetadata(root), new RegExp(`Retired v1 entry point: ${entry.replaceAll('.', '\\.')}`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('malformed hooks configuration fails closed', () => {
  const root = fixtureTree(undefined);
  mkdirSync(path.join(root, '.opencode'), { recursive: true });
  writeFileSync(path.join(root, '.opencode/hooks.json'), '{ not json');
  try {
    assert.throws(() => checkRepositoryMetadata(root), /not valid JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the real metadata script entry accepts the current repository', () => {
  assert.equal(execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts/ci-metadata-check.mjs')],
    { cwd: repositoryRoot, encoding: 'utf8' }).includes('passed'), true);
});

test('stable instruction compatibility accepts only complete exact published blocks', () => {
  const entries = ['runtime/assets/prompts/host-entry.md', 'runtime/tests/fixtures/host-entry-2.13.md'].map(file => readFileSync(path.join(repositoryRoot, file), 'utf8').trim());
  const start = '<!-- specgit:project:v2:start -->', end = '<!-- specgit:project:v2:end -->';
  for (const entry of entries) {
    const block = `${start}\n## SpecGit 2\n\n${entry}\n${end}`;
    checkStableEntry(`manual\n${block}\nmanual`, entries);
    for (const bad of [block.replace(end, ''), block + end, start + block, block.replace(entry, 'arbitrary body'), entry + block.replace(entry, ''), `${end}\n${start}`]) assert.throws(() => checkStableEntry(bad, entries));
  }
  assert(entries[0].includes('/docs/agent-install.md'));
});
