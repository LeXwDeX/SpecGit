/**
 * Production wiring for the `specgit` CLI — the composition root that
 * connects the CLI layer to the domain modules exactly as designed:
 *
 * - record IO and root discovery   → `src/record/**`
 * - local git facts                → `src/gitfacts/**` (LocalGitAdapter,
 *                                    parseRepoRef)
 * - forge evidence                 → `src/providers/**`: one routing
 *                                    provider (#117) dispatching per call
 *                                    to the gh adapter (GitHub refs) or
 *                                    the glab adapter (refs resolved
 *                                    through the GitLab declaration)
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
import { GhCliGitHubProvider } from '../providers/github/gh-cli.js';
import { GlabProvider } from '../providers/gitlab/glab-cli.js';
import { PlatformRoutingProvider } from '../providers/routing.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import * as recordIo from '../record/io.js';
import { readPolicy, readProviders } from '../record/io.js';
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
  // every parseRepoRef / evaluate call site. The declaration grammar is
  // `host` or `host:port` (#78): a declared non-default port classifies
  // only origins that use exactly that port.
  const declaredGitlabHost = async (): Promise<string | undefined> => {
    try {
      const rootEv = await discoverRepoRoot(process.cwd());
      if (!rootEv.ok) return undefined;
      const providers = await readProviders(rootEv.value);
      if (!providers.ok || providers.value.gitlab === undefined) return undefined;
      const { host, port } = providers.value.gitlab;
      return port !== undefined ? `${host}:${port}` : host;
    } catch {
      return undefined;
    }
  };

  // The policy's required_checks (#116): the glab adapter's verified
  // pipeline-gate intersection reads the policy names, so the delegate is
  // constructed with them. Without a readable policy there is nothing to
  // verify — the adapter reports `[]` and never fabricates an intersection.
  const policyRequiredChecks = async (): Promise<string[] | undefined> => {
    try {
      const rootEv = await discoverRepoRoot(process.cwd());
      if (!rootEv.ok) return undefined;
      const policy = await readPolicy(rootEv.value);
      return policy.ok ? policy.value.required_checks : undefined;
    } catch {
      return undefined;
    }
  };

  const routingProvider = new PlatformRoutingProvider({
    github: gh,
    gitlab: async () =>
      new GlabProvider({
        hostname: await declaredGitlabHost(),
        requiredChecks: await policyRequiredChecks(),
      }),
    originPlatform: async () => {
      const gitlabHost = await declaredGitlabHost();
      if (gitlabHost === undefined) return 'github';
      try {
        const rootEv = await discoverRepoRoot(process.cwd());
        if (!rootEv.ok) return 'undecided';
        const facts = await git.facts(rootEv.value);
        if (facts.originUrl === null) return 'undecided';
        const parsed = parseRepoRef(facts.originUrl, { gitlabHost });
        if (!parsed.ok) return 'undecided';
        return parsed.value.platform === 'gitlab' ? 'gitlab' : 'github';
      } catch {
        return 'undecided';
      }
    },
  });

  const parseRepoRefWithProviders = async (originUrl: string) =>
    // #117: the parse result carries the platform marker; commands hand
    // repo refs to the (routing) provider, which dispatches per marker —
    // a GitLab-declared origin reaches glab, never the gh adapter.
    parseRepoRef(originUrl, { gitlabHost: await declaredGitlabHost() });

  return {
    io: consoleIO(),
    version,
    cwd: process.cwd(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    discoverRoot: discoverRepoRoot,
    probeGitBinary,
    git,
    gh: routingProvider,
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
