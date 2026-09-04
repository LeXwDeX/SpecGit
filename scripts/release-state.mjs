import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseNote } from './ci-changesets.mjs';

/** @param {string} command @param {string[]} args */
const runCommand = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const RELEASE_PUBLICATION_TIMEOUT_MS = 60_000;
const RELEASE_PUBLICATION_POLL_MS = 5_000;

/** @param {number} delayMs */
const sleepFor = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));

/** @param {string} version */
function requireVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('A valid package version is required.');
  }
}

/**
 * A push needs a release-relevant diff. Explicit manual dispatch may prepare
 * or recover a release; its optional version guard must match package.json.
 * @param {{event: string, version: string, releaseIntent: boolean, pending: string[], requestedVersion?: string}} options
 */
export function planRelease({ event, version, releaseIntent, pending, requestedVersion }) {
  requireVersion(version);
  if (event === 'workflow_dispatch') {
    if (requestedVersion && requestedVersion !== version) throw new Error('The requested release version must match package.json exactly.');
    return { eligible: true, version, pending: pending.length };
  }
  return { eligible: event === 'push' && releaseIntent, version, pending: pending.length };
}

/** @param {string} root */
export function pendingChangesets(root) {
  /** @type {string[]} */
  let consumed = [];
  try {
    /** @type {{changesets?: unknown}} */
    const pre = JSON.parse(readFileSync(resolve(root, '.changeset/pre.json'), 'utf8'));
    if (!Array.isArray(pre.changesets) || pre.changesets.some((entry) => typeof entry !== 'string')) {
      throw new Error('Prerelease metadata must identify its consumed changesets.');
    }
    consumed = pre.changesets;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  let files;
  try {
    files = readdirSync(resolve(root, '.changeset'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    return [];
  }
  return files.filter((file) => file.endsWith('.md') && file !== 'README.md')
    .filter((file) => !consumed.includes(file.slice(0, -3)))
    .filter((file) => parseReleaseNote(readFileSync(resolve(root, '.changeset', file), 'utf8'), file).releases.length > 0)
    .map((file) => file.slice(0, -3));
}

/**
 * Read publication and tag evidence independently so retries can repair a
 * partial release. Registry gitHead anchors recovery after main advances.
 * @param {{version: string, run?: (command: string, args: string[]) => string}} options
 * @returns {{needsPublish: boolean, releaseSha: string, tagExists: boolean}}
 */
export function readReleaseState({ version, run = runCommand }) {
  requireVersion(version);
  let published;
  try {
    published = JSON.parse(run('npm', ['view', `specgit@${version}`, 'version', 'gitHead', '--json']));
    if (Array.isArray(published)) {
      if (published.length !== 1) {
        throw new Error('Registry lookup must return exactly one published version.');
      }
      [published] = published;
    }
  } catch (error) {
    let code;
    try {
      const output = /** @type {{stdout?: string}} */ (error).stdout;
      code = JSON.parse(output ?? '').error?.code;
    } catch { /* Transport and parse failures are never absence evidence. */ }
    if (code !== 'E404') throw error;
  }
  const tag = `refs/tags/v${version}`;
  const rows = run('git', ['ls-remote', '--tags', 'origin', tag, `${tag}^{}`]).split(/\r?\n/).filter(Boolean);
  const refs = new Map(rows.map((row) => {
    const [sha, ref] = row.split(/\s+/);
    if (!/^[a-f0-9]{40}$/i.test(sha) || ![tag, `${tag}^{}`].includes(ref)) {
      throw new Error('Git returned unexpected release tag evidence.');
    }
    return [ref, sha];
  }));
  const tagSha = refs.get(`${tag}^{}`) ?? refs.get(tag);
  if (published === undefined) {
    if (tagSha !== undefined) throw new Error(`Release tag v${version} exists without registry publication; investigate before publishing.`);
    const releaseSha = run('git', ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/i.test(releaseSha)) throw new Error('Git did not identify the release source commit.');
    return { needsPublish: true, releaseSha, tagExists: false };
  }
  if (published?.version !== version || typeof published.gitHead !== 'string' || !/^[a-f0-9]{40}$/i.test(published.gitHead)) {
    throw new Error('Registry publication did not identify the expected version and source commit.');
  }
  if (tagSha !== undefined && tagSha !== published.gitHead) {
    throw new Error(`Release tag v${version} points at a different source commit from the registry publication.`);
  }
  return { needsPublish: false, releaseSha: published.gitHead, tagExists: tagSha !== undefined };
}

/**
 * @param {{
 *   version: string,
 *   run?: (command: string, args: string[]) => string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   sleep?: (delayMs: number) => Promise<void>
 * }} options
 * @returns {Promise<{needsPublish: false, releaseSha: string, tagExists: boolean}>}
 */
export async function waitForPublishedRelease({
  version,
  run = runCommand,
  timeoutMs = RELEASE_PUBLICATION_TIMEOUT_MS,
  pollMs = RELEASE_PUBLICATION_POLL_MS,
  sleep = sleepFor,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new Error('Release publication wait requires a non-negative integer timeout and a positive integer poll interval.');
  }
  let waitedMs = 0;
  while (true) {
    const state = readReleaseState({ version, run });
    if (!state.needsPublish) return state;
    if (waitedMs >= timeoutMs) {
      throw new Error(`specgit@${version} is not published after waiting ${timeoutMs}ms; refusing to create release metadata.`);
    }
    const delayMs = Math.min(pollMs, timeoutMs - waitedMs);
    await sleep(delayMs);
    waitedMs += delayMs;
  }
}

/**
 * Finalize release metadata after the registry exposes the just-published
 * package. The initial release-state probe remains a single read.
 * @param {{
 *   version: string,
 *   run?: (command: string, args: string[]) => string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   sleep?: (delayMs: number) => Promise<void>
 * }} options
 */
export async function finalizeRelease({
  version,
  run = runCommand,
  timeoutMs = RELEASE_PUBLICATION_TIMEOUT_MS,
  pollMs = RELEASE_PUBLICATION_POLL_MS,
  sleep = sleepFor,
}) {
  const state = await waitForPublishedRelease({ version, run, timeoutMs, pollMs, sleep });
  const tag = `v${version}`;
  if (!state.tagExists) {
    run('git', ['cat-file', '-e', `${state.releaseSha}^{commit}`]);
    run('git', ['tag', tag, state.releaseSha]);
    run('git', ['push', 'origin', `refs/tags/${tag}`]);
  }
  try {
    run('gh', ['release', 'view', tag]);
    return;
  } catch { /* Creation fails closed if the lookup failed for another reason. */ }
  run('gh', ['release', 'create', tag, '--verify-tag', '--generate-notes', '--title', tag,
    ...(version.includes('-') ? ['--prerelease'] : []),
    '--notes', `Automated release from merged changesets. npm: https://www.npmjs.com/package/specgit/v/${version}`]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const requestedVersion = process.env.SPECGIT_RELEASE_VERSION;
    if (process.argv.includes('--plan')) {
      const intent = process.env.SPECGIT_RELEASE_INTENT;
      if (intent !== 'true' && intent !== 'false') throw new Error('Classifier release intent must be a literal boolean.');
      const plan = planRelease({
        event: process.env.GITHUB_EVENT_NAME ?? '', version,
        releaseIntent: intent === 'true',
        pending: pendingChangesets(process.cwd()), requestedVersion,
      });
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required for the release plan.');
      appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${plan.eligible}\nversion=${plan.version}\npending=${plan.pending}\n`);
      console.log(plan.eligible ? `Release work requested for specgit@${version}.` : 'No release work requested by this change.');
    } else if (requestedVersion !== undefined && requestedVersion !== version) {
      throw new Error('The release plan version no longer matches package.json.');
    } else if (process.argv.includes('--finalize')) {
      await finalizeRelease({ version });
      console.log(`Release metadata for specgit@${version} is complete.`);
    } else {
      const state = readReleaseState({ version });
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required for the release state probe.');
      appendFileSync(process.env.GITHUB_OUTPUT, `needs_publish=${state.needsPublish}\nneeds_finalize=true\n`);
      console.log(`specgit@${version}: ${state.needsPublish ? 'publication needed' : 'published; reconcile tag and release'}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
