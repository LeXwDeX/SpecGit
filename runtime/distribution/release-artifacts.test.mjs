import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { targets, run } from './stage.mjs';
import { assertProfileInventory, expectedSuites, prepare, qualify, verifyPrepared } from './release-artifacts.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'a'.repeat(40);
test('approved inventory matches every actual Cargo test executable', () => {
  const runtime = fileURLToPath(new URL('../', import.meta.url));
  const output = run('cargo', ['test', '--locked', '--all-targets', '--features', 'test-fixtures', '--no-run', '--message-format=json'], {
    cwd: runtime, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  const actual = output.trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.reason === 'compiler-artifact' && row.profile.test && row.executable)
    .map(row => path.relative(runtime, row.target.src_path).split(path.sep).join('/')).sort();
  assert(actual.length > 0, 'Cargo must enumerate the actual test workload.');
  assert.deepEqual(expectedSuites, actual);
});
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-release-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'); mkdirSync(input);
  const output = path.join(root, 'output');
  const launcher = Buffer.from('synthetic native launcher');
  const wrapper = { name: 'specgit', version: '2.0.0', specgitSource: source, license: 'MIT', bin: { specgit: 'bin/specgit.cjs' }, optionalDependencies: Object.fromEntries(Object.values(targets).map(target => [`specgit-${target.key}`, '2.0.0'])) };
  const files = [];
  function archive(directory, manifest, bytes, executable) {
    const work = path.join(root, `build-${manifest.name}`);
    mkdirSync(path.join(work, 'package', 'bin'), { recursive: true });
    writeFileSync(path.join(work, 'package', 'package.json'), JSON.stringify(manifest));
    writeFileSync(path.join(work, 'package', 'bin', executable), bytes);
    const tarball = `${manifest.name}-2.0.0.tgz`;
    run('tar', ['-czf', `./${tarball}`, '-C', work, 'package'], { cwd: directory });
    return { name: manifest.name, tarball, integrity: 'sha512-' + createHash('sha512').update(readFileSync(path.join(directory, tarball))).digest('base64') };
  }
  let wrapperBytes;
  for (const [target, platform] of Object.entries(targets)) {
    const name = `specgit-${platform.key}`;
    const directory = path.join(input, name); mkdirSync(directory);
    const bytes = Buffer.alloc(128);
    if (platform.os === 'linux') {
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(62, 18);
    } else if (platform.os === 'darwin') {
      bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
    } else {
      bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(0x8664, 68);
    }
    const native = archive(directory, { name, version: '2.0.0', specgitSource: source, license: 'MIT', specgitNative: { target, sha256: digest(bytes) } }, bytes, platform.os === 'win32' ? 'specgit.exe' : 'specgit');
    let wrapperArtifact;
    if (!wrapperBytes) {
      wrapperArtifact = archive(directory, wrapper, launcher, 'specgit.cjs');
      wrapperBytes = readFileSync(path.join(directory, wrapperArtifact.tarball));
    } else {
      writeFileSync(path.join(directory, 'specgit-2.0.0.tgz'), wrapperBytes);
      wrapperArtifact = { name: 'specgit', tarball: 'specgit-2.0.0.tgz', integrity: 'sha512-' + createHash('sha512').update(wrapperBytes).digest('base64') };
    }
    const evidence = { version: '2.0.0', source, platform: name, binary: '/private/build/path', artifact_sha256: digest(bytes), launcher_sha256: digest(launcher), packages: [native, wrapperArtifact], checks: ['offline_install', 'ignore_scripts', 'tarball_integrity', 'asset_allowlist', 'npm_bin_shim', 'machine_version_help', 'json_exit_2', 'json_exit_3', 'hook_stdin_stdout', 'no_git_rust_or_credentials', 'installed_surfaces'] };
    const file = path.join(directory, 'installed.json'); writeFileSync(file, JSON.stringify(evidence)); files.push(file);
    const suites = expectedSuites.map(source => {
      if (source === 'tests/fixtures/process-child.rs') return { name: 'specgit-process-fixture', source, exit: 0, passed: true, counts: [0, 0, 0, 0, 0], tests: [] };
      const test = source === 'tests/cli.rs' && platform.os === 'win32' ? 'console_interrupt_preserves_native_cancellation_json_through_the_installed_entrypoint' : 'synthetic_accounting_test';
      return { name: source, source, exit: 0, passed: true, counts: [1, 0, 0, 0, 0], tests: [{ name: test, outcome: 'ok' }] };
    });
    writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({ platform: platform.os, arch: platform.cpu, artifact_sha256: digest(bytes), launcher_sha256: digest(launcher), passed: true, suites, test_processes: suites.length }));
  }
  return { root, input, output, files };
}
test('assembles only the exact three-platform bytes with portable public evidence and checksums', t => {
  const f = fixture(t);
  const result = prepare(f.input, f.output, '2.0.0', source);
  assert.equal(result.packages.length, 4);
  assert.equal(verifyPrepared(f.output, '2.0.0', source).source, source);
  assert.equal(existsSync(path.join(f.output, 'install.sh')), false);
  assert.equal(existsSync(path.join(f.output, 'install.ps1')), false);
  for (const platform of Object.values(targets)) assert.equal(readFileSync(path.join(f.output, `installed-specgit-${platform.key}.json`), 'utf8').includes('/private/build/path'), false);
  writeFileSync(path.join(f.output, result.packages[0].tarball), 'changed');
  assert.throws(() => verifyPrepared(f.output, '2.0.0', source), /Tarball bytes changed/);
});
test('publisher bundle verification is offline and publication requires main build evidence', t => {
  const f = fixture(t);
  prepare(f.input, f.output, '2.0.0', source);
  const guard = path.join(f.output, 'offline-guard.mjs');
  writeFileSync(guard, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawnSync;
cp.spawnSync = (program, ...args) => {
  if (/^(npm|gh)(\\.cmd|\\.exe)?$/.test(program)) throw new Error('Unexpected network CLI');
  return original(program, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error('Unexpected registry request'); };
`);
  const args = ['--import', pathToFileURL(guard).href, fileURLToPath(new URL('./publish.mjs', import.meta.url)), '--directory', f.output, '--version', '2.0.0', '--source', source];
  const verified = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).bundle_verified, true);
  assert.equal(JSON.parse(verified.stdout).publication_performed, false);
  const retired = spawnSync(process.execPath, [...args, '--npm', '--github'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(retired.status, 1, retired.stderr);
  assert.match(retired.stderr, /explicit --build-run/);
});
test('wrong source, missing platform, mismatched executable and omitted suite cannot produce release output', t => {
  const f = fixture(t);
  assert.throws(() => prepare(f.input, f.output, '2.0.0', 'b'.repeat(40)), /source\/version/);
  assert.equal(existsSync(f.output), false);
  const file = path.join(path.dirname(f.files[0]), 'profile.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...original, artifact_sha256: '0'.repeat(64) }));
  assert.throws(() => qualify(f.input, '2.0.0', source), /actual packaged executable/);
  writeFileSync(file, JSON.stringify({ ...original, suites: original.suites.slice(1), test_processes: original.suites.length - 1 }));
  assert.throws(() => qualify(f.input, '2.0.0', source), /omits or duplicates/);
  writeFileSync(file, JSON.stringify(original));
  rmSync(f.files[0]);
  assert.throws(() => qualify(f.input, '2.0.0', source), /Three independently installed/);
});
test('a zero-test fixture remains required and unknown or duplicate executables are rejected', t => {
  const f = fixture(t);
  const file = path.join(path.dirname(f.files[0]), 'profile.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  const helper = original.suites.find(suite => suite.source === 'tests/fixtures/process-child.rs');
  assert.deepEqual(helper.counts, [0, 0, 0, 0, 0]);
  assertProfileInventory(original);
  for (const suites of [
    original.suites.filter(suite => suite !== helper),
    [...original.suites, helper],
    [...original.suites, { ...helper, source: 'tests/unknown.rs' }],
  ]) {
    const changed = { ...original, suites, test_processes: suites.length };
    assert.throws(() => assertProfileInventory(changed), /omits or duplicates/);
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => qualify(f.input, '2.0.0', source), /omits or duplicates/);
  }
});
