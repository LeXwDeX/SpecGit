/**
 * Production wiring for the `specgit` CLI — the composition root that
 * connects the CLI layer to the domain modules exactly as designed:
 *
 * - record IO and root discovery   → `src/record/**`
 * - local git facts                → `src/gitfacts/**` (LocalGitAdapter,
 *                                    parseRepoRef)
 * - GitHub seam                    → `src/github/**` (GhCliGitHubProvider)
 * - acceptance evaluation          → `src/acceptance/**` (evaluate)
 *
 * `--help` and `--version` work without touching any of this beyond the
 * package version.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { evaluate } from '../acceptance/evaluate.js';
import { LocalGitAdapter } from '../gitfacts/local.js';
import { parseRepoRef } from '../gitfacts/origin.js';
import { GhCliGitHubProvider } from '../github/gh-cli.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import * as recordIo from '../record/io.js';
import { readProviders } from '../record/io.js';
import { discoverRepoRoot } from '../record/root.js';
import type { CommandContext } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const GIT_PROBE_TIMEOUT_MS = 15_000;

export function readPackageJson(): { name: string; version: string } {
  return require('../../package.json') as { name: string; version: string };
}

export function consoleIO(): CommandContext['io'] {
  return {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * Doctor probe: is the git binary present at all? Kept separate from root
 * discovery so `specgit doctor` can report the two failures distinctly.
 */
export async function probeGitBinary(): Promise<Evidence<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    return ok(stdout.trim());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return fail(
        'git_unavailable',
        'The git executable could not be found on PATH.',
        'Install git and ensure it is on PATH.'
      );
    }
    return fail('git_unavailable', 'git --version exited non-zero.');
  }
}

export function createDefaultContext(): CommandContext {
  let version = '0.0.0';
  try {
    version = readPackageJson().version;
  } catch {
    // A broken package.json must never take the CLI down; the envelope then
    // simply reports a fallback version.
  }

  const git = new LocalGitAdapter();
  const gh = new GhCliGitHubProvider();

  // Provider declarations (spec_git/providers.yaml) decide how non-github
  // origins classify; resolved once per command context and threaded into
  // every parseRepoRef / evaluate call site.
  const declaredGitlabHost = async (): Promise<string | undefined> => {
    try {
      const rootEv = await discoverRepoRoot(process.cwd());
      if (!rootEv.ok) return undefined;
      const providers = await readProviders(rootEv.value);
      return providers.ok ? providers.value.gitlab?.host : undefined;
    } catch {
      return undefined;
    }
  };
  const parseRepoRefWithProviders = async (originUrl: string) =>
    parseRepoRef(originUrl, { gitlabHost: await declaredGitlabHost() });

  return {
    io: consoleIO(),
    version,
    cwd: process.cwd(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    discoverRoot: discoverRepoRoot,
    probeGitBinary,
    git,
    gh,
    record: recordIo,
    evaluate: (async (input: Parameters<typeof evaluate>[0]) =>
      evaluate(
        input.gitlabHost === undefined
          ? { ...input, gitlabHost: await declaredGitlabHost() }
          : input
      )) as typeof evaluate,
    parseRepoRef: parseRepoRefWithProviders as CommandContext['parseRepoRef'],
  };
}
