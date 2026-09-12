#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildNative, stage, targets, verifyArchitecture } from '../distribution/stage.mjs';
import { expectedSuites } from '../distribution/release-artifacts.mjs';
import { PhaseCache, digest, fileDigest, readCompiledTests } from './native-cache.mjs';
import { runDistributionTests } from './distribution-tests.mjs';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const repo = path.dirname(runtime);
function command(executable, args, { log, env = process.env, capture = false } = {}) {
  const result = spawnSync(executable, args, { cwd: runtime, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: capture || log ? 'pipe' : 'inherit' });
  if (log) writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''));
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(executable)} failed; retained log: ${log ?? 'workflow output'}`);
  return result.stdout;
}
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function exportEnv(values) {
  if (!process.env.GITHUB_ENV) return;
  for (const [key, value] of Object.entries(values)) {
    assert(!/[\r\n]/.test(String(value)), 'Environment paths must fit one line.');
    appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
  }
}

export async function main(args) {
  const { values } = parseArgs({ args, options: { phase: { type: 'string' }, target: { type: 'string' } } });
  const target = values.target ?? process.env.SPECGIT_NATIVE_TARGET;
  assert(targets[target], 'Select a supported --target.');
  assert(process.env.RUNNER_TOOL_CACHE && path.isAbsolute(process.env.RUNNER_TOOL_CACHE), 'An owned persistent runner cache is required.');
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=normal'], { capture: true }).trim(), '', 'Native qualification requires a clean source tree.');
  const source = command('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
  const rust = command('rustc', ['--version', '--verbose'], { capture: true }).trim();
  const allowedRoot = path.resolve(process.env.RUNNER_TOOL_CACHE);
  const buildIdentity = { workspace: repo, target, rust, flags: digest(process.env.RUSTFLAGS ?? ''), platform: process.platform, arch: process.arch };
  const namespace = digest(JSON.stringify(buildIdentity));
  // Keep paths short enough for native Windows tools. Full identities remain in
  // receipts, so a path collision cannot authorize reuse.
  const root = path.join(allowedRoot, 'sgq', digest(source + namespace).slice(0, 24));
  const cargoTarget = path.join(allowedRoot, 'sgt', namespace.slice(0, 24));
  const cache = new PhaseCache(path.join(root, 'receipts'), { source, ...buildIdentity, node: process.version }, allowedRoot);
  const attempts = path.join(root, 'attempts');
  mkdirSync(attempts, { recursive: true });
  const attempt = name => mkdtempSync(path.join(attempts, `${name}-`));
  process.env.CARGO_TARGET_DIR = cargoTarget;
  exportEnv({ CARGO_TARGET_DIR: cargoTarget, SPECGIT_NATIVE_TARGET: target,
    SPECGIT_NATIVE_INSTALLED: path.join(root, 'not-installed'), SPECGIT_NATIVE_PROFILE: path.join(root, 'not-profiled') });

  switch (values.phase) {
    case 'lint':
      await cache.run('lint', [], async () => {
        const directory = attempt('lint');
        const fmt = path.join(directory, 'fmt.log');
        const clippy = path.join(directory, 'clippy.log');
        command('cargo', ['fmt', '--check'], { log: fmt });
        command('cargo', ['clippy', '--locked', '--all-targets', '--features', 'test-fixtures', '--', '-D', 'warnings'], { log: clippy });
        return { value: { directory }, files: [directory] };
      });
      break;
    case 'compile-tests': {
      const value = await cache.run('compile-tests', [], async () => {
        const directory = attempt('compile-tests');
        const build = command('cargo', ['test', '--locked', '--all-targets', '--features', 'test-fixtures', '--no-run', '--message-format=json'], { log: path.join(directory, 'build.log'), capture: true });
        const artifacts = build.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.reason === 'compiler-artifact' && row.executable);
        const tests = artifacts.filter(row => row.profile.test);
        assert.deepEqual(tests.map(row => path.relative(runtime, row.target.src_path).split(path.sep).join('/')).sort(), expectedSuites);
        const executables = [...new Set(artifacts.map(row => row.executable))].map(file => ({ file, sha256: fileDigest(file) }));
        const manifest = path.join(directory, 'compiled-tests.json');
        writeFileSync(manifest, JSON.stringify({ schema_version: 1, source, platform: process.platform, arch: process.arch, artifacts: tests, executables }, null, 2) + '\n');
        return { value: { manifest }, files: [directory, ...executables.map(row => row.file)] };
      });
      exportEnv({ SPECGIT_CARGO_TEST_ARTIFACTS: value.manifest });
      break;
    }
    case 'source-tests': {
      const compiled = cache.get('compile-tests');
      assert(compiled, 'Compile the native test executables first.');
      await cache.run('source-tests', ['compile-tests'], async () => {
        const directory = attempt('source-tests');
        const manifest = readCompiledTests(compiled.value.manifest, source);
        const env = { ...process.env };
        for (const key of ['SPECGIT_TEST_BINARY', 'SPECGIT_TEST_LAUNCHER', 'SPECGIT_TEST_NODE']) delete env[key];
        const failures = [];
        for (const [index, artifact] of manifest.artifacts.entries()) {
          try { command(artifact.executable, ['--color', 'never'], { env, log: path.join(directory, `${index}.log`) }); }
          catch (error) { failures.push(error.message); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
        return { value: { directory }, files: [directory] };
      });
      break;
    }
    case 'distribution-tests':
      await cache.run('distribution-tests', ['compile-tests'], async () => {
        const directory = attempt('distribution-tests');
        const files = readdirSync(path.join(runtime, 'distribution')).filter(name => name.endsWith('.test.mjs')).sort();
        runDistributionTests(files, directory, { cwd: runtime });
        return { value: { directory }, files: [directory] };
      });
      break;
    case 'compile-release': {
      const value = await cache.run('compile-release', [], async () => {
        const binary = buildNative(target);
        verifyArchitecture(readFileSync(binary), target);
        return { value: { binary }, files: [binary] };
      });
      exportEnv({ SPECGIT_RELEASE_BINARY: value.binary });
      break;
    }
    case 'install': {
      const value = await cache.run('install', ['compile-release', 'distribution-tests'], async () => {
        const directory = attempt('install');
        const staging = path.join(directory, 'stage');
        const installed = path.join(directory, 'installed');
        stage(target, staging, cache.get('compile-release').value.binary);
        command(process.execPath, ['distribution/verify-install.mjs', '--stage', staging, '--output', installed], { log: path.join(directory, 'install.log') });
        const evidence = json(path.join(installed, 'installed.json'));
        assert.equal(evidence.source, source);
        return { value: { directory: installed }, files: [path.join(installed, 'installed.json'), path.join(installed, 'node_modules'), ...evidence.packages.map(row => path.join(installed, row.tarball))] };
      });
      const evidence = json(path.join(value.directory, 'installed.json'));
      exportEnv({ SPECGIT_NATIVE_INSTALLED: value.directory, SPECGIT_TEST_BINARY: evidence.binary, SPECGIT_TEST_LAUNCHER: evidence.launcher, SPECGIT_TEST_NODE: process.execPath });
      break;
    }
    case 'profile': {
      const installed = cache.get('install');
      const compiled = cache.get('compile-tests');
      assert(installed && compiled, 'Verified installation and compiled tests are required.');
      const evidence = json(path.join(installed.value.directory, 'installed.json'));
      exportEnv({ SPECGIT_NATIVE_INSTALLED: installed.value.directory });
      const value = await cache.run('profile', ['compile-tests', 'install'], async () => {
        const directory = path.join(attempt('profile'), 'results');
        const env = { ...process.env, SPECGIT_TEST_BINARY: evidence.binary, SPECGIT_TEST_LAUNCHER: evidence.launcher, SPECGIT_TEST_NODE: process.execPath };
        exportEnv({ SPECGIT_NATIVE_PROFILE: directory });
        try { command(process.execPath, ['scripts/profile-tests.mjs', '--artifacts', compiled.value.manifest, '--output', directory], { env }); }
        finally {
          if (existsSync(path.join(directory, 'profile.json'))) cpSync(path.join(directory, 'profile.json'), path.join(installed.value.directory, 'profile.json'));
        }
        assert.equal(json(path.join(directory, 'profile.json')).passed, true);
        return { value: { directory }, files: [directory, path.join(installed.value.directory, 'profile.json')] };
      });
      exportEnv({ SPECGIT_NATIVE_PROFILE: value.directory });
      break;
    }
    default: throw new Error('Select a native qualification --phase.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
