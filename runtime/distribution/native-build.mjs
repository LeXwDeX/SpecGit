import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const targets = {
  'x86_64-unknown-linux-gnu': { key: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: ['glibc'] },
  'aarch64-apple-darwin': { key: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  'x86_64-pc-windows-msvc': { key: 'win32-x64', os: 'win32', cpu: 'x64' },
};
const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.dirname(here);
const repo = path.dirname(runtime);
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: runtime, encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
export function verifyArchitecture(bytes, target) {
  if (bytes.length < 64) throw new Error('Native artifact is not a complete executable.');
  let matches = false;
  if (target.endsWith('-linux-gnu')) {
    matches = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (target.startsWith('aarch64') ? 183 : 62);
  } else if (target.endsWith('-apple-darwin')) {
    matches = bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (target.startsWith('aarch64') ? 0x0100000c : 0x01000007);
  } else if (target === 'x86_64-pc-windows-msvc') {
    const pe = bytes.readUInt32LE(0x3c);
    matches = bytes.readUInt16LE(0) === 0x5a4d && pe <= bytes.length - 6 &&
      bytes.readUInt32LE(pe) === 0x00004550 && bytes.readUInt16LE(pe + 4) === 0x8664;
  }
  if (!matches) throw new Error(`Native artifact architecture does not match ${target}.`);
}
export function buildNative(target) {
  const platform = targets[target];
  if (!platform) throw new Error(`Unsupported Rust target: ${target}`);
  const flags = [process.env.RUSTFLAGS ?? '', `--remap-path-prefix=${repo}=/specgit`, `--remap-path-prefix=${homedir()}=/build-user`].join(' ');
  run('cargo', ['build', '--locked', '--release', '--bin', 'specgit', '--target', target], { env: { ...process.env, RUSTFLAGS: flags }, stdio: 'inherit' });
  const targetDirectory = process.env.CARGO_TARGET_DIR ? path.resolve(runtime, process.env.CARGO_TARGET_DIR) : path.join(runtime, 'target');
  return path.join(targetDirectory, target, 'release', platform.os === 'win32' ? 'specgit.exe' : 'specgit');
}
