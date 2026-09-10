#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyPrepared } from './release-artifacts.mjs';
import { registryRelease } from './release-check.mjs';

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function publishNpm(release, { registry = registryRelease, npm = args => command('npm', args), wait = sleep, attempts = 6 } = {}) {
  // Uses the caller's existing npm authentication; it never reads token files.
  npm(['whoami', '--registry=https://registry.npmjs.org']);
  let state = await registry(release);
  async function observed(name) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      state = await registry(release);
      if (state.observations.find(item => item.name === name)?.state === 'verified') return;
      if (attempt + 1 < attempts) await wait(5000);
    }
    throw new Error(`Registry propagation for ${name}@${release.version} remains unknown. Retry the same immutable release after checking the registry.`);
  }
  // Every version is immutable. A lost publish response stops here; a rerun
  // reads the registry first and never blindly repeats an applied publication.
  for (const artifact of [...release.packages.filter(item => item.name !== 'specgit'), release.packages.find(item => item.name === 'specgit')]) {
    need(artifact, 'Missing wrapper package.');
    state = await registry(release);
    if (artifact.name === 'specgit') need(state.observations.filter(item => item.name !== 'specgit').every(item => item.state === 'verified'), 'Native packages must be visible before the wrapper.');
    if (state.observations.find(item => item.name === artifact.name)?.state !== 'verified') {
      npm(['publish', artifact.tarball, '--registry=https://registry.npmjs.org', '--access=public', '--ignore-scripts', '--provenance=false', '--tag=v2-staging']);
      await observed(artifact.name);
    }
  }
  state = await registry(release);
  need(state.can_promote_latest, 'All immutable package versions must be verified before latest promotion.');
  for (const artifact of [...release.packages.filter(item => item.name !== 'specgit'), release.packages.find(item => item.name === 'specgit')]) {
    npm(['dist-tag', 'add', `${artifact.name}@${artifact.version}`, 'latest', '--registry=https://registry.npmjs.org']);
    let matched = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const latest = JSON.parse(npm(['view', artifact.name, 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org']));
      if (latest === artifact.version) { matched = true; break; }
      if (attempt + 1 < attempts) await wait(5000);
    }
    need(matched, `The latest tag for ${artifact.name} is not confirmed. Retry the same release.`);
  }
  return { ...state, latest_verified: true, publication_performed: true };
}
export function verifyLatest(release, npm = args => command('npm', args)) {
  for (const artifact of release.packages) need(JSON.parse(npm(['view', artifact.name, 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org'])) === release.version, `The latest tag for ${artifact.name} is not confirmed.`);
}
export function requireMain(source, lookup = () => api(`repos/${repository}/git/ref/heads/main`)) {
  const main = lookup();
  need(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === source, 'Publication source must be the current verified main commit.');
}
export function verifyBuildRun(run, source) {
  need(run.head_sha === source && run.head_branch === 'main' && run.head_repository?.full_name === repository && run.repository?.full_name === repository && run.path === '.github/workflows/release-prepare.yml' && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success', 'Release artifacts must come from a successful main build of this exact workflow and source.');
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
  const files = [...release.packages.map(item => item.tarball), path.join(directory, 'SHASUMS256.txt'), path.join(directory, 'release.json')];
  const scratch = mkdtempSync(path.join(tmpdir(), 'specgit-release-metadata-'));
  try {
    if (!current) {
      const notes = path.join(scratch, 'notes.md');
      writeFileSync(notes, `SpecGit ${tag}: native Rust CLI for macOS arm64, Linux x64 (glibc), and Windows x64.\n\nInstall with npm: \`npm install -g specgit@${release.version} --ignore-scripts\`. The three platform tgz assets also contain standalone executables under \`package/bin/\`; extracting one does not require Node.js.\n\nVerify downloaded assets with SHASUMS256.txt. Exact source: \`${release.source}\`. See the repository's v2 migration guide before replacing a v1 project configuration.\n`);
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' }, npm: { type: 'boolean', default: false }, github: { type: 'boolean', default: false }, 'verify-build-run': { type: 'string' }, 'build-run': { type: 'string' } } });
    if (values['verify-build-run']) {
      verifyBuildRun(JSON.parse(readFileSync(values['verify-build-run'], 'utf8')), values.source);
      process.stdout.write(JSON.stringify({ build_run_verified: true, source: values.source }) + '\n');
    } else {
      need(values.directory, 'Use --directory <qualified release bundle> --version <stable version> --source <commit> [--build-run <id> --npm] [--github]. Without write flags, registry verification is read-only.');
      const directory = path.resolve(values.directory);
      const release = verifyPrepared(directory, values.version, values.source);
      if (values.npm || values.github) {
        need(/^[1-9][0-9]*$/.test(values['build-run'] ?? ''), 'An explicit --build-run <successful main Actions run> is required for publication.');
        verifyBuildRun(api(`repos/${repository}/actions/runs/${values['build-run']}`), release.source);
        requireMain(release.source);
      }
      const registry = values.npm ? await publishNpm(release) : await registryRelease(release);
      if (values.github) need(registry.can_promote_latest, 'All exact npm package versions must be registry-verified before GitHub Release publication.');
      if (values.github) verifyLatest(release);
      const github = values.github ? publishGithub(release, directory) : undefined;
      process.stdout.write(JSON.stringify({ version: release.version, source: release.source, registry, ...(github ? { github } : {}), publication_performed: values.npm || values.github }) + '\n');
    }
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
