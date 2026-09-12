#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run, targets, verifyArchitecture } from './stage.mjs';

const requiredChecks = ['offline_install', 'ignore_scripts', 'tarball_integrity', 'asset_allowlist', 'npm_bin_shim', 'machine_version_help', 'json_exit_2', 'json_exit_3', 'hook_stdin_stdout', 'no_git_rust_or_credentials', 'installed_surfaces'];
function need(value, message) { if (!value) throw new Error(message); }
function member(tarball, name) {
  const archive = path.resolve(tarball);
  // GNU tar treats a drive-letter archive path as a remote host. Keep directory
  // selection in cwd; ./ also prevents a filename from becoming a tar option.
  return run('tar', ['-xOf', `./${path.basename(archive)}`, `package/${name}`], { cwd: path.dirname(archive), encoding: null, maxBuffer: 64 * 1024 * 1024 });
}
export function localRelease(files) {
  need(files.length === Object.keys(targets).length, 'Three independently installed platform evidence files are required.');
  const expected = new Set(Object.values(targets).map(p => `specgit-${p.key}`));
  const seen = new Set();
  const artifacts = new Map();
  let version;
  let source;
  for (const file of files) {
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    version ??= evidence.version;
    source ??= evidence.source;
    need(/^[a-f0-9]{40}$/.test(source ?? '') && evidence.source === source, 'Installed source commits differ or are missing.');
    need(evidence.version === version, 'Installed platform versions differ.');
    need(expected.has(evidence.platform) && !seen.has(evidence.platform), 'Platform evidence is unknown or duplicated.');
    seen.add(evidence.platform);
    need(requiredChecks.every(c => evidence.checks?.includes(c)), 'Installed qualification is incomplete.');
    need(evidence.packages?.length === 2, 'Each platform must include exactly its native package and wrapper.');
    const pair = new Set();
    for (const artifact of evidence.packages) {
      need([evidence.platform, 'specgit'].includes(artifact.name) && !pair.has(artifact.name), 'Unexpected or duplicate package in installed evidence.');
      pair.add(artifact.name);
      need(typeof artifact.tarball === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(artifact.tarball), 'Tarballs must be colocated portable filenames.');
      const tarball = path.resolve(path.dirname(file), artifact.tarball);
      const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
      need(integrity === artifact.integrity, 'Tarball bytes changed after installation.');
      const manifest = JSON.parse(member(tarball, 'package.json').toString('utf8'));
      need(manifest.name === artifact.name && manifest.version === version && manifest.specgitSource === source, 'Tarball identity differs from installed evidence.');
      need(!manifest.scripts && manifest.license === 'MIT', 'Unexpected lifecycle scripts or package license.');
      let executable_sha256;
      if (artifact.name === 'specgit') {
        need(manifest.bin?.specgit === 'bin/specgit.cjs' && !manifest.exports && !manifest.dependencies, 'The public wrapper must contain only the native launcher.');
        executable_sha256 = createHash('sha256').update(member(tarball, 'bin/specgit.cjs')).digest('hex');
        const entries = Object.entries(manifest.optionalDependencies ?? {});
        need(entries.length === expected.size && entries.every(([name, pinned]) => expected.has(name) && pinned === version), 'Wrapper platform pins are incomplete or inexact.');
      } else {
        const target = manifest.specgitNative?.target;
        const platform = targets[target];
        need(platform && `specgit-${platform.key}` === artifact.name, 'Native target and package identity differ.');
        const bytes = member(tarball, `bin/${platform.os === 'win32' ? 'specgit.exe' : 'specgit'}`);
        verifyArchitecture(bytes, target);
        executable_sha256 = createHash('sha256').update(bytes).digest('hex');
        need(executable_sha256 === manifest.specgitNative.sha256, 'Packaged binary digest mismatch.');
      }
      const existing = artifacts.get(artifact.name);
      need(!existing || existing.integrity === integrity, 'The same wrapper version has different tarball bytes across target builds.');
      artifacts.set(artifact.name, { name: artifact.name, version, integrity, tarball, executable_sha256, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') });
    }
  }
  need(seen.size === expected.size && artifacts.size === expected.size + 1, 'Complete platform publication set is missing.');
  return { version, source, packages: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
export async function registryMetadata(artifact, fetcher = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (response.status === 404) return null;
  need(response.ok, `Registry read failed for ${artifact.name}: HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Registry metadata exceeds its size limit.'); }
    chunks.push(value);
  }
  const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  need(metadata.name === artifact.name && metadata.version === artifact.version, 'Registry identity mismatch.');
  return metadata;
}
export async function registryRelease(release, fetcher = fetch) {
  const observations = [];
  for (const artifact of release.packages) {
    const metadata = await registryMetadata(artifact, fetcher);
    if (!metadata) { observations.push({ ...artifact, state: 'missing' }); continue; }
    need(metadata.dist?.integrity === artifact.integrity, `Published bytes differ for ${artifact.name}@${artifact.version}; choose a new version.`);
    observations.push({ ...artifact, state: 'verified' });
  }
  const missingPlatforms = observations.filter(p => p.name !== 'specgit' && p.state === 'missing');
  const wrapper = observations.find(p => p.name === 'specgit');
  need(wrapper, 'Wrapper package observation is missing.');
  const phase = missingPlatforms.length ? 'platforms_missing' : wrapper.state === 'missing' ? 'wrapper_missing' : 'registry_verified';
  return { version: release.version, phase, observations, next: missingPlatforms.length ? missingPlatforms.map(p => p.name) : wrapper.state === 'missing' ? ['specgit'] : [], can_promote_latest: phase === 'registry_verified' && /^\d+\.\d+\.\d+$/.test(release.version), publication_performed: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { evidence: { type: 'string', multiple: true }, registry: { type: 'boolean', default: false } } });
    const release = localRelease(values.evidence ?? []);
    const result = values.registry ? await registryRelease(release) : { ...release, phase: 'local_qualified_registry_unchecked', can_promote_latest: false, publication_performed: false };
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
