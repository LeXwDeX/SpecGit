#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyNativeBundle } from './native-release.mjs';

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
export function verifyBuildRun(run, source, { activeRun, jobs = [] } = {}) {
  const owned = run.head_sha === source && run.head_branch === 'main' && run.head_repository?.full_name === repository && run.repository?.full_name === repository && run.path === '.github/workflows/release-prepare.yml' && run.event === 'workflow_dispatch';
  const completed = run.status === 'completed' && run.conclusion === 'success';
  const running = run.status === 'in_progress' && String(run.id) === activeRun && ['linux', 'macos', 'windows'].every(label => {
    const matches = jobs.filter(job => job.name === `Build native release (${label})`);
    return matches.length === 1 && matches[0].conclusion === 'success' && matches[0].status === 'completed' && matches[0].labels?.includes('self-hosted');
  });
  need(owned && (completed || running), 'Release requires the exact main build with three successful native smoke jobs.');
}
export function githubFiles(release) {
  need(release.binaries?.length === 3 && new Set(release.binaries.map(b => b.filename)).size === 3, 'Three native GitHub executables are required.');
  for (const entry of release.binaries) need(createHash('sha256').update(readFileSync(entry.file)).digest('hex') === entry.sha256, 'Native executable digest differs before publication.');
  return release.binaries.map(entry => entry.file);
}
export function releaseNotes(release, buildRun) {
  return `SpecGit v${release.version}: native Rust CLI for macOS arm64, Linux x64 (glibc), and Windows x64.

Download the matching executable below, rename it to specgit (specgit.exe on Windows), and put it in a directory on PATH. On macOS/Linux run chmod +x specgit. Verify its SHA-256 against this table, then run specgit --human --version. No Node.js, npm or Rust installation is required.

| Binary | SHA-256 |
| --- | --- |
${release.binaries.map(b => `| ${b.filename} | \`${b.sha256}\` |`).join('\n')}

Each binary passed version, help and schema smoke tests on its native self-hosted runner.
Source: \`${release.source}\`.
${buildRun ? `Build: https://github.com/${repository}/actions/runs/${buildRun}\n` : ''}
License: https://github.com/${repository}/blob/${release.source}/LICENSE
See the v2 migration guide before replacing a v1 project configuration.
`;
}
export function publishGithub(release, directory, { request = api, cli = gh, buildRun } = {}) {
  const files = githubFiles(release);
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
    const notes = path.join(scratch, 'notes.md');
    writeFileSync(notes, releaseNotes(release, buildRun));
    if (!current) {
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
    cli(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest', '--notes-file', notes]);
    current = state();
    need(current.isDraft === false && current.isPrerelease === false, 'Stable Release state is not confirmed.');
    need(request(`repos/${repository}/releases/latest`).tag_name === tag, 'The latest GitHub Release is not confirmed.');
    verifyAssets(current, 'published', false);
    return { tag, source: release.source, url: current.url, assets_verified: files.map(file => path.basename(file)) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' }, github: { type: 'boolean', default: false }, preflight: { type: 'boolean', default: false }, 'build-run': { type: 'string' } } });
    need(values.directory, 'Use --directory <native bundle> --version <stable version> --source <commit> [--github --build-run <id>] [--preflight].');
    const directory = path.resolve(values.directory);
    const release = verifyNativeBundle(directory, values.version, values.source);
    if (values.github) {
      need(/^[1-9][0-9]*$/.test(values['build-run'] ?? ''), 'An explicit --build-run is required.');
      const run = api(`repos/${repository}/actions/runs/${values['build-run']}`);
      const activeRun = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_RUN_ID === values['build-run'] ? values['build-run'] : undefined;
      const jobs = activeRun ? api(`repos/${repository}/actions/runs/${values['build-run']}/jobs?per_page=100`, ['--paginate', '--slurp']).flatMap(page => page.jobs) : [];
      verifyBuildRun(run, release.source, { activeRun, jobs });
      requireMain(release.source);
    }
    const github = values.github && !values.preflight ? publishGithub(release, directory, { buildRun: values['build-run'] }) : undefined;
    process.stdout.write(JSON.stringify({ version: release.version, source: release.source, bundle_verified: true, ...(github ? { github } : {}), publication_performed: Boolean(github) }) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
