#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './stage.mjs';

function npm(args, cwd) {
  args = ['--cache', path.join(output, 'npm-cache'), ...args];
  if (process.platform !== 'win32') return run('npm', args, { cwd });
  const cli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(cli)) throw new Error('Cannot locate the installed npm CLI beside Node. Set npm_execpath explicitly.');
  return run(process.execPath, [cli, ...args], { cwd });
}
const { values } = parseArgs({ options: { stage: { type: 'string' }, output: { type: 'string' } } });
if (!values.stage || !values.output) throw new Error('Use --stage <staging directory> --output <new installation directory>.');
const stage = path.resolve(values.stage);
const output = path.resolve(values.output);
if (existsSync(output)) throw new Error('Select a fresh installation directory.');
mkdirSync(output, { recursive: true });
const staging = JSON.parse(readFileSync(path.join(stage, 'staging.json'), 'utf8'));
const packed = staging.packages.map(directory => {
  const result = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', output], directory));
  const [packed] = Array.isArray(result) ? result : Object.values(result);
  assert.equal(packed.version, staging.version);
  assert(packed.files.every(file => /^(package\.json$|LICENSE$|THIRD_PARTY_LICENSES\.json$|bin\/|licenses\/)/.test(file.path)), 'Only explicit distribution assets may enter a package.');
  assert(!packed.files.some(file => /\.(rs|pdb|dSYM|map)$/.test(file.path)), 'No source or debug sidecars.');
  const tarball = path.join(output, packed.filename);
  assert.equal(packed.integrity, 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64'));
  return { name: packed.name, integrity: packed.integrity, tarball };
});
writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'specgit-isolated-install-check', version: '1.0.0', private: true }));
// Local tarballs plus offline resolution prove package contents need no source,
// private repository access, network fetch or lifecycle download to execute.
npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', ...packed.map(p => p.tarball)], output);
const shim = npm(['exec', '--offline', '--', 'specgit', '--version'], output);
assert(shim.includes(staging.version), 'npm bin shim must execute the installed version.');
const launcher = path.join(output, 'node_modules', 'specgit', 'bin', 'specgit.cjs');
const binary = path.join(output, 'node_modules', staging.platform, 'bin', process.platform === 'win32' ? 'specgit.exe' : 'specgit');
const emptyPath = path.join(output, 'empty-path');
mkdirSync(emptyPath);
function invoke(args, input) {
  return spawnSync(process.execPath, [launcher, ...args], { cwd: output, encoding: 'utf8', input, timeout: 10_000, env: { ...process.env, PATH: emptyPath, GITHUB_TOKEN: '', GH_TOKEN: '', GITLAB_TOKEN: '', GLAB_TOKEN: '' } });
}
const version = invoke(['--version']);
assert.equal(version.status, 0, version.stderr);
assert(version.stdout.includes(staging.version));
const invalid = invoke(['doctor', '--json']);
assert.equal(invalid.status, 2, invalid.stderr);
assert.equal(JSON.parse(invalid.stdout).exit, 2);
assert.equal(invalid.stderr, '');
const missing = invoke(['status', '--json']);
assert.equal(missing.status, 3, missing.stderr);
assert.equal(JSON.parse(missing.stdout).diagnostics[0].code, 'missing_executable');
const hook = invoke(['hook', '--event', 'PostToolUse'], JSON.stringify({ session_id: 'installed-check', hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: output }));
assert.equal(hook.status, 0, hook.stderr);
assert.equal(hook.stdout, '');
assert.equal(hook.stderr, '');
const evidence = { version: staging.version, platform: staging.platform, binary, launcher, node: process.execPath, packages: packed.map(p => ({ ...p, tarball: path.basename(p.tarball) })), checks: ['offline_install', 'ignore_scripts', 'tarball_integrity', 'asset_allowlist', 'npm_bin_shim', 'version', 'json_exit_2', 'json_exit_3', 'hook_stdin_stdout', 'no_git_rust_or_credentials'] };
writeFileSync(path.join(output, 'installed.json'), JSON.stringify(evidence, null, 2) + '\n');
if (process.env.GITHUB_ENV) {
  const { appendFileSync } = await import('node:fs');
  for (const [key, value] of Object.entries({ SPECGIT_TEST_BINARY: binary, SPECGIT_TEST_LAUNCHER: launcher, SPECGIT_TEST_NODE: process.execPath })) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}
process.stdout.write(JSON.stringify(evidence) + '\n');
