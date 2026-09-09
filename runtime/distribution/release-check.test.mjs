import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localRelease, registryRelease } from './release-check.mjs';
import { run, targets } from './stage.mjs';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const release = { version: '2.0.0', packages: ['specgit-darwin-arm64', 'specgit-darwin-x64', 'specgit-linux-x64-gnu', 'specgit-linux-arm64-gnu', 'specgit-win32-x64', 'specgit'].map(name => ({ name, version: '2.0.0', integrity: `sha512-${name}` })) };
function registry(missing = [], corrupt = false) {
  return async url => {
    const name = new URL(url).pathname.split('/')[1];
    if (missing.includes(name)) return new Response('{}', { status: 404 });
    const artifact = release.packages.find(p => p.name === name);
    return Response.json({ name, version: '2.0.0', dist: { integrity: corrupt ? 'different' : artifact.integrity } });
  };
}
test('partial publication resumes platforms before the wrapper or latest', async () => {
  const result = await registryRelease(release, registry(['specgit-linux-arm64-gnu', 'specgit']));
  assert.equal(result.phase, 'platforms_missing');
  assert.deepEqual(result.next, ['specgit-linux-arm64-gnu']);
  assert.equal(result.can_promote_latest, false);
  const wrapperOnly = await registryRelease(release, registry(['specgit']));
  assert.equal(wrapperOnly.phase, 'wrapper_missing');
  assert.deepEqual(wrapperOnly.next, ['specgit']);
  assert.equal(wrapperOnly.can_promote_latest, false);
  assert.equal((await registryRelease(release, registry())).can_promote_latest, true);
});
test('unknown metadata, auth failures and changed immutable integrity stop recovery', async () => {
  await assert.rejects(registryRelease(release, registry([], true)), /Published bytes differ/);
  await assert.rejects(registryRelease(release, async () => new Response('{}', { status: 403 })), /Registry read failed/);
  await assert.rejects(registryRelease(release, async () => new Response('not json')), /JSON/);
  assert.throws(() => localRelease([]), /Five independently installed/);
});
test('synthetic archive qualification remains valid after cross-runner artifact relocation', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-release-relocation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'runner-artifacts');
  const destination = path.join(root, 'downloaded-artifacts');
  mkdirSync(source);
  const wrapper = { name: 'specgit', version: '2.0.0', license: 'MIT', optionalDependencies: Object.fromEntries(Object.values(targets).map(p => [`specgit-${p.key}`, '2.0.0'])) };
  function archive(manifest, bytes, basename) {
    const work = path.join(root, manifest.name);
    mkdirSync(path.join(work, 'package', 'bin'), { recursive: true });
    writeFileSync(path.join(work, 'package', 'package.json'), JSON.stringify(manifest));
    if (bytes) writeFileSync(path.join(work, 'package', 'bin', basename), bytes);
    const tarball = `${manifest.name}.tgz`;
    run('tar', ['-czf', path.join(source, tarball), '-C', work, 'package']);
    return { name: manifest.name, tarball, integrity: 'sha512-' + createHash('sha512').update(readFileSync(path.join(source, tarball))).digest('base64') };
  }
  const wrapperArtifact = archive(wrapper);
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
    const manifest = { name, version: '2.0.0', license: 'MIT', specgitNative: { target, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const artifact = archive(manifest, bytes, platform.os === 'win32' ? 'specgit.exe' : 'specgit');
    const file = `${name}.json`;
    evidenceNames.push(file);
    writeFileSync(path.join(source, file), JSON.stringify({ version: '2.0.0', platform: name, packages: [artifact, wrapperArtifact], checks: ['offline_install', 'ignore_scripts', 'tarball_integrity', 'asset_allowlist', 'npm_bin_shim', 'version', 'json_exit_2', 'json_exit_3', 'hook_stdin_stdout', 'no_git_rust_or_credentials', 'installed_surfaces'] }));
  }
  cpSync(source, destination, { recursive: true });
  rmSync(source, { recursive: true });
  const files = evidenceNames.map(name => path.join(destination, name));
  assert.equal(localRelease(files).packages.length, 6);
  writeFileSync(path.join(destination, 'specgit.tgz'), 'changed after qualification');
  assert.throws(() => localRelease(files), /Tarball bytes changed/);
});
