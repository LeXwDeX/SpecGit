#!/usr/bin/env node
// CI scheduling is based on committed changes, never on .gitignore contents.
// Locked Changesets parsing needs no lifecycle scripts or product build.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseNote } from './ci-changesets.mjs';

const METADATA_FILES = new Set([
  '.gitignore', '.specgit.yaml', 'spec_git/policy.yaml', 'spec_git/providers.yaml',
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md', 'LICENSE', 'SECURITY.md',
  '.changeset/README.md', '.changeset/config.json', '.coderabbit.yaml',
  '.github/dependabot.yml', '.github/workflows/README.md', '.devcontainer/README.md',
  'scripts/README.md', 'skills/README.md', '.github/CODEOWNERS',
]);
const NIX_INPUTS = new Set([
  'flake.nix', 'flake.lock', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'scripts/update-flake.sh', '.github/workflows/ci.yml', 'scripts/ci-change-scope.mjs',
]);
const DEPENDENCY_INPUTS = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
  '.github/dependabot.yml', '.github/workflows/security.yml', 'scripts/ci-change-scope.mjs',
]);
const SKILLS = '(?:doctor|finish|issue|pr|status)';
const LOCAL_ENTRY = new RegExp(`^(?:\\.agents/skills/specgit-${SKILLS}/SKILL\\.md|\\.opencode/command/specgit-${SKILLS}\\.md)$`);
const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const LOCAL_STATE = /^(?:\.local\/|\.pnpm-store\/|node_modules\/|dist\/|coverage\/|\.DS_Store$)/;

/** @param {string} file */
function metadataPath(file) {
  if (/[\\\p{Cc}]/u.test(file) || file.startsWith('/')
    || file.split('/').some((part) => part === '.' || part === '..' || part === '')) return false;
  return METADATA_FILES.has(file) || /^(?:docs|workflows)\/.+\.md$/.test(file)
    || /^\.github\/ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml)$/.test(file)
    || file === '.github/PULL_REQUEST_TEMPLATE.md'
    || CHANGESET.test(file) || LOCAL_ENTRY.test(file);
}

/** @param {string[]} paths */
export function classifyPaths(paths) {
  const unique = [...new Set(paths)];
  const metadata = unique.every(metadataPath);
  return {
    build: !metadata,
    metadata,
    nix: unique.some((file) => NIX_INPUTS.has(file)),
    dependencies: unique.some((file) => DEPENDENCY_INPUTS.has(file)),
    release_intent: false,
    paths: unique,
  };
}

/** @param {{status: string, path: string}[]} entries */
export function classifyEntries(entries) {
  for (const entry of entries) {
    if (entry.status !== 'D' && LOCAL_STATE.test(entry.path)) throw new Error(`${entry.path}: local state or build output must not be committed.`);
  }
  const applicablePaths = entries.filter((entry) => !(entry.status === 'D' && LOCAL_STATE.test(entry.path))).map((entry) => entry.path);
  return { ...classifyPaths(applicablePaths), paths: entries.map((entry) => entry.path) };
}

/** @param {...string} args */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} ref */
function commit(ref) {
  return git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
}

/** @param {string} ref @param {string} file */
function gitText(ref, file) {
  return git('show', `${ref}:${file}`);
}

/** @param {string} text @param {string} file */
function validateChangeset(text, file) {
  return parseReleaseNote(text, file).releases.length > 0;
}

/** @param {string} base @param {string} head */
function changedEntries(base, head) {
  // Disable rename collapsing: moving implementation into docs must retain the deleted source path.
  const fields = git('diff', '--name-status', '--no-renames', '-z', base, head, '--').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('The Git change list is incomplete.');
  const entries = [];
  for (let i = 0; i < fields.length; i += 2) entries.push({ status: fields[i], path: fields[i + 1] });
  return entries;
}

/**
 * @param {string | undefined} eventName
 * @param {{pull_request?: {base?: {sha?: string}, head?: {sha?: string}}, merge_group?: {base_sha?: string, head_sha?: string}, before?: string, after?: string}} event
 */
function eventRange(eventName, event) {
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    if (!event.pull_request?.base?.sha || !event.pull_request?.head?.sha) throw new Error('Pull request base/head evidence is missing.');
    const head = commit(event.pull_request.head.sha);
    const base = git('merge-base', commit(event.pull_request.base.sha), head).trim();
    return { base, head };
  }
  if (eventName === 'merge_group') {
    if (!event.merge_group?.base_sha || !event.merge_group?.head_sha) throw new Error('Merge group base/head evidence is missing.');
    return { base: commit(event.merge_group.base_sha), head: commit(event.merge_group.head_sha) };
  }
  if (eventName === 'push') {
    if (!event.before || !event.after) throw new Error('Push before/after evidence is missing.');
    if (/^0+$/.test(event.before)) return null;
    return { base: commit(event.before), head: commit(event.after) };
  }
  // Scheduled and explicitly dispatched verification always examines the complete product.
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') return null;
  throw new Error(`No complete change range for event ${JSON.stringify(eventName)}.`);
}

/** @param {{base?: string, head?: string}} options */
export function inspectChanges(options = {}) {
  let range;
  if (options.base !== undefined || options.head !== undefined) {
    if (!options.base || !options.head) throw new Error('Provide both --base and --head.');
    range = { base: commit(options.base), head: commit(options.head) };
  } else {
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required; local use needs --base and --head.');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    range = eventRange(eventName, event);
  }
  if (range === null) {
    return { build: true, metadata: false, nix: true, dependencies: true, release_intent: false, paths: [], reason: 'Full verification requested or no prior branch revision.' };
  }
  const entries = changedEntries(range.base, range.head);
  const result = { ...classifyEntries(entries), base: range.base, head: range.head };
  let releaseIntent = false;
  for (const entry of entries) {
    if (entry.status !== 'D' && CHANGESET.test(entry.path)) {
      const requestsRelease = validateChangeset(gitText(range.head, entry.path), entry.path);
      releaseIntent ||= requestsRelease;
    }
  }
  if (entries.some((entry) => entry.path === 'package.json')) {
    const previous = JSON.parse(gitText(range.base, 'package.json'));
    const next = JSON.parse(gitText(range.head, 'package.json'));
    if (typeof previous.version !== 'string' || typeof next.version !== 'string') throw new Error('Package version evidence is missing.');
    releaseIntent ||= previous.version !== next.version;
  }
  result.release_intent = releaseIntent;
  return result;
}

function main() {
  /** @type {{base?: string, head?: string}} */
  const options = {};
  let assertMetadata = false;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--assert-metadata') assertMetadata = true;
    else if (arg === '--base' || arg === '--head') {
      if (!process.argv[i + 1]) throw new Error(`Missing value for ${arg}.`);
      if (arg === '--base') options.base = process.argv[++i];
      else options.head = process.argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const result = inspectChanges(options);
  if (assertMetadata && (!result.metadata || result.build)) throw new Error('This change requires product verification; metadata-only validation is not applicable.');
  if (process.env.GITHUB_OUTPUT) {
    for (const key of /** @type {const} */ (['build', 'metadata', 'nix', 'dependencies', 'release_intent'])) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${result[key]}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`CI change classification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
