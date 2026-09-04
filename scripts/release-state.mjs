import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} command @param {string[]} args */
const runCommand = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Read publication and tag evidence independently so retries can repair a
 * partial release. Registry gitHead anchors recovery after main advances.
 * @param {{version: string, run?: (command: string, args: string[]) => string}} options
 * @returns {{needsPublish: boolean, releaseSha: string, tagExists: boolean}}
 */
export function readReleaseState({ version, run = runCommand }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('A valid package version is required.');
  }
  let published;
  try {
    published = JSON.parse(run('npm', ['view', `specgit@${version}`, 'version', 'gitHead', '--json']));
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

/** @param {{version: string, run?: (command: string, args: string[]) => string}} options */
export function finalizeRelease({ version, run = runCommand }) {
  const state = readReleaseState({ version, run });
  if (state.needsPublish) throw new Error(`specgit@${version} is not published; refusing to create release metadata.`);
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
    if (process.argv.includes('--finalize')) {
      finalizeRelease({ version });
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
