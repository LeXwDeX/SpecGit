#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const targets = {
  'x86_64-unknown-linux-gnu': { key: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: ['glibc'] },
  'aarch64-unknown-linux-gnu': { key: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: ['glibc'] },
  'x86_64-apple-darwin': { key: 'darwin-x64', os: 'darwin', cpu: 'x64' },
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
export function stage(target, output, binary) {
  const platform = targets[target];
  if (!platform) throw new Error(`Unsupported Rust target: ${target}`);
  const version = readFileSync(path.join(runtime, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
  if (existsSync(output)) throw new Error('Output directory already exists; select a fresh staging directory.');
  const executable = platform.os === 'win32' ? 'specgit.exe' : 'specgit';
  if (!binary) {
    const flags = [process.env.RUSTFLAGS ?? '', `--remap-path-prefix=${repo}=/specgit`, `--remap-path-prefix=${homedir()}=/build-user`].join(' ');
    run('cargo', ['build', '--locked', '--release', '--bin', 'specgit', '--target', target], { env: { ...process.env, RUSTFLAGS: flags }, stdio: 'inherit' });
    binary = path.join(runtime, 'target', target, 'release', executable);
  }
  const bytes = readFileSync(binary);
  verifyArchitecture(bytes, target);
  for (const privatePath of [repo, homedir()]) {
    if (bytes.includes(Buffer.from(privatePath)) || bytes.includes(Buffer.from(privatePath, 'utf16le'))) throw new Error('Binary contains a private build path; build with path remapping.');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  let minimumGlibc;
  if (platform.os === 'linux') {
    const versions = [...run('readelf', ['--version-info', binary]).matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)].map(m => [Number(m[1]), Number(m[2])]);
    if (!versions.length) throw new Error('Cannot prove the glibc requirement of this Linux executable.');
    versions.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    minimumGlibc = versions[0].join('.');
  }
  const name = `specgit-${platform.key}`;
  const base = { version, license: 'MIT', engines: { node: '>=20.19' }, publishConfig: { access: 'public' } };
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target]));
  const resolved = new Set(metadata.resolve.nodes.map(n => n.id));
  metadata.packages = metadata.packages.filter(p => resolved.has(p.id));
  const licenses = metadata.packages.filter(p => p.name !== 'specgit-runtime').map(p => ({ name: p.name, version: p.version, license: p.license })).sort((a, b) => a.name.localeCompare(b.name));
  if (licenses.some(p => !p.license)) throw new Error('A dependency license requires review before packaging.');
  const platformDir = path.join(output, name);
  mkdirSync(path.join(platformDir, 'bin'), { recursive: true });
  cpSync(binary, path.join(platformDir, 'bin', executable));
  chmodSync(path.join(platformDir, 'bin', executable), 0o755);
  const manifest = { ...base, name, description: `SpecGit native executable for ${platform.key}`, os: [platform.os], cpu: [platform.cpu], ...(platform.libc ? { libc: platform.libc } : {}), files: ['bin', 'LICENSE', 'THIRD_PARTY_LICENSES.json', 'licenses'], specgitNative: { target, sha256: digest, ...(minimumGlibc ? { minimumGlibc } : {}) } };
  writeFileSync(path.join(platformDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(path.join(platformDir, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(licenses, null, 2) + '\n');
  for (const dependency of metadata.packages.filter(p => p.name !== 'specgit-runtime')) {
    const root = path.dirname(dependency.manifest_path);
    const files = readdirSync(root, { withFileTypes: true }).filter(f => f.isFile() && /^(license|copying|notice)([.-]|$)/i.test(f.name));
    if (!files.length) throw new Error(`No bundled license text found for ${dependency.name}@${dependency.version}.`);
    const destination = path.join(platformDir, 'licenses', `${dependency.name}-${dependency.version}`);
    mkdirSync(destination, { recursive: true });
    for (const file of files) cpSync(path.join(root, file.name), path.join(destination, file.name));
  }
  cpSync(path.join(repo, 'LICENSE'), path.join(platformDir, 'LICENSE'));
  const wrapperDir = path.join(output, 'specgit');
  mkdirSync(path.join(wrapperDir, 'bin'), { recursive: true });
  writeFileSync(path.join(wrapperDir, 'bin', 'specgit.cjs'), readFileSync(path.join(here, 'launcher.cjs'), 'utf8').replace(/\r\n/g, '\n'));
  chmodSync(path.join(wrapperDir, 'bin', 'specgit.cjs'), 0o755);
  writeFileSync(path.join(wrapperDir, 'LICENSE'), readFileSync(path.join(repo, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n'));
  const wrapper = { ...base, name: 'specgit', description: 'Native GitHub and GitLab delivery harness', bin: { specgit: 'bin/specgit.cjs' }, files: ['bin', 'LICENSE'], optionalDependencies: Object.fromEntries(Object.values(targets).map(t => [`specgit-${t.key}`, version])) };
  writeFileSync(path.join(wrapperDir, 'package.json'), JSON.stringify(wrapper, null, 2) + '\n');
  const evidence = { version, target, platform: name, sha256: digest, packages: [platformDir, wrapperDir] };
  writeFileSync(path.join(output, 'staging.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { target: { type: 'string' }, output: { type: 'string' }, binary: { type: 'string' } } });
    if (!values.target || !values.output) throw new Error('Use --target <Rust target> --output <new directory> [--binary <remapped release artifact>].');
    process.stdout.write(JSON.stringify(stage(values.target, path.resolve(values.output), values.binary && path.resolve(values.binary))) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
