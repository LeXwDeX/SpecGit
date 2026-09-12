import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localRelease } from './release-check.mjs';
import { run, targets } from './stage.mjs';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('offline installed qualification rejects a missing platform set', () => {
  assert.throws(() => localRelease([]), /Three independently installed/);
});
test('synthetic archives remain valid after relocation through colon-containing host paths', t => {
  // Windows already contributes the drive colon; POSIX can exercise a colon in
  // the directory itself. Both use real tar and portable archive basenames.
  const prefix = process.platform === 'win32' ? 'specgit-release-relocation-' : 'specgit-release:relocation-';
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'runner-artifacts');
  const destination = path.join(root, 'downloaded-artifacts');
  mkdirSync(source);
  const wrapper = { bin: { specgit: 'bin/specgit.cjs' }, name: 'specgit', version: '2.0.0', license: 'MIT', specgitSource: 'a'.repeat(40), optionalDependencies: Object.fromEntries(Object.values(targets).map(p => [`specgit-${p.key}`, '2.0.0'])) };
  function archive(manifest, bytes, basename) {
    const work = path.join(root, manifest.name);
    mkdirSync(path.join(work, 'package', 'bin'), { recursive: true });
    writeFileSync(path.join(work, 'package', 'package.json'), JSON.stringify(manifest));
    if (bytes) writeFileSync(path.join(work, 'package', 'bin', basename), bytes);
    const tarball = `${manifest.name}.tgz`;
    run('tar', ['-czf', `./${tarball}`, '-C', work, 'package'], { cwd: source });
    return { name: manifest.name, tarball, integrity: 'sha512-' + createHash('sha512').update(readFileSync(path.join(source, tarball))).digest('base64') };
  }
  const wrapperArtifact = archive(wrapper, Buffer.from('synthetic launcher'), 'specgit.cjs');
  const evidenceNames = [];
  for (const [target, platform] of Object.entries(targets)) {
    // Synthetic headers test archive validation/relocation, not execution.
    const bytes = Buffer.alloc(128);
    if (platform.os === 'linux') {
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
      bytes.writeUInt16LE(platform.cpu === 'arm64' ? 183 : 62, 18);
    } else if (platform.os === 'darwin') {
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(platform.cpu === 'arm64' ? 0x0100000c : 0x01000007, 4);
    } else {
      bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c);
      bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(0x8664, 68);
    }
    const name = `specgit-${platform.key}`;
    const manifest = { name, version: '2.0.0', license: 'MIT', specgitSource: 'a'.repeat(40), specgitNative: { target, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const artifact = archive(manifest, bytes, platform.os === 'win32' ? 'specgit.exe' : 'specgit');
    const file = `${name}.json`;
    evidenceNames.push(file);
    writeFileSync(path.join(source, file), JSON.stringify({ version: '2.0.0', source: 'a'.repeat(40), platform: name, packages: [artifact, wrapperArtifact], checks: ['offline_install', 'ignore_scripts', 'tarball_integrity', 'asset_allowlist', 'npm_bin_shim', 'machine_version_help', 'json_exit_2', 'json_exit_3', 'hook_stdin_stdout', 'no_git_rust_or_credentials', 'installed_surfaces'] }));
  }
  cpSync(source, destination, { recursive: true });
  rmSync(source, { recursive: true });
  const files = evidenceNames.map(name => path.join(destination, name));
  assert.equal(localRelease(files).packages.length, 4);
  assert.equal(localRelease(files.map(file => path.relative(process.cwd(), file))).packages.length, 4);
  writeFileSync(path.join(destination, 'specgit.tgz'), 'changed after qualification');
  assert.throws(() => localRelease(files), /Tarball bytes changed/);
});
