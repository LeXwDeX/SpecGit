import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, writeWrapperLauncher } from './stage.mjs';

test('portable wrapper archives are identical and npm installs an executable bin offline', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-wrapper-pack-'));
  function npm(args, cwd) {
    args = ['--cache', path.join(root, 'cache'), ...args];
    if (process.platform !== 'win32') return run('npm', args, { cwd, timeout: 30_000 });
    const cli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert(existsSync(cli), 'The installed Node runtime must include npm.');
    return run(process.execPath, [cli, ...args], { cwd, timeout: 30_000 });
  }
  try {
    const archives = [];
    for (const initialMode of [0o755, 0o644]) {
      const directory = path.join(root, String(initialMode));
      mkdirSync(path.join(directory, 'bin'), { recursive: true });
      const launcher = path.join(directory, 'bin', 'specgit.cjs');
      writeFileSync(launcher, 'old launcher');
      chmodSync(launcher, initialMode);
      writeWrapperLauncher(launcher, '#!/usr/bin/env node\r\nprocess.stdout.write("installed-wrapper-ok\\n");\r\n');
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name: 'specgit-wrapper-pack-fixture', version: '2.0.0',
        bin: { 'specgit-wrapper-pack-fixture': 'bin/specgit.cjs' }, files: ['bin'],
      }));
      const response = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], directory));
      const [packed] = Array.isArray(response) ? response : Object.values(response);
      assert.equal(packed.files.find(file => file.path === 'bin/specgit.cjs')?.mode, 0o644);
      archives.push(path.join(directory, packed.filename));
    }
    assert.deepEqual(readFileSync(archives[0]), readFileSync(archives[1]));
    const installed = path.join(root, 'installed');
    mkdirSync(installed);
    writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'offline-wrapper-check', version: '1.0.0', private: true }));
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archives[0]], installed);
    assert.equal(npm(['exec', '--offline', '--', 'specgit-wrapper-pack-fixture'], installed), 'installed-wrapper-ok\n');
    if (process.platform !== 'win32') {
      assert.notEqual(statSync(path.join(installed, 'node_modules', 'specgit-wrapper-pack-fixture', 'bin', 'specgit.cjs')).mode & 0o111, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
