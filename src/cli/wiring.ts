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
import type { GitlabCompletionIdentity } from '../providers/gitlab/completion-context.js';
import { PlatformRoutingProvider } from '../providers/routing.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import * as recordIo from '../record/io.js';
import { readPolicy, readProviders } from '../record/io.js';
import { discoverRepoRoot } from '../record/root.js';
import { resolveEffectivePolicy } from '../record/effective-policy.js';
import type { CommandContext, RecordPort } from './types.js';

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

/**
 * Optional seams over the production wiring, used by tests to observe
 * composition-root behavior (e.g. a counting discover stub, #184). Every
 * field defaults to the real production implementation, so
 * `createDefaultContext()` with no argument is exactly the shipped CLI.
 */
export interface WiringOverrides {
  /** Present only in the trusted remote runner; the provider authenticates every hint. */
  gitlabCompletion?: GitlabCompletionIdentity;
  /** Repo-root discovery; defaults to real `git rev-parse --show-toplevel`. */
  discoverRoot?: (cwd: string) => Promise<Evidence<string>>;
  /** A trusted workflow may evaluate an immutable PR-head binding while reading merged git history. */
  record?: RecordPort;
}

export function createDefaultContext(overrides: WiringOverrides = {}): CommandContext {
  const recordApi = overrides.record ?? recordIo;
  let version = '0.0.0';
  try {
    version = readPackageJson().version;
  } catch {
    // A broken package.json must never take the CLI down; the envelope then
    // simply reports a fallback version.
  }

  const git = new LocalGitAdapter();
  const gh = new GhCliGitHubProvider();

  // #184: the repo root has exactly one answer per command run, so resolve
  // it once per cwd and inject the cached value into every consumer
  // (providers declaration, policy, platform routing, record IO). The
  // cache removes both the repeated work and the theoretical TOCTOU where
  // mid-run filesystem changes could let two call sites see two roots.
  const discoverRoot = overrides.discoverRoot ?? discoverRepoRoot;
  const rootCache = new Map<string, Promise<Evidence<string>>>();
  const resolveRoot = (cwd: string): Promise<Evidence<string>> => {
    let pending = rootCache.get(cwd);
    if (pending === undefined) {
      pending = discoverRoot(cwd);
      rootCache.set(cwd, pending);
    }
    return pending;
  };

  // Policy and providers are likewise read at most once per resolved root
  // per command; the same file never hits disk twice in one run.
  const providersCache = new Map<string, Promise<Awaited<ReturnType<typeof readProviders>>>>();
  const providersFor = (root: string) => {
    let pending = providersCache.get(root);
    if (pending === undefined) {
      pending = readProviders(root);
      providersCache.set(root, pending);
    }
    return pending;
  };
  const policyCache = new Map<string, Promise<Awaited<ReturnType<typeof readPolicy>>>>();
  const policyFor = (root: string) => {
    let pending = policyCache.get(root);
    if (pending === undefined) {
      pending = readPolicy(root);
      policyCache.set(root, pending);
    }
    return pending;
  };

  // Provider declarations (spec_git/providers.yaml) decide how non-github
  // origins classify; resolved once per command context and threaded into
  // every parseRepoRef / evaluate call site. The declaration grammar is
  // `host` or `host:port` (#78): a declared non-default port classifies
  // only origins that use exactly that port.
  let gitlabHostPromise: Promise<string | undefined> | undefined;
  const declaredGitlabHost = (): Promise<string | undefined> =>
    (gitlabHostPromise ??= (async () => {
      try {
        const rootEv = await resolveRoot(process.cwd());
        if (!rootEv.ok) return undefined;
        const providers = await providersFor(rootEv.value);
        if (!providers.ok || providers.value.gitlab === undefined) return undefined;
        const { host, port } = providers.value.gitlab;
        return port !== undefined ? `${host}:${port}` : host;
      } catch {
        return undefined;
      }
    })());

  // The policy's required_checks (#116): the glab adapter's verified
  // pipeline-gate intersection reads the policy names, so the delegate is
  // constructed with them. Without a readable policy there is nothing to
  // verify — the adapter reports `[]` and never fabricates an intersection.
  let requiredChecksPromise: Promise<string[] | undefined> | undefined;
  const policyRequiredChecks = (): Promise<string[] | undefined> =>
    (requiredChecksPromise ??= (async () => {
      try {
        const rootEv = await resolveRoot(process.cwd());
        if (!rootEv.ok) return undefined;
        const record = await recordApi.readRecord(rootEv.value);
        const policy = await resolveEffectivePolicy({
          root: rootEv.value, record, git,
          forge: { getPr: async (repo, pr) => repo.platform === 'gitlab'
            ? new GlabProvider({ hostname: await declaredGitlabHost() }).getPr(repo, pr)
            : gh.getPr(repo, pr) },
          parseRepoRef: async (origin) => parseRepoRef(origin, { gitlabHost: await declaredGitlabHost() }),
          readCandidate: () => policyFor(rootEv.value),
        });
        return policy.ok ? policy.value.policy.required_checks : undefined;
      } catch {
        return undefined;
      }
    })());

  const routingProvider = new PlatformRoutingProvider({
    github: gh,
    gitlab: async () =>
      new GlabProvider({
        hostname: await declaredGitlabHost(),
        requiredChecks: await policyRequiredChecks(),
        completion: overrides.gitlabCompletion,
      }),
    originPlatform: async () => {
      const gitlabHost = await declaredGitlabHost();
      if (gitlabHost === undefined) return 'github';
      try {
        const rootEv = await resolveRoot(process.cwd());
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
    discoverRoot: resolveRoot,
    probeGitBinary,
    git,
    gh: routingProvider,
    record: recordApi,
    resolvePolicy: (root, record, options) => resolveEffectivePolicy({ root, record, git, forge: routingProvider,
      parseRepoRef: parseRepoRefWithProviders, readCandidate: () => recordApi.readPolicy(root), ...options }),
    evaluate: (async (input: Parameters<typeof evaluate>[0]) =>
      evaluate(
        input.gitlabHost === undefined
          ? { ...input, gitlabHost: await declaredGitlabHost() }
          : input
      )) as typeof evaluate,
    parseRepoRef: parseRepoRefWithProviders as CommandContext['parseRepoRef'],
    withGitlabHost: (gitlabHost) => ({
      parseRepoRef: (originUrl) => parseRepoRef(originUrl, { gitlabHost }),
      gh: new PlatformRoutingProvider({
        github: gh,
        gitlab: async () => new GlabProvider({
          hostname: gitlabHost,
          requiredChecks: await policyRequiredChecks(),
        }),
        originPlatform: async () => 'gitlab',
      }),
    }),
  };
}
