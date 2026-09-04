/**
 * Platform resolution for `specgit init`: origin endpoint parsing (#78),
 * `--gitlab-host` declaration validation and persistence (#117), and the
 * platform-mode selection that decides which harness the repository gets.
 * Evidence providers are the official CLIs only — gh for GitHub, glab for
 * GitLab.
 */

import { EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, humanBuilder, type InitOutcome } from '../output.js';
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
 * (#62: validation precedes every mutation). Returns an InitOutcome on
 * usage error, or the normalized declaration (host plus optional port)
 * to persist later. The declaration must match the origin endpoint:
 * same host, and the declared port (or scheme default when portless)
 * must be the port the origin actually uses (#78).
 */
export async function validateGitlabHost(
  options: InitOptions,
  ctx: CommandContext,
  root: string
): Promise<InitOutcome | { host: string; port: string | null }> {
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
    if (origin.host === 'github.com' && endpointUsesDefaultPort(origin)) {
      return {
        exit: EXIT_USAGE,
        errors: [errorDiagnostic('gitlab_host_invalid',
          'The origin is already a github.com repository; declaring a GitLab host makes no sense.',
          { fix: 'Drop --gitlab-host: github.com origins are GitHub by default.' })],
      };
    }
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

/** `providers_invalid` is a refusal, not a mode: see `classifyPlatformMode`. */
export type PlatformClassification = 'github' | 'gitlab' | 'undecided' | 'providers_invalid';

/**
 * Read-only platform classification (#308): the same evidence order
 * `resolvePlatformMode` acts on — the persisted declaration first, then
 * origin-endpoint heuristics — with every mutating branch removed. No
 * providers write, no TTY question, no prompts: `specgit status` uses this
 * to decide which workflow the repository's platform desires without ever
 * touching `spec_git/providers.yaml`. A non-default-port origin (the #78
 * rule) and an unresolvable origin both stay `undecided` — an explicit
 * declaration is the only classification there, and status makes no claim
 * without one.
 *
 * Fail-closed on the declaration itself (#308 Delta 2): `providers_invalid`
 * is a refusal, not a mode — the authoritative platform declaration exists
 * but its bytes are invalid, so the platform is UNKNOWN. A github.com
 * origin must never be classified GitHub over bytes that may carry a valid
 * GitLab declaration. `providers_missing` (the file is optional) and a
 * valid file without a gitlab entry still fall through to the heuristics,
 * exactly like the writer; a read error that THROWS propagates to the
 * caller's inspection catch (`asset_inspection_failed`), never a guess.
 */
export async function classifyPlatformMode(
  root: string,
  originUrl: string | null
): Promise<PlatformClassification> {
  const existing = await readProviders(root);
  if (existing.ok) {
    if (existing.value.gitlab !== undefined) {
      return 'gitlab';
    }
    // A readable, valid declaration without a gitlab entry declares
    // nothing: the origin heuristics speak, same as the writer.
  } else if (existing.code === 'providers_invalid') {
    return 'providers_invalid';
  }
  // providers_missing: the file is optional, the heuristics classify.
  if (!originUrl) {
    return 'undecided';
  }
  const endpoint = originEndpoint(originUrl);
  if (endpoint === null || !endpointUsesDefaultPort(endpoint)) {
    return 'undecided';
  }
  if (endpoint.host === 'github.com') {
    return 'github';
  }
  if (/(^|\.)gitlab/i.test(endpoint.host)) {
    // gitlab.com or a *gitlab* self-host on the default port: evident
    // without a declaration — the same heuristic the writer persists.
    return 'gitlab';
  }
  return 'undecided';
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

  // #308 write/read symmetry: the read side (`classifyPlatformMode`)
  // refuses to classify over unreadable declaration bytes — so must the
  // writer. No heuristic classification, no providers write (a gitlab-
  // shaped host would otherwise SILENTLY OVERWRITE the broken bytes and
  // destroy the evidence the user needs to repair); the heuristics speak
  // again only after the bytes parse.
  if (!existing.ok && existing.code === 'providers_invalid') {
    warnings.push({
      severity: 'warning',
      code: 'platform_providers_invalid',
      message: `The platform declaration at ${SPEC_GIT_DIR}/providers.yaml exists but cannot be read: ${existing.message}`,
      fix: `Repair the ${SPEC_GIT_DIR}/providers.yaml bytes, then re-run specgit init.`,
    });
    return { outcome: { mode: 'undecided' }, human: humanBuilder().build() };
  }

  // The explicit flag already declared (or errored) before the policy
  // write; here the persisted declaration and heuristics speak.
  if (existingGitlab !== undefined) {
    return {
      outcome: {
        mode: 'gitlab',
        gitlabHost: declaredEndpointName(existingGitlab.host, existingGitlab.port ?? null),
      },
      human: humanBuilder().build(),
    };
  }

  if (!originUrl) {
    return { outcome: { mode: 'undecided' }, human: humanBuilder().build() };
  }
  const endpoint = originEndpoint(originUrl);
  // Port rule (#78): only the scheme default keeps a shape classifiable —
  // github.com on a non-default port is not a GitHub origin, and the
  // gitlab heuristics never capture non-default ports either; those
  // endpoints need an explicit host(:port) declaration.
  if (endpoint !== null && endpoint.host === 'github.com' && endpointUsesDefaultPort(endpoint)) {
    return {
      outcome: { mode: 'github' },
      human: humanBuilder().line(text.initPlatformGithubDefault()).build(),
    };
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
      human: humanBuilder()
        .line(text.initPlatformGitlab(endpoint.host, `${SPEC_GIT_DIR}/providers.yaml`))
        .build(),
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
        human: humanBuilder()
          .line(
            text.initPlatformGitlab(declaredEndpointName(endpoint.host, port), `${SPEC_GIT_DIR}/providers.yaml`)
          )
          .build(),
      };
    }
    return {
      outcome: { mode: 'github' },
      human: humanBuilder().line(text.initPlatformGithubUser()).build(),
    };
  }

  warnings.push({
    severity: 'warning',
    code: 'platform_undecided',
    message: `Origin endpoint "${
      endpoint === null ? 'unknown' : declaredEndpointName(endpoint.host, endpointUsesDefaultPort(endpoint) ? null : endpoint.port)
    }" is neither github.com nor a declared GitLab host.`,
    fix: 'Re-run init with --gitlab-host <hostname> (or <hostname>:<port> for a non-default port), or answer the platform question on an interactive terminal.',
  });
  return { outcome: { mode: 'undecided' }, human: humanBuilder().build() };
}
