import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import { fail, ok, type Evidence } from '../kernel/evidence.js';

const execFileAsync = promisify(execFile);

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Root discovery: SpecGit runs only inside a git repository, and the record
 * and policy live at `git rev-parse --show-toplevel`. No ancestor walk, no
 * global store. Worktree checkouts carry their own committed files, so the
 * rule holds per checkout.
 */
export async function discoverRepoRoot(cwd: string = process.cwd()): Promise<Evidence<string>> {
  try {
    await fs.promises.access(cwd);
  } catch {
    return fail(
      'not_a_git_repo',
      `The directory ${cwd} does not exist.`,
      'Run specgit from inside a git checkout.'
    );
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const toplevel = stdout.trim();
    if (!toplevel) {
      return fail(
        'not_a_git_repo',
        'git reported an empty repository root.',
        'Run specgit from inside a git checkout.'
      );
    }
    return ok(toplevel);
  } catch (error) {
    if (isSpawnNotFoundError(error)) {
      return fail(
        'git_unavailable',
        'The git executable could not be found on PATH.',
        'Install git or add it to PATH.'
      );
    }
    return fail(
      'not_a_git_repo',
      'Not inside a git repository.',
      'Run specgit from inside a git checkout.'
    );
  }
}
