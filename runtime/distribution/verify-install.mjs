#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './stage.mjs';
import { checkSurfaces } from './check-surfaces.mjs';

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
  assert(packed.files.every(file => /^(package\.json$|LICENSE$|README\.md$|THIRD_PARTY_LICENSES\.json$|bin\/|licenses\/|schemas\/[a-z-]+\.schema\.json$)/.test(file.path)), 'Only explicit distribution assets may enter a package.');
  assert(!packed.files.some(file => /\.(rs|pdb|dSYM|map)$/.test(file.path)), 'No source or debug sidecars.');
  if (packed.name === 'specgit') {
    assert.equal(packed.files.find(file => file.path === 'bin/specgit.cjs')?.mode, 0o644, 'Wrapper archive permissions must be identical across platforms before npm bin installation.');
  }
  const tarball = path.join(output, packed.filename);
  assert.equal(packed.integrity, 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64'));
  return { name: packed.name, integrity: packed.integrity, tarball };
});
writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'specgit-isolated-install-check', version: '1.0.0', private: true }));
// Local tarballs plus offline resolution prove package contents need no source,
// private repository access, network fetch or lifecycle download to execute.
npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', ...packed.map(p => p.tarball)], output);
const shim = npm(['exec', '--offline', '--', 'specgit', '--version'], output);
assert.equal(JSON.parse(shim).version, staging.version, 'npm bin shim must execute the installed version.');
const launcher = path.join(output, 'node_modules', 'specgit', 'bin', 'specgit.cjs');
const binary = path.join(output, 'node_modules', staging.platform, 'bin', process.platform === 'win32' ? 'specgit.exe' : 'specgit');
const emptyPath = path.join(output, 'empty-path');
mkdirSync(emptyPath);
const isolatedEnv = { ...process.env, PATH: emptyPath, GITHUB_TOKEN: '', GH_TOKEN: '', GITLAB_TOKEN: '', GLAB_TOKEN: '' };
function invoke(args, input) {
  return spawnSync(process.execPath, [launcher, ...args], { cwd: output, encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024, timeout: 10_000, env: isolatedEnv });
}
function report(result, exit) {
  assert.ifError(result.error);
  assert.equal(result.status, exit, result.stderr);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema_version, 2);
  assert.equal(value.exit, exit);
  assert.equal(value.ok, exit === 0);
  assert.equal(value.version, staging.version);
  assert(Array.isArray(value.diagnostics));
  assert(Array.isArray(value.next_actions));
  if (value.effects !== undefined) {
    assert.equal(typeof value.effects, 'object');
    assert(value.effects !== null && !Array.isArray(value.effects));
    assert(['not_applied', 'applied', 'unknown'].includes(value.effects.outcome));
    assert(Array.isArray(value.effects.operations));
    for (const effect of value.effects.operations) {
      assert(['local', 'native'].includes(effect.scope));
      assert(['unknown', 'applied'].includes(effect.outcome));
      assert.equal(typeof effect.action, 'string');
      assert(effect.action.length > 0);
      assert(effect.recovery !== null && typeof effect.recovery === 'object' && !Array.isArray(effect.recovery));
    }
  }
  return value;
}
const version = report(invoke(['--version']), 0);
assert.equal(version.version, staging.version);
const humanVersion = invoke(['--human', '--version']);
assert.equal(humanVersion.status, 0, humanVersion.stderr);
assert(humanVersion.stdout.includes(staging.version));
report(invoke(['--help']), 0);
report(invoke(['doctor', '--json']), 2);
const missing = report(invoke(['status', '--json']), 3);
assert.equal(missing.diagnostics[0].code, 'missing_executable');
const inputRequest = JSON.stringify({ command: 'status', options: { json: true } });
const fromStdin = report(invoke(['--input-file', '-'], inputRequest), 3);
assert.equal(fromStdin.diagnostics[0].code, 'missing_executable');
const inputFile = path.join(output, 'request.json');
writeFileSync(inputFile, inputRequest);
assert.equal(report(invoke(['--input-file', inputFile]), 3).diagnostics[0].code, 'missing_executable');
for (const input of ['{', '{"command":"status","command":"issue"}', '{"command":"status","options":{"json":true,"json":false}}', '{"command":"status","options":{"unknown":true}}']) {
  assert.equal(report(invoke(['--input-file', '-'], input), 2).diagnostics[0].code, 'invalid_input');
}
report(invoke(['--input-file', '-', 'status'], inputRequest), 2);
report(invoke(['--input-file', inputFile, '--input-file', inputFile]), 2);
const oversize = report(invoke(['--input-file', '-'], ' '.repeat(1024 * 1024 + 1)), 2);
assert.equal(oversize.diagnostics[0].code, 'input_limit');
const hook = invoke(['hook', '--event', 'PostToolUse'], JSON.stringify({ session_id: 'installed-check', hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: output }));
assert.equal(hook.status, 0, hook.stderr);
assert.equal(hook.stdout, '');
assert.equal(hook.stderr, '');

// Keep stdin open deliberately: a bounded explicit input read must not depend on
// EOF or an external timeout killing the application. This executes on every OS.
async function stalledInput(cancelSignal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, '--input-file', '-'], { cwd: output, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let signalTimer;
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Installed input read failed to terminate within 9 seconds.')); }, 9_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Installed output exceeded bound.')); } });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(deadline); clearTimeout(signalTimer); reject(error); });
    child.once('close', (status, signal) => { clearTimeout(deadline); clearTimeout(signalTimer); resolve({ status, signal, stdout, stderr }); });
    if (cancelSignal) signalTimer = setTimeout(() => child.kill(cancelSignal), 1_000);
  });
}
assert.equal(report(await stalledInput(), 3).diagnostics[0].code, 'timeout');
const cancellation = { stdin_deadline: 'verified', console_signal: 'requires_windows_console_journey' };
if (process.platform !== 'win32') {
  assert.equal(report(await stalledInput('SIGTERM'), 130).diagnostics[0].code, 'cancelled');
  cancellation.console_signal = 'installed_launcher_sigterm_verified';
}
const surfaces = checkSurfaces(launcher, path.join(output, 'node_modules', 'specgit'), { cwd: output, env: isolatedEnv });
const evidence = { artifact_sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), launcher_sha256: createHash('sha256').update(readFileSync(launcher)).digest('hex'), version: staging.version, source: staging.source, platform: staging.platform, binary, launcher, node: process.execPath, surfaces, cancellation, packages: packed.map(p => ({ ...p, tarball: path.basename(p.tarball) })), checks: ['offline_install', 'ignore_scripts', 'tarball_integrity', 'asset_allowlist', 'npm_bin_shim', 'machine_version_help', 'explicit_human_version', 'json_exit_2', 'json_exit_3', 'explicit_json_file_stdin', 'invalid_duplicate_unknown_json', 'input_byte_bound', 'input_deadline', 'hook_stdin_stdout', 'no_git_rust_or_credentials', 'installed_surfaces', ...(process.platform === 'win32' ? [] : ['installed_signal_exit_130'])] };
writeFileSync(path.join(output, 'installed.json'), JSON.stringify(evidence, null, 2) + '\n');
if (process.env.GITHUB_ENV) {
  const { appendFileSync } = await import('node:fs');
  for (const [key, value] of Object.entries({ SPECGIT_TEST_BINARY: binary, SPECGIT_TEST_LAUNCHER: launcher, SPECGIT_TEST_NODE: process.execPath })) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}
process.stdout.write(JSON.stringify(evidence) + '\n');
