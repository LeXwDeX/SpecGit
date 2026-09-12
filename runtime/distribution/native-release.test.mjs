import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, binaryName, prepareBinary, smoke, verifyNativeBundle } from './native-release.mjs';
import { targets } from './stage.mjs';

const version = '2.0.0';
const source = 'a'.repeat(40);
const execute = (_binary, args) => ({ status: 0, stdout: args.includes('--version') ? `specgit ${version}\n` : JSON.stringify({ schema_version: 2, version, ok: true, exit: 0, operation: args[0].slice(2), evidence: { schema_version: 2, cli_version: version } }) });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-native-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  mkdirSync(input);
  for (const [target, platform] of Object.entries(targets)) {
    // Synthetic headers exercise validation; runner smoke tests execute real binaries.
    const bytes = Buffer.alloc(128);
    if (platform.os === 'linux') { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(62, 18); }
    else if (platform.os === 'darwin') { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); }
    else { bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(0x8664, 68); }
    const binary = path.join(root, binaryName(target));
    writeFileSync(binary, bytes);
    prepareBinary(binary, path.join(input, `release-platform-${target}`), version, source, target, { platform: platform.os, arch: platform.cpu, execute });
  }
  return { root, input, output: path.join(root, 'bundle') };
}
test('smoke validates version, help and schema without a forge or package manager', () => {
  const calls = [];
  assert.deepEqual(smoke('/native/specgit', version, (binary, args, options) => { calls.push(args); assert.equal(options.timeout, 30_000); return execute(binary, args); }), ['version', 'help', 'schema']);
  assert.deepEqual(calls, [['--human', '--version'], ['--help'], ['--schema']]);
  assert.throws(() => smoke('/native/specgit', version, () => ({ status: 1 })), /smoke failed/);
  assert.throws(() => smoke('/native/specgit', version, () => ({ status: 0, stdout: 'specgit 1.0.0' })), /version differs/);
  assert.throws(() => smoke('/native/specgit', version, (binary, args) => args.includes('--schema') ? { status: 0, stdout: '{}' } : execute(binary, args)), /schema report differs/);
});
test('assembles three native executables and rejects changed bytes or duplicate targets', t => {
  const f = fixture(t);
  const release = assemble(f.input, f.output, version, source);
  assert.equal(release.binaries.length, 3);
  assert.equal(verifyNativeBundle(f.output, version, source).binaries.length, 3);
  assert.throws(() => verifyNativeBundle(f.output, version, 'b'.repeat(40)), /source\/version/);
  const manifest = path.join(f.output, 'native-release.json');
  writeFileSync(manifest, JSON.stringify({ ...release, binaries: [release.binaries[0], release.binaries[0], release.binaries[2]] }));
  assert.throws(() => verifyNativeBundle(f.output, version, source), /distinct native targets/);
  writeFileSync(manifest, JSON.stringify(release));
  const file = path.join(f.output, release.binaries[0].filename);
  const changed = readFileSync(file); changed[100] ^= 1; writeFileSync(file, changed);
  assert.throws(() => verifyNativeBundle(f.output, version, source), /digest differs/);
});
test('missing smoke evidence and mismatched native hosts cannot qualify a build', t => {
  const f = fixture(t);
  const target = Object.keys(targets)[0];
  const directory = path.join(f.input, `release-platform-${target}`);
  const evidence = path.join(directory, 'smoke.json');
  const entry = JSON.parse(readFileSync(evidence));
  writeFileSync(evidence, JSON.stringify({ ...entry, smoke: ['version'] }));
  assert.throws(() => assemble(f.input, f.output, version, source), /smoke evidence/);
  assert.throws(() => prepareBinary(path.join(directory, entry.filename), f.output, version, source, target, { platform: 'win32', arch: 'x64', execute }), /native target host/);
  rmSync(evidence);
  assert.throws(() => assemble(f.input, f.output, version, source), /ENOENT/);
});
test('publisher verification stays offline and retired npm flags are rejected', t => {
  const f = fixture(t);
  assemble(f.input, f.output, version, source);
  const guard = path.join(f.root, 'offline-guard.mjs');
  writeFileSync(guard, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; cp.spawnSync = () => { throw new Error('Unexpected subprocess'); }; syncBuiltinESMExports(); globalThis.fetch = () => { throw new Error('Unexpected network'); };`);
  const args = ['--import', pathToFileURL(guard).href, fileURLToPath(new URL('./publish.mjs', import.meta.url)), '--directory', f.output, '--version', version, '--source', source];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).publication_performed, false);
  const retired = spawnSync(process.execPath, [...args, '--npm'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(retired.status, 1);
  assert.match(retired.stderr, /Unknown option.*npm/);
});
