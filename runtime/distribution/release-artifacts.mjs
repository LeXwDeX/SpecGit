#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localRelease } from './release-check.mjs';
import { targets } from './stage.mjs';

const need = (condition, message) => { if (!condition) throw new Error(message); };
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const platforms = Object.values(targets).map(target => `specgit-${target.key}`);
export const expectedSuites = ['src/lib.rs', 'src/main.rs', 'tests/fixtures/process-child.rs', ...readdirSync(fileURLToPath(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.rs')).map(name => `tests/${name}`)].sort();
export function identity(version, source) {
  need(/^\d+\.\d+\.\d+$/.test(version ?? ''), 'An exact stable release version is required.');
  need(/^[a-f0-9]{40}$/.test(source ?? ''), 'An exact source commit is required.');
}
export function findEvidence(directory) {
  const result = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    need(!item.isSymbolicLink(), 'Release inputs must not be symlinks.');
    const file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...findEvidence(file));
    else if (item.name === 'installed.json' || /^installed-specgit-[a-z0-9-]+\.json$/.test(item.name)) result.push(file);
  }
  return result;
}
export function assertProfileInventory(profile) {
  need(Array.isArray(profile.suites) && profile.test_processes === profile.suites.length && profile.suites.length > 0, 'Installed test profile is incomplete.');
  need(JSON.stringify(profile.suites.map(suite => suite.source).sort()) === JSON.stringify(expectedSuites), 'Installed profile omits or duplicates a native test executable.');
}
function verifyProfile(evidence, profile, release) {
  need(profile.passed === true, 'Installed test profile is incomplete.');
  assertProfileInventory(profile);
  const native = release.packages.find(item => item.name === evidence.platform);
  const wrapper = release.packages.find(item => item.name === 'specgit');
  need(profile.artifact_sha256 === native?.executable_sha256 && profile.launcher_sha256 === wrapper?.executable_sha256, 'Profile does not identify the actual packaged executable and launcher.');
  const target = Object.values(targets).find(item => `specgit-${item.key}` === evidence.platform);
  need(profile.platform === target.os && profile.arch === target.cpu, 'Profile platform identity differs.');
  // localRelease already verifies the native digest inside this exact tarball.
  // The profile additionally proves that this binary and wrapper were exercised.
  need(profile.artifact_sha256 === evidence.artifact_sha256 && profile.launcher_sha256 === evidence.launcher_sha256, 'Profile and installed executable identities differ.');
  need(native && /^[a-f0-9]{64}$/.test(profile.artifact_sha256 ?? '') && /^[a-f0-9]{64}$/.test(profile.launcher_sha256 ?? ''), 'Missing installed executable identity.');
  let passed = 0;
  for (const suite of profile.suites) {
    need(suite.passed === true && suite.exit === 0 && Array.isArray(suite.tests) && Array.isArray(suite.counts), 'A native test process failed or is unaccounted for.');
    const ok = suite.tests.filter(test => test.outcome === 'ok').length;
    const ignored = suite.tests.filter(test => test.outcome === 'ignored').length;
    need(ok + ignored === suite.tests.length && suite.counts[0] === ok && suite.counts[1] === 0 && suite.counts[2] === ignored && suite.counts.slice(3).every(count => count === 0), 'Native test enumeration or result counts differ.');
    need(suite.tests.filter(test => test.outcome === 'ignored').every(test => test.name === 'real_claude_host_consumes_async_observer_event_on_the_next_model_turn'), 'Unexpected skipped native test.');
    passed += ok;
  }
  need(passed > 0, 'No installed native journeys were executed.');
  if (target.os === 'win32') {
    need(profile.suites.some(suite => suite.tests.some(test => test.name === 'console_interrupt_preserves_native_cancellation_json_through_the_installed_entrypoint' && test.outcome === 'ok')), 'The Windows installed console journey is missing.');
  }
  return { ...profile, test_processes: profile.suites.length };
}
export function qualify(directory, version, source) {
  identity(version, source);
  const files = findEvidence(directory);
  const release = localRelease(files);
  need(release.version === version && release.source === source, 'Release source/version differs from the requested identity.');
  const qualifications = [];
  for (const file of files) {
    const evidence = read(file);
    const profilePath = path.join(path.dirname(file), path.basename(file) === 'installed.json' ? 'profile.json' : `profile-${evidence.platform}.json`);
    const profile = read(profilePath);
    const verified = verifyProfile(evidence, profile, release);
    qualifications.push({ evidence, profile: verified });
  }
  return { release, qualifications };
}
export function prepare(directory, output, version, source) {
  const { release, qualifications } = qualify(directory, version, source);
  need(!existsSync(output), 'Choose a fresh release output directory.');
  mkdirSync(output, { recursive: true });
  const packages = release.packages.map(artifact => {
    const tarball = path.basename(artifact.tarball);
    cpSync(artifact.tarball, path.join(output, tarball));
    return { ...artifact, tarball };
  });
  for (const { evidence, profile } of qualifications) {
    // Keep public evidence portable. Do not retain runner/home/Node paths.
    const clean = { version, source, platform: evidence.platform, artifact_sha256: profile.artifact_sha256, launcher_sha256: profile.launcher_sha256, checks: evidence.checks, packages: evidence.packages.map(({ name, integrity, tarball }) => ({ name, integrity, tarball })) };
    writeFileSync(path.join(output, `installed-${evidence.platform}.json`), JSON.stringify(clean, null, 2) + '\n');
    const cleanProfile = { platform: profile.platform, arch: profile.arch, passed: true, artifact_sha256: profile.artifact_sha256, launcher_sha256: profile.launcher_sha256, test_processes: profile.test_processes, suites: profile.suites.map(({ name, source, counts, tests, passed, exit }) => ({ name, source, counts, tests, passed, exit })) };
    writeFileSync(path.join(output, `profile-${evidence.platform}.json`), JSON.stringify(cleanProfile, null, 2) + '\n');
  }
  const result = { version, source, packages };
  writeFileSync(path.join(output, 'release.json'), JSON.stringify(result, null, 2) + '\n');
  const sums = [...packages.map(item => item.tarball), 'release.json'].sort().map(file => `${sha256(path.join(output, file))}  ${file}`).join('\n') + '\n';
  writeFileSync(path.join(output, 'SHASUMS256.txt'), sums);
  verifyPrepared(output, version, source);
  return result;
}
export function verifyPrepared(directory, version, source) {
  const actual = qualify(directory, version, source).release;
  const manifest = read(path.join(directory, 'release.json'));
  need(manifest.version === version && manifest.source === source, 'Prepared release identity differs.');
  const normalize = items => items.map(({ name, version, integrity, sha256, tarball }) => ({ name, version, integrity, sha256, tarball: path.basename(tarball) })).sort((a, b) => a.name.localeCompare(b.name));
  need(JSON.stringify(normalize(actual.packages)) === JSON.stringify(normalize(manifest.packages)), 'Prepared release manifest differs from qualified package bytes.');
  need(!manifest.installers, 'Installer assets are not part of manual binary distribution.');
  const sums = [...actual.packages.map(item => path.basename(item.tarball)), 'release.json'].sort().map(file => `${sha256(path.join(directory, file))}  ${file}`).join('\n') + '\n';
  need(readFileSync(path.join(directory, 'SHASUMS256.txt'), 'utf8') === sums, 'Release checksums differ.');
  need(actual.packages.length === platforms.length + 1, 'A release package is missing.');
  return actual;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' } } });
    need(values.input && values.output, 'Use --input <downloaded artifacts> --output <fresh directory> --version <stable version> --source <commit>.');
    process.stdout.write(JSON.stringify(prepare(path.resolve(values.input), path.resolve(values.output), values.version, values.source)) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
