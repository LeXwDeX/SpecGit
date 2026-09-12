#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildNative, run, targets, verifyArchitecture } from './stage.mjs';

const need = (condition, message) => { if (!condition) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const smokeChecks = ['version', 'help', 'schema'];
export const binaryName = target => {
  need(targets[target], 'Unsupported native release target.');
  return `specgit-${targets[target].key}${targets[target].os === 'win32' ? '.exe' : ''}`;
};
function identity(version, source) {
  need(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ''), 'An exact stable version is required.');
  need(/^[a-f0-9]{40}$/.test(source ?? ''), 'An exact source commit is required.');
}
export function smoke(binary, version, execute = spawnSync) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'specgit-native-smoke-'));
  try {
    for (const [name, args] of [['version', ['--human', '--version']], ['help', ['--help']], ['schema', ['--schema']]]) {
      const result = execute(binary, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      need(!result.error && result.status === 0, `Native ${name} smoke failed.`);
      if (name === 'version') need(result.stdout.trim() === `specgit ${version}`, 'Native version differs.');
      else {
        const report = JSON.parse(result.stdout);
        need(report.ok === true && report.exit === 0 && report.version === version && report.schema_version === 2 && report.operation === name, `Native ${name} report differs.`);
        if (name === 'schema') need(report.evidence?.schema_version === 2 && report.evidence?.cli_version === version, 'Native schema identity differs.');
      }
    }
    return [...smokeChecks];
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
export function prepareBinary(binary, output, version, source, target, { platform = process.platform, arch = process.arch, execute = spawnSync } = {}) {
  identity(version, source);
  need(targets[target]?.os === platform && targets[target]?.cpu === arch, 'Smoke tests must run on the native target host.');
  need(!existsSync(output), 'Choose a fresh native output directory.');
  const bytes = readFileSync(binary);
  verifyArchitecture(bytes, target);
  mkdirSync(output, { recursive: true });
  const filename = binaryName(target);
  const destination = path.join(output, filename);
  copyFileSync(binary, destination);
  chmodSync(destination, 0o755);
  const checks = smoke(destination, version, execute);
  need(digest(readFileSync(destination)) === digest(bytes), 'Executable changed during smoke tests.');
  const evidence = { version, source, target, filename, sha256: digest(bytes), smoke: checks };
  writeFileSync(path.join(output, 'smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
function verifiedBinary(entry, directory, version, source) {
  need(entry.version === version && entry.source === source && targets[entry.target], 'Native source/version/target mismatch.');
  need(entry.filename === binaryName(entry.target), 'Native filename mismatch.');
  need(JSON.stringify(entry.smoke) === JSON.stringify(smokeChecks), 'Native smoke evidence is incomplete.');
  const file = path.join(directory, entry.filename);
  need(lstatSync(file).isFile(), 'Native artifact must be a regular file.');
  const bytes = readFileSync(file);
  verifyArchitecture(bytes, entry.target);
  need(digest(bytes) === entry.sha256, 'Native executable digest differs.');
  return { ...entry, file };
}
export function assemble(input, output, version, source) {
  identity(version, source);
  need(!existsSync(output), 'Choose a fresh native bundle directory.');
  const binaries = Object.keys(targets).map(target => {
    const directory = path.join(input, `release-platform-${target}`);
    const entry = JSON.parse(readFileSync(path.join(directory, 'smoke.json'), 'utf8'));
    need(entry.target === target, 'Platform artifact target mismatch.');
    return verifiedBinary(entry, directory, version, source);
  });
  mkdirSync(output, { recursive: true });
  for (const entry of binaries) {
    copyFileSync(entry.file, path.join(output, entry.filename));
    chmodSync(path.join(output, entry.filename), 0o755);
  }
  const release = { version, source, binaries: binaries.map(({ file: _file, ...entry }) => entry) };
  writeFileSync(path.join(output, 'native-release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}
export function verifyNativeBundle(directory, version, source) {
  identity(version, source);
  const release = JSON.parse(readFileSync(path.join(directory, 'native-release.json'), 'utf8'));
  need(release.version === version && release.source === source, 'Native bundle source/version mismatch.');
  need(Array.isArray(release.binaries) && release.binaries.length === 3 && new Set(release.binaries.map(b => b.target)).size === 3, 'Exactly three distinct native targets are required.');
  return { ...release, binaries: release.binaries.map(entry => verifiedBinary(entry, directory, version, source)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { build: { type: 'boolean' }, assemble: { type: 'boolean' }, target: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' } } });
    need(Boolean(values.build) !== Boolean(values.assemble), 'Choose --build or --assemble.');
    identity(values.version, values.source);
    need(values.output, 'An output directory is required.');
    if (values.build) {
      need(run('git', ['rev-parse', 'HEAD']).trim() === values.source && !run('git', ['status', '--porcelain', '--untracked-files=normal']).trim(), 'Native build requires the exact clean source commit.');
    }
    const result = values.build
      ? prepareBinary(buildNative(values.target), path.resolve(values.output), values.version, values.source, values.target)
      : assemble(path.resolve(values.input), path.resolve(values.output), values.version, values.source);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
