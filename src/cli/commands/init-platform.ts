/**
 * Platform resolution for `specgit init`: origin endpoint parsing (#78),
 * `--gitlab-host` declaration validation and persistence (#117), and the
 * platform-mode selection that decides which harness the repository gets.
 * Evidence providers are the official CLIs only — gh for GitHub, glab for
 * GitLab.
 */

import { EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { HumanText } from '../language.js';
import { SPEC_GIT_DIR, type CommandContext } from '../types.js';
import { extractOriginHost } from '../../gitfacts/origin.js';
import { readProviders, writeProviders } from '../../record/io.js';
import type { InitOptions } from './init-validation.js';

// #78 declaration grammar: `host` or `host:port` — the port names the
// non-default port origins on that host may use.
export const DECLARED_ENDPOINT = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/;

export interface PlatformOutcome {
  [key: string]: unknown;
  mode: 'github' | 'gitlab' | 'undecided';
  gitlabHost?: string;
}

/**
 * Origin endpoint of the accepted URL shapes (https / scp / ssh),
 * structurally extracted (#78 + 88-2): the host never carries userinfo or
 * port digits, and the explicit port is captured separately so explicit-
 * port origins classify. `defaultPort` is the scheme default (443 https,
 * 22 ssh/scp); an origin whose effective port is the default behaves
 * exactly like the portless form.
 */
export interface OriginEndpoint {
  host: string;
  /** Explicit port digits, null when the origin carries none. */
  port: string | null;
  defaultPort: string;
}

export function originEndpoint(originUrl: string): OriginEndpoint | null {
  const parts = extractOriginHost(originUrl);
  if (parts === null) return null;
  // Only the shapes classification accepts: https, ssh, scp (scheme null).
  if (parts.scheme !== null && parts.scheme !== 'https' && parts.scheme !== 'ssh') {
    return null;
  }
  const defaultPort = parts.scheme === 'https' ? '443' : '22';
  return { host: parts.host, port: parts.port, defaultPort };
}

/** Effective port of an endpoint: explicit digits, else the scheme default. */
export function endpointEffectivePort(endpoint: OriginEndpoint): string {
  return endpoint.port ?? endpoint.defaultPort;
}

/** True when the origin connects on its scheme default (portless-equivalent). */
export function endpointUsesDefaultPort(endpoint: OriginEndpoint): boolean {
  return endpointEffectivePort(endpoint) === endpoint.defaultPort;
}

/** The declaration string for envelopes and human output: `host` or `host:port`. */
export function declaredEndpointName(host: string, port: string | null): string {
  return port !== null ? `${host}:${port}` : host;
}

/**
 * Validate an explicit --gitlab-host declaration WITHOUT writing
 * (#62: validation precedes every mutation). Returns a CommandOutcome on
 * usage error, or the normalized declaration (host plus optional port)
 * to persist later. The declaration must match the origin endpoint:
 * same host, and the declared port (or scheme default when portless)
 * must be the port the origin actually uses (#78).
 */
export async function validateGitlabHost(
  options: InitOptions,
  ctx: CommandContext,
  root: string
): Promise<CommandOutcome | { host: string; port: string | null }> {
  const raw = options.gitlabHost!.trim().toLowerCase();
  const facts = await ctx.git.facts(root).catch(() => null);
  const origin = facts?.originUrl ? originEndpoint(facts.originUrl) : null;
  const match = DECLARED_ENDPOINT.exec(raw);
  if (!match) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'gitlab_host_invalid',
          `"${raw}" is not a bare hostname or host:port declaration (no scheme, no path).`,
          {
            fix: 'Pass the host only, e.g. --gitlab-host git.ycgame.com, or host:port for a non-default port, e.g. --gitlab-host git.ycgame.com:8443.',
          }
        ),
      ],
    };
  }
  const host = match[1];
  const port = match[2] ?? null;
  if (origin !== null) {
    const declaredEffective = port ?? origin.defaultPort;
    const originEffective = endpointEffectivePort(origin);
    if (host !== origin.host || declaredEffective !== originEffective) {
      const originName = endpointUsesDefaultPort(origin)
        ? origin.host
        : `${origin.host}:${origin.port}`;
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(
            'gitlab_host_invalid',
            origin.host === 'github.com' && endpointUsesDefaultPort(origin)
              ? `The origin is already a github.com repository; declaring a GitLab host makes no sense.`
              : `The declared endpoint "${raw}" does not match the origin endpoint "${originName}".`,
            {
              fix:
                origin.host === 'github.com' && endpointUsesDefaultPort(origin)
                  ? 'Drop --gitlab-host: github.com origins are GitHub by default.'
                  : `Declare the origin's own endpoint: --gitlab-host ${originName}.`,
            }
          ),
        ],
      };
    }
  }
  return { host, port };
}

/** Persist an already-validated platform declaration (post-validation write). */
export async function persistGitlabHost(
  host: string,
  port: string | null,
  root: string,
  warnings: Diagnostic[]
): Promise<void> {
  try {
    await writeProviders(root, {
      gitlab: { host, ...(port !== null ? { port } : {}), insecure_ssl: false },
    });
  } catch {
    warnings.push({
      severity: 'warning',
      code: 'providers_write_failed',
      message: `Could not write ${SPEC_GIT_DIR}/providers.yaml.`,
    });
  }
}

/**
 * Platform-mode selection: a github.com origin defaults to GitHub; any
 * other origin needs a declaration (TTY question or --gitlab-host). The
 * choice persists in spec_git/providers.yaml, team-shared.
 */
export async function resolvePlatformMode(
  _options: InitOptions,
  ctx: CommandContext,
  root: string,
  warnings: Diagnostic[],
  text: HumanText
): Promise<{ outcome: PlatformOutcome; human: string[] }> {
  const facts = await ctx.git.facts(root).catch(() => null);
  const originUrl = facts?.originUrl ?? null;

  const existing = await readProviders(root);
  const existingGitlab = existing.ok ? existing.value.gitlab : undefined;

  // The explicit flag already declared (or errored) before the policy
  // write; here the persisted declaration and heuristics speak.
  if (existingGitlab !== undefined) {
    return {
      outcome: {
        mode: 'gitlab',
        gitlabHost: declaredEndpointName(existingGitlab.host, existingGitlab.port ?? null),
      },
      human: [],
    };
  }

  if (!originUrl) {
    return { outcome: { mode: 'undecided' }, human: [] };
  }
  const endpoint = originEndpoint(originUrl);
  // Port rule (#78): only the scheme default keeps a shape classifiable —
  // github.com on a non-default port is not a GitHub origin, and the
  // gitlab heuristics never capture non-default ports either; those
  // endpoints need an explicit host(:port) declaration.
  if (endpoint !== null && endpoint.host === 'github.com' && endpointUsesDefaultPort(endpoint)) {
    return { outcome: { mode: 'github' }, human: [text.initPlatformGithubDefault()] };
  }
  if (
    endpoint !== null &&
    endpointUsesDefaultPort(endpoint) &&
    /(^|\.)gitlab/i.test(endpoint.host)
  ) {
    // gitlab.com or a *gitlab* self-host on the default port: declarable
    // without asking (portless declaration — the default port needs none).
    try {
      await writeProviders(root, { gitlab: { host: endpoint.host, insecure_ssl: false } });
    } catch {
      // Non-fatal: the URL heuristic still classifies later commands.
    }
    return {
      outcome: { mode: 'gitlab', gitlabHost: endpoint.host },
      human: [text.initPlatformGitlab(endpoint.host, `${SPEC_GIT_DIR}/providers.yaml`)],
    };
  }

  // Non-github, non-obvious host: ask on a TTY; warn otherwise.
  if (ctx.stdinIsTTY && endpoint !== null) {
    const shown = declaredEndpointName(endpoint.host, endpointUsesDefaultPort(endpoint) ? null : endpoint.port);
    const { select } = await import('@inquirer/prompts');
    // Render to stderr: --json stdout must stay exactly one JSON document.
    const choice = await select(
      {
        message: `Origin endpoint "${shown}" is not github.com — which platform is this repository on?`,
        choices: [
          { value: 'gitlab' },
          { value: 'github' },
        ],
      },
      { output: process.stderr }
    );
    if (choice === 'gitlab') {
      // Persist the port when the origin uses a non-default one: the
      // declaration must name it for classification to match (#78).
      const port = endpointUsesDefaultPort(endpoint) ? null : endpoint.port;
      try {
        await writeProviders(root, {
          gitlab: { host: endpoint.host, ...(port !== null ? { port } : {}), insecure_ssl: false },
        });
      } catch {
        // Non-fatal.
      }
      return {
        outcome: { mode: 'gitlab', gitlabHost: declaredEndpointName(endpoint.host, port) },
        human: [
          text.initPlatformGitlab(declaredEndpointName(endpoint.host, port), `${SPEC_GIT_DIR}/providers.yaml`),
        ],
      };
    }
    return { outcome: { mode: 'github' }, human: [text.initPlatformGithubUser()] };
  }

  warnings.push({
    severity: 'warning',
    code: 'platform_undecided',
    message: `Origin endpoint "${
      endpoint === null ? 'unknown' : declaredEndpointName(endpoint.host, endpointUsesDefaultPort(endpoint) ? null : endpoint.port)
    }" is neither github.com nor a declared GitLab host.`,
    fix: 'Re-run init with --gitlab-host <hostname> (or <hostname>:<port> for a non-default port), or answer the platform question on an interactive terminal.',
  });
  return { outcome: { mode: 'undecided' }, human: [] };
}
