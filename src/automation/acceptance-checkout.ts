import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalGitAdapter } from '../gitfacts/local.js';
import { readRecord } from '../record/io.js';
import { bindingContextMismatch } from '../record/context-match.js';

/** Reproduce worktree identity at the event head; ordinary gates still own acceptance. */
export async function withAcceptanceCheckout<T>(root: string, run: (checkout: string) => Promise<T>): Promise<T> {
  const record = await readRecord(root);
  if (!record.ok || record.value.context.kind !== 'worktree') return run(root);
  const context = record.value.context;
  const facts = await new LocalGitAdapter().facts(root);
  if (facts.branch !== context.branch || facts.dirty || !facts.headSha ||
      bindingContextMismatch(context, facts) === null) return run(root);
  const label = context.label;
  if (label === '.' || label === '..' || /[\\/:*?"<>|\p{Cc}]/u.test(label) || /[. ]$/.test(label) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(label)) throw new Error('Unsafe worktree label in delivery record.');
  const parent = mkdtempSync(join(tmpdir(), 'specgit-acceptance-'));
  const hooks = join(parent, 'hooks');
  const checkout = join(parent, 'checkout', label);
  mkdirSync(hooks); mkdirSync(join(parent, 'checkout'));
  const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${hooks}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  }).trim();
  let registered = false;
  try {
    git(root, ['worktree', 'add', '--detach', checkout, facts.headSha]);
    registered = true;
    // Only the new worktree's HEAD changes. The existing branch ref and original checkout stay intact.
    git(checkout, ['symbolic-ref', 'HEAD', `refs/heads/${context.branch}`]);
    if (git(checkout, ['rev-parse', 'HEAD']) !== facts.headSha) throw new Error('The event branch changed while preparing acceptance.');
    return await run(checkout);
  } finally {
    if (registered) git(root, ['worktree', 'remove', '--force', checkout]);
    rmSync(parent, { recursive: true, force: true });
  }
}

/** Internal workflow entry; delegates to the unchanged public verdict. */
export async function acceptFromCheckout(root = process.cwd()): Promise<number> {
  const { runMain } = await import('../cli/index.js');
  return withAcceptanceCheckout(root, async (checkout) => {
    const previous = process.cwd();
    try {
      process.chdir(checkout);
      return await runMain([process.execPath, 'specgit', 'finish', '--json']);
    } finally { process.chdir(previous); }
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acceptFromCheckout().then((code) => { process.exitCode = code; }).catch(() => {
    console.error('Acceptance checkout preparation failed; restore the declared context and retry.');
    process.exitCode = 3;
  });
}
