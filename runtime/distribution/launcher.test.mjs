import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
function fixture({ platform = 'darwin', arch = 'arm64', version = '2.0.0-dev.0', missing = false, corrupt = false, glibc } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-launcher-'));
  const wrapper = path.join(root, 'node_modules', 'specgit');
  mkdirSync(path.join(wrapper, 'bin'), { recursive: true });
  const key = `${platform}-${arch}${platform === 'linux' ? '-gnu' : ''}`;
  const name = `specgit-${key}`;
  const binary = path.join(root, 'node_modules', name);
  const bytes = Buffer.from('deliberately not executable');
  writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify({ version: '2.0.0-dev.0', optionalDependencies: { [name]: '2.0.0-dev.0' } }));
  cpSync(path.join(here, 'launcher.cjs'), path.join(wrapper, 'bin', 'specgit.cjs'));
  if (!missing) {
    mkdirSync(path.join(binary, 'bin'), { recursive: true });
    writeFileSync(path.join(binary, 'bin', platform === 'win32' ? 'specgit.exe' : 'specgit'), bytes);
    writeFileSync(path.join(binary, 'package.json'), JSON.stringify({ name, version, specgitNative: { sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), minimumGlibc: '2.34' } }));
  }
  const preload = path.join(root, 'platform.cjs');
  writeFileSync(preload, `Object.defineProperty(process, 'platform', {value: ${JSON.stringify(platform)}}); Object.defineProperty(process, 'arch', {value: ${JSON.stringify(arch)}}); process.report.getReport = () => ({header: {glibcVersionRuntime: ${JSON.stringify(glibc)}}});`);
  return spawnSync(process.execPath, ['--require', preload, path.join(wrapper, 'bin', 'specgit.cjs'), '--json'], { encoding: 'utf8', timeout: 5000 });
}
test('unsupported architecture, unknown libc and insufficient glibc fail precisely before spawning', () => {
  for (const [options, expected] of [
    [{ platform: 'linux', arch: 'riscv64' }, /Unsupported platform linux-riscv64/],
    [{ platform: 'linux' }, /musl and unknown libc/],
    [{ platform: 'linux', glibc: '2.31' }, /requires glibc >= 2.34/],
  ]) {
    const result = fixture(options);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }
});
test('missing dependency, version drift and corrupt binary never fall back to source or downloads', () => {
  for (const [options, expected] of [
    [{ missing: true }, /Missing specgit-darwin-arm64/],
    [{ version: '1.0.0' }, /versions differ/],
    [{ corrupt: true }, /checksum mismatch/],
  ]) {
    const result = fixture(options);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }
});
