#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyPrepared } from './release-artifacts.mjs';
import { publishNpm } from './npm-publish.mjs';
import { registryRelease } from './release-check.mjs';

export { publishNpm } from './npm-publish.mjs';

const repository = 'LeXwDeX/SpecGit';
const need = (condition, message) => { if (!condition) throw new Error(message); };
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 300_000, ...options });
  if (result.error || result.status !== 0) {
    // Credential-bearing subprocess output is not copied into JSON/errors.
    throw new Error(`${program} ${args[0]} failed (exit ${result.status ?? 'unknown'}). Inspect the native CLI authentication/permission status; retry this exact release to reconcile any applied write.`);
  }
  return result.stdout;
}
function gh(args, options) { return command('gh', args, options); }
const api = (route, args = [], options) => JSON.parse(gh(['api', route, ...args], options));
export function requireMain(source, lookup = () => api(`repos/${repository}/git/ref/heads/main`)) {
  const main = lookup();
  need(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === source, 'Publication source must be the current verified main commit.');
}
export function verifyBuildRun(run, source) {
  need(run.head_sha === source && run.head_branch === 'main' && run.head_repository?.full_name === repository && run.repository?.full_name === repository && run.path === '.github/workflows/release-prepare.yml' && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success', 'Release artifacts must come from a successful main build of this exact workflow and source.');
}
export function verifyRecovery(current, previous, git = args => command('git', ['-C', fileURLToPath(new URL('../../', import.meta.url)), ...args])) {
  need(current.version === previous.version && current.source !== previous.source, 'Recovery requires the same version from an explicitly different source.');
  git(['merge-base', '--is-ancestor', previous.source, current.source]);
  // Packaging provenance may change; runtime, launcher, schemas and licenses may not.
  git(['diff', '--exit-code', previous.source, current.source, '--', 'runtime/src', 'runtime/tests', 'runtime/Cargo.toml', 'runtime/Cargo.lock', 'runtime/.cargo', 'runtime/schemas', 'runtime/REFERENCE.md', 'runtime/distribution/launcher.cjs', 'runtime/distribution/stage.mjs', 'runtime/distribution/check-surfaces.mjs', 'LICENSE', 'package.json']);
  const hashes = release => release.packages.map(p => [p.name, p.executable_sha256]).sort((a, b) => a[0].localeCompare(b[0]));
  need(current.packages.every(p => /^[a-f0-9]{64}$/.test(p.executable_sha256 ?? '')), 'Current executable identity is missing.');
  need(JSON.stringify(hashes(current)) === JSON.stringify(hashes(previous)), 'Recovery executables differ from current-main qualification.');
}
export function githubFiles(release, scratch) {
  const native = release.packages.filter(item => item.name !== 'specgit');
  need(native.length === 3, 'Three native GitHub archives are required.');
  const manifest = path.join(scratch, 'release.json');
  writeFileSync(manifest, JSON.stringify({ version: release.version, source: release.source, packages: native.map(({ name, sha256, executable_sha256, tarball }) => ({ name, sha256, executable_sha256, tarball: path.basename(tarball) })) }, null, 2) + '\n');
  const files = [...native.map(item => item.tarball), manifest];
  const sums = path.join(scratch, 'SHASUMS256.txt');
  writeFileSync(sums, files.map(file => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${path.basename(file)}`).sort().join('\n') + '\n');
  return [...native.map(item => item.tarball), sums, manifest];
}
export function publishGithub(release, directory, { request = api, cli = gh } = {}) {
  const tag = `v${release.version}`;
  // A tag with the right spelling alone does not prove its source commit.
  const tags = request(`repos/${repository}/git/matching-refs/tags/${tag}`);
  need(Array.isArray(tags), 'Native tag read is incomplete.');
  const existing = tags.find(ref => ref.ref === `refs/tags/${tag}`);
  if (existing) {
    const commit = request(`repos/${repository}/commits/${tag}`);
    need(commit.sha === release.source, 'The immutable release tag points to another commit.');
  } else {
    request(`repos/${repository}/git/refs`, ['--method', 'POST', '--input', '-'], { input: JSON.stringify({ ref: `refs/tags/${tag}`, sha: release.source }) });
  }
  const verifiedTag = request(`repos/${repository}/commits/${tag}`);
  need(verifiedTag.sha === release.source, 'Tag creation/readback did not confirm the release source.');
  const pages = request(`repos/${repository}/releases?per_page=100`, ['--paginate', '--slurp']);
  need(Array.isArray(pages) && pages.every(page => Array.isArray(page)), 'Release discovery is incomplete.');
  let current = pages.flat().find(item => item.tag_name === tag);
  const scratch = mkdtempSync(path.join(tmpdir(), 'specgit-release-metadata-'));
  try {
    const files = githubFiles(release, scratch);
    if (!current) {
      const notes = path.join(scratch, 'notes.md');
      writeFileSync(notes, `SpecGit ${tag}: native Rust CLI for macOS arm64, Linux x64 (glibc), and Windows x64.\n\nManual installation: download the matching platform archive and verify it with SHASUMS256.txt. Extract it and place package/bin/specgit (specgit.exe on Windows) in a directory on PATH. Keep the bundled license texts. Run specgit --human --version. Node.js, npm and Rust are not required.\n\nThese are the exact native archives from the verified Actions build. npm is a separate publication channel; this GitHub Release does not claim that npm publication is complete. After npm availability is confirmed, install with npm install -g specgit@${release.version} --ignore-scripts.\n\nExact source: \`${release.source}\`. See the v2 migration guide before replacing a v1 project configuration.\n`);
      cli(['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', `SpecGit ${tag}`, '--notes-file', notes, '--draft']);
    }
    function state() {
      const value = JSON.parse(cli(['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease,assets,url']));
      need(value.tagName === tag && typeof value.isDraft === 'boolean' && typeof value.isPrerelease === 'boolean' && Array.isArray(value.assets), 'Native Release state is incomplete.');
      return value;
    }
    function verifyAssets(value, phase, allowMissing) {
      const destinationRoot = path.join(scratch, phase);
      mkdirSync(destinationRoot);
      need(value.assets.every(asset => files.some(file => path.basename(file) === asset.name)), 'Unexpected Release asset; reconcile the inventory without overwriting published assets.');
      const missing = [];
      for (const file of files) {
        const name = path.basename(file);
        const matches = value.assets.filter(asset => asset.name === name);
        need(matches.length <= 1, 'Duplicate Release asset names.');
        if (!matches.length) {
          need(allowMissing, `Release asset ${name} is missing after upload.`);
          missing.push(file);
          continue;
        }
        const destination = path.join(destinationRoot, name);
        cli(['release', 'download', tag, '--repo', repository, '--pattern', name, '--output', destination]);
        need(createHash('sha256').update(readFileSync(destination)).digest('hex') === createHash('sha256').update(readFileSync(file)).digest('hex'), `Release asset ${name} differs; do not overwrite an immutable published asset.`);
      }
      return missing;
    }
    current = state();
    // Check every existing asset before issuing any upload. A matching draft
    // left by an interrupted create/upload is recoverable; conflicts are not.
    const missing = verifyAssets(current, 'preflight', true);
    for (const file of missing) cli(['release', 'upload', tag, '--repo', repository, file]);
    current = state();
    verifyAssets(current, 'uploaded', false);
    need(request(`repos/${repository}/commits/${tag}`).sha === release.source, 'Release tag changed before publication.');
    cli(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest']);
    current = state();
    need(current.isDraft === false && current.isPrerelease === false, 'Stable Release state is not confirmed.');
    need(request(`repos/${repository}/releases/latest`).tag_name === tag, 'The latest GitHub Release is not confirmed.');
    verifyAssets(current, 'published', false);
    return { tag, source: release.source, url: current.url, assets_verified: files.map(file => path.basename(file)) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export async function publishChannels(release, directory, npmRelease, values, { registry = registryRelease, github = publishGithub, npm = candidate => publishNpm(candidate, { npm: args => command('npm', args) }) } = {}) {
  const observed = values.npm ? await registry(npmRelease) : undefined;
  const githubResult = values.github && !values.preflight ? github(release, directory) : undefined;
  const npmResult = values.npm && !values.preflight ? await npm(npmRelease) : observed;
  return { ...(githubResult ? { github: githubResult } : {}), ...(npmResult ? { npm: npmResult, npm_source: npmRelease.source } : {}), publication_performed: !values.preflight && Boolean(values.github || values.npm) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' }, npm: { type: 'boolean', default: false }, github: { type: 'boolean', default: false }, preflight: { type: 'boolean', default: false }, 'npm-directory': { type: 'string' }, 'npm-build-run': { type: 'string' }, 'verify-build-run': { type: 'string' }, 'build-run': { type: 'string' } } });
    if (values['verify-build-run']) {
      verifyBuildRun(JSON.parse(readFileSync(values['verify-build-run'], 'utf8')), values.source);
      process.stdout.write(JSON.stringify({ build_run_verified: true, source: values.source }) + '\n');
    } else {
      need(values.directory, 'Use --directory <qualified bundle> --version <stable version> --source <commit> --build-run <id> [--github] [--npm] [--preflight]. No channel flags means offline verification.');
      need(!values['npm-directory'] || values.npm, '--npm-directory requires --npm.');
      need(!values['npm-build-run'] || values['npm-directory'], '--npm-build-run requires --npm-directory.');
      const directory = path.resolve(values.directory);
      const release = verifyPrepared(directory, values.version, values.source);
      if (values.github || values.npm) {
        need(/^[1-9][0-9]*$/.test(values['build-run'] ?? ''), 'An explicit --build-run <successful main Actions run> is required for publication.');
        verifyBuildRun(api(`repos/${repository}/actions/runs/${values['build-run']}`), release.source);
        requireMain(release.source);
      }
      let npmRelease = release;
      if (values['npm-directory']) {
        const oldDirectory = path.resolve(values['npm-directory']);
        const oldSource = JSON.parse(readFileSync(path.join(oldDirectory, 'release.json'), 'utf8')).source;
        npmRelease = verifyPrepared(oldDirectory, values.version, oldSource);
        need(/^[1-9][0-9]*$/.test(values['npm-build-run'] ?? ''), 'Recovery requires --npm-build-run.');
        verifyBuildRun(api(`repos/${repository}/actions/runs/${values['npm-build-run']}`), oldSource);
        verifyRecovery(release, npmRelease);
      }
      // Read every npm identity before either channel writes, but availability
      // is never a GitHub-only prerequisite. A missing version is resumable.
      const result = await publishChannels(release, directory, npmRelease, values);
      process.stdout.write(JSON.stringify({ version: release.version, source: release.source, bundle_verified: true, ...result }) + '\n');
    }
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
