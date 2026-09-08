// Managed by SpecGit: acceptance checkout adapter.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reproduce worktree identity at the event head; ordinary gates still own acceptance. */
export async function withAcceptanceCheckout(root, run, { readRecord, git, bindingContextMismatch }) {
  const record = await readRecord(root);
  if (!record.ok || record.value.context.kind !== 'worktree') return run(root);
  const context = record.value.context;
  const facts = await git.facts(root);
  if (facts.branch !== context.branch || facts.dirty !== false || !facts.headSha ||
      bindingContextMismatch(context, facts) === null) return run(root);
  const label = context.label;
  if (label === '.' || label === '..' || /[\\/:*?"<>|\p{Cc}]/u.test(label) || /[. ]$/.test(label) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(label)) throw new Error('Unsafe worktree label in delivery record.');
  const parent = mkdtempSync(join(tmpdir(), 'specgit-acceptance-'));
  const hooks = join(parent, 'hooks');
  const checkout = join(parent, 'checkout', label);
  mkdirSync(hooks); mkdirSync(join(parent, 'checkout'));
  const gitCommand = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${hooks}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  }).trim();
  let registered = false;
  try {
    gitCommand(root, ['worktree', 'add', '--detach', checkout, facts.headSha]);
    registered = true;
    // Only the new worktree's HEAD changes. The existing branch ref and original checkout stay intact.
    gitCommand(checkout, ['symbolic-ref', 'HEAD', `refs/heads/${context.branch}`]);
    if (gitCommand(checkout, ['rev-parse', 'HEAD']) !== facts.headSha) throw new Error('The event branch changed while preparing acceptance.');
    return await run(checkout);
  } finally {
    if (registered) gitCommand(root, ['worktree', 'remove', '--force', checkout]);
    rmSync(parent, { recursive: true, force: true });
  }
}

/** Explicit CI preparation step; only a detached source-head checkout can create an event branch. */
export function prepareGitlabEventBranch(root = process.cwd(), env = process.env) {
  const branch = env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_BRANCH;
  const sha = env.CI_COMMIT_SHA;
  if (!branch || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha ?? '') ||
      (env.CI_MERGE_REQUEST_EVENT_TYPE && env.CI_MERGE_REQUEST_EVENT_TYPE !== 'detached')) {
    throw new Error('A GitLab source-branch pipeline and exact event SHA are required.');
  }
  const hooks = mkdtempSync(join(tmpdir(), 'specgit-event-hooks-'));
  const git = (args) => execFileSync('git', ['-C', root, '-c', `core.hooksPath=${hooks}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  }).trim();
  try {
    git(['check-ref-format', '--branch', branch]);
    if (git(['rev-parse', 'HEAD']) !== sha) throw new Error('The checkout differs from the GitLab event SHA.');
    const current = git(['branch', '--show-current']);
    if (current === branch) return;
    if (current !== '') throw new Error('The checkout belongs to a different branch.');
    git(['switch', '--create', branch]);
  } finally { rmSync(hooks, { recursive: true, force: true }); }
}

/** Run the installed public verdict with the same source and binding. */
export async function acceptanceMain() {
  try {
    const runtime = process.env.SPECGIT_ACCEPT_RUNTIME;
    if (!runtime || !isAbsolute(runtime)) throw new Error('An absolute installed SpecGit runtime path is required.');
    const load = (file) => import(pathToFileURL(join(runtime, file)).href);
    const [{ readRecord }, { LocalGitAdapter }, { bindingContextMismatch }] = await Promise.all([
      load('dist/record/io.js'), load('dist/gitfacts/local.js'), load('dist/record/context-match.js'),
    ]);
    process.exitCode = await withAcceptanceCheckout(process.cwd(), async (checkout) => {
      const result = spawnSync(process.execPath, [join(runtime, 'bin/specgit.js'), 'finish', '--json'], {
        cwd: checkout, stdio: 'inherit',
      });
      if (result.error || result.signal || result.status === null) throw new Error('The verdict process did not complete.');
      return result.status;
    }, { readRecord, git: new LocalGitAdapter(), bindingContextMismatch });
  } catch {
    console.error('Acceptance checkout preparation failed; restore the declared context and retry.');
    process.exitCode = 3;
  }
}
