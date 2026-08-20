/**
 * `specgit init` — creates `spec_git/policy.yaml` and generates the
 * delivery harness: the CI acceptance workflow, the opencode guard hooks,
 * and the managed prompt block in the agent instruction files. The
 * harness generation is idempotent and merges with existing hooks; the
 * policy itself is write-once and never overwritten.
 *
 * Non-destructive contract (#62): every check that can reject the run —
 * input validation, `--gitlab-host` validation, `policy_exists`, and a
 * root-writability preflight — happens BEFORE any filesystem or remote
 * mutation. A rejected init leaves the repository byte-identical. The
 * harness write itself is error-atomic (rolled back on failure). Remote
 * mutation (branch protection) happens last and only when explicitly
 * requested (`--protect` or an interactive confirmation).
 *
 * Workflow template selection (#63): the SpecGit repository itself
 * (root package name `specgit`) keeps the local-build template — the
 * anti-drift lock pins it byte-exactly to this repo's own workflow.
 * Every other (adopting) repository gets the portable external template:
 * it installs the published CLI at the exact running version, sets up
 * only Node, parameterizes the default branch, and never assumes the
 * adopting project's toolchain, lockfile, layout, or build.
 *
 * With no arguments, required-check names are auto-detected from
 * `.github/workflows/*.{yml,yaml}` (job `name:`, falling back to the job
 * id; the generated SpecGit Acceptance job is excluded to avoid
 * self-reference). When no CI exists at all, the policy names zero
 * checks (#63: a fallback name the harness cannot produce would deadlock
 * the wait step and make the verdict unsatisfiable) — the acceptance
 * job itself, enforced through branch protection, is then the gate.
 */

import * as fsConstants from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import {
  ACCEPTANCE_CHECK_NAME,
  legacyGitHooksDir,
  harnessWorkflowYaml,
  writeHarnessAssets,
  type HarnessWriteResult,
} from '../harness-assets.js';
import { externalAcceptanceWorkflowYaml } from '../external-harness.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import type { Diagnostic } from '../../kernel/diagnostics.js';
import { POLICY_FILENAME, SPEC_GIT_DIR, type CommandContext } from '../types.js';
import { detectInitInputs, type DetectionReport } from '../detect-checks.js';
import { extractOriginHost } from '../../gitfacts/origin.js';
import type { BranchProtectionFact } from '../../github/port.js';
import { readProviders, writeProviders } from '../../record/io.js';

export interface InitOptions {
  requiredCheck?: string[];
  force?: boolean;
  detect?: boolean;
  /** true (--protect): enable without asking; false (--no-protect): skip probing; undefined: ask on TTY. */
  protect?: boolean;
  /** Bare hostname of a self-hosted GitLab instance matching the origin host. */
  gitlabHost?: string;
  json?: boolean;
}

// #78 declaration grammar: `host` or `host:port` — the port names the
// non-default port origins on that host may use.
const DECLARED_ENDPOINT = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/;

interface PlatformOutcome {
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
interface OriginEndpoint {
  host: string;
  /** Explicit port digits, null when the origin carries none. */
  port: string | null;
  defaultPort: string;
}

function originEndpoint(originUrl: string): OriginEndpoint | null {
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
function endpointEffectivePort(endpoint: OriginEndpoint): string {
  return endpoint.port ?? endpoint.defaultPort;
}

/** True when the origin connects on its scheme default (portless-equivalent). */
function endpointUsesDefaultPort(endpoint: OriginEndpoint): boolean {
  return endpointEffectivePort(endpoint) === endpoint.defaultPort;
}

/** The root package name that marks the SpecGit repository itself. */
const SELF_PACKAGE_NAME = 'specgit';

/**
 * Template selection (#63): true only for the SpecGit repository itself,
 * identified by the root package name. Self-detection keeps this repo on
 * the local-build template (pinned byte-exactly by the anti-drift lock);
 * every other repository is an adopting repo and gets the portable
 * external template.
 */
async function isSelfRepository(root: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(root, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.name === SELF_PACKAGE_NAME;
  } catch {
    // Missing, unreadable, or unparseable package.json: an adopting repo.
    return false;
  }
}

/**
 * Compute the acceptance-workflow bytes for this repository (validation
 * phase — a pure function of inputs, no writes). External inputs are the
 * adopting repo's remote default branch and the running CLI's exact
 * version; an unresolvable remote falls back to `main` with a warning,
 * mirroring the branch fallback the protection guard already uses.
 */
async function selectWorkflowYaml(
  ctx: CommandContext,
  root: string
): Promise<{ yaml: string; template: 'self' | 'external'; warning?: Diagnostic }> {
  if (await isSelfRepository(root)) {
    return { yaml: harnessWorkflowYaml(), template: 'self' };
  }
  const branchEv = await ctx.git.remoteDefaultBranch(root);
  let warning: Diagnostic | undefined;
  let defaultBranch = 'main';
  if (branchEv.ok) {
    defaultBranch = branchEv.value;
  } else {
    warning = {
      severity: 'warning',
      code: 'default_branch_unresolved',
      message: `The remote default branch could not be resolved (${branchEv.message}).`,
      fix: 'Fetch the remote (git fetch) and set origin/HEAD, then re-run init --force to re-pin the branch.',
    };
  }
  return {
    yaml: externalAcceptanceWorkflowYaml({ defaultBranch, version: ctx.version }),
    template: 'external',
    ...(warning !== undefined ? { warning } : {}),
  };
}

/**
 * Validate an explicit --gitlab-host declaration WITHOUT writing
 * (#62: validation precedes every mutation). Returns a CommandOutcome on
 * usage error, or the normalized declaration (host plus optional port)
 * to persist later. The declaration must match the origin endpoint:
 * same host, and the declared port (or scheme default when portless)
 * must be the port the origin actually uses (#78).
 */
async function validateGitlabHost(
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
async function persistGitlabHost(
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

/** The declaration string for envelopes and human output: `host` or `host:port`. */
function declaredEndpointName(host: string, port: string | null): string {
  return port !== null ? `${host}:${port}` : host;
}

/**
 * Platform-mode selection: a github.com origin defaults to GitHub; any
 * other origin needs a declaration (TTY question or --gitlab-host). The
 * choice persists in spec_git/providers.yaml, team-shared. Evidence
 * providers are the official CLIs only — gh for GitHub, glab for GitLab.
 */
async function resolvePlatformMode(
  options: InitOptions,
  ctx: CommandContext,
  root: string,
  warnings: Diagnostic[]
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
    return { outcome: { mode: 'github' }, human: ['Platform: github (default from origin)'] };
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
      human: [`Platform: gitlab (${endpoint.host}) declared in ${SPEC_GIT_DIR}/providers.yaml`],
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
          `Platform: gitlab (${declaredEndpointName(endpoint.host, port)}) declared in ${SPEC_GIT_DIR}/providers.yaml`,
        ],
      };
    }
    return { outcome: { mode: 'github' }, human: ['Platform: github (user-selected)'] };
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

interface ProtectionOutcome {
  [key: string]: unknown;
  branch: string;
  protected: boolean;
  requiredChecks?: string[];
  automerge: boolean;
  action: 'protected' | 'already-protected' | 'warned' | 'unavailable';
  fix?: string;
}

/**
 * Non-weakening fix guidance (#62): the string printed for a human to act
 * on must not teach a command that clears reviews, push restrictions, or
 * admin enforcement. The settings-UI path preserves every existing rule
 * while adding the check; `specgit init --protect` (read-modify-write)
 * is the scripted equivalent.
 */
const PROTECT_FIX = (branch: string) =>
  `Require check "${ACCEPTANCE_CHECK_NAME}" on ${branch} without weakening existing rules: ` +
  'in the repository Settings → Branches, edit the existing protection and add status check ' +
  `"${ACCEPTANCE_CHECK_NAME}" (keep existing required checks, reviews, restrictions, and admin ` +
  'enforcement), then enable auto-merge under Settings → General. Scripts: `specgit init --force ' +
  '--protect` re-applies it read-modify-write.';

/**
 * Post-policy guardrail: the acceptance gate only binds when the default
 * branch requires the acceptance check — otherwise a direct push or merge
 * bypasses it. Probe, warn, and (confirmed or --protect) enable protection
 * plus repository auto-merge. Every failure is fail-open: protection is a
 * guardrail, never a reason init fails.
 */
async function guardAcceptanceBypass(
  options: InitOptions,
  ctx: CommandContext,
  root: string
): Promise<{ outcome?: ProtectionOutcome; human: string[] }> {
  const facts = await ctx.git.facts(root).catch(() => null);
  const originUrl = facts?.originUrl ?? null;
  if (!originUrl) {
    return { human: ['Warning: no origin remote — cannot probe branch protection.'] };
  }
  const repoEv = await ctx.parseRepoRef(originUrl);
  if (!repoEv.ok) {
    return { human: [`Warning: cannot resolve a GitHub repository from '${originUrl}' — protection not probed.`] };
  }
  const repo = repoEv.value;

  const branchEv = await ctx.git.remoteDefaultBranch(root);
  const branch = branchEv.ok ? branchEv.value : 'main';

  const protectionEv = await ctx.gh.getBranchProtection(repo, branch);
  if (!protectionEv.ok) {
    return {
      outcome: {
        branch,
        protected: false,
        automerge: false,
        action: 'unavailable',
        fix: protectionEv.message,
      },
      human: [`Warning: branch protection could not be probed (${protectionEv.message}).`],
    };
  }
  const protection: BranchProtectionFact = protectionEv.value;
  const required = protection.requiredChecks.includes(ACCEPTANCE_CHECK_NAME);

  const automergeEv = await ctx.gh.getRepoAutomerge(repo);
  if (!automergeEv.ok) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
        automerge: false,
        action: 'unavailable',
        fix: automergeEv.message,
      },
      human: [`Warning: repository auto-merge could not be probed (${automergeEv.message}).`],
    };
  }
  const automerge = automergeEv.value.enabled;

  if (required && automerge) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        requiredChecks: protection.requiredChecks,
        automerge,
        action: 'already-protected',
      },
      human: [],
    };
  }

  let confirmed = options.protect === true;
  if (!confirmed && ctx.stdinIsTTY) {
    const { confirm } = await import('@inquirer/prompts');
    confirmed = await confirm(
      {
        message: `Require "${ACCEPTANCE_CHECK_NAME}" on ${branch} and enable auto-merge (blocks bypassing the acceptance gate)?`,
        default: true,
      },
      { output: process.stderr }
    );
  }

  if (!confirmed) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
        automerge,
        action: 'warned',
        fix: PROTECT_FIX(branch),
      },
      human: [
        `Warning: ${branch} does not require "${ACCEPTANCE_CHECK_NAME}" — the acceptance gate can be bypassed by a direct push or merge.`,
      ],
    };
  }

  let final: BranchProtectionFact | null = required ? protection : null;
  let failed: string | null = null;
  if (!required) {
    const enableEv = await ctx.gh.enableBranchProtection(repo, branch, ACCEPTANCE_CHECK_NAME);
    if (enableEv.ok) {
      final = enableEv.value;
    } else {
      failed = enableEv.message;
    }
  }
  let automergeFinal = automerge;
  if (failed === null && !automerge) {
    const enableEv = await ctx.gh.enableRepoAutomerge(repo);
    if (enableEv.ok) {
      automergeFinal = enableEv.value.enabled;
    } else {
      failed = enableEv.message;
    }
  }

  if (failed !== null || final === null) {
    return {
      outcome: {
        branch,
        protected: protection.protected,
        ...(protection.requiredChecks.length > 0 ? { requiredChecks: protection.requiredChecks } : {}),
        automerge,
        action: 'unavailable',
        fix: failed ?? undefined,
      },
      human: [`Warning: enabling branch protection failed (${failed ?? 'unknown'}).`],
    };
  }

  return {
    outcome: {
      branch,
      protected: final.protected,
      requiredChecks: final.requiredChecks,
      automerge: automergeFinal,
      action: 'protected',
    },
    human: [
      `Branch protection: ${branch} now requires "${ACCEPTANCE_CHECK_NAME}"`,
      `Auto-merge: ${automergeFinal ? 'enabled' : 'already on'}`,
    ],
  };
}

export async function runInit(
  options: InitOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  let checks = (options.requiredCheck ?? []).map((value) => value.trim());
  let detected: DetectionReport | null = null;

  if (checks.length === 0) {
    if (options.detect === false) {
      // Strict legacy path: no detection, no prompt (non-interactive
      // contract) — the caller must be explicit.
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic(
            'required_check_required',
            'init requires at least one required check name.',
            { fix: 'Pass --required-check <name> (repeatable), or drop --no-detect to auto-detect.' }
          ),
        ],
      };
    }
    // Auto-detect from the repo's CI files (GitHub workflows, GitLab CI);
    // a repository with no CI at all names zero required checks (#63):
    // every fallback NAME is a name the generated harness can never
    // produce as a check-run, which would deadlock the wait step and
    // make the verdict unsatisfiable. The acceptance job itself — kept
    // out of the policy and enforced through branch protection — is the
    // gate for such repositories.
    const facts = await ctx.git.facts(ctx.cwd).catch(() => null);
    detected = await detectInitInputs(ctx.cwd, facts?.originUrl ?? null);
    checks = detected.requiredChecks;
  }

  const invalid = checks.find((value) => value.length === 0);
  if (invalid !== undefined) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'required_check_invalid',
          'Required check names must be non-empty.',
          { fix: 'Pass the exact check name as it appears in check-runs, e.g. --required-check build.' }
        ),
      ],
    };
  }

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  // ---- Validation phase (#62): every rejection below happens before any
  // filesystem or remote mutation, so a rejected init leaves the tree
  // byte-identical. ----

  // Validate the --gitlab-host declaration now; persist it only after the
  // policy_exists gate passes.
  let declaredEndpoint: { host: string; port: string | null } | null = null;
  if (options.gitlabHost !== undefined) {
    const declared = await validateGitlabHost(options, ctx, root);
    if ('exit' in declared) {
      return declared;
    }
    declaredEndpoint = declared;
  }

  // policy_exists is the write gate: with an existing policy init refuses
  // (zero writes, zero remote calls) unless --force explicitly rebuilds.
  const existingPolicy = await ctx.record.readPolicy(root);
  if (existingPolicy.ok && !options.force) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'policy_exists',
          `${SPEC_GIT_DIR}/${POLICY_FILENAME} already exists in this repository.`,
          { fix: `Edit ${SPEC_GIT_DIR}/${POLICY_FILENAME} directly, or re-run with --force to rebuild it (also refreshes the harness).` }
        ),
      ],
    };
  }
  if (!existingPolicy.ok && existingPolicy.code !== 'policy_missing') {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic(existingPolicy.code, existingPolicy.message, existingPolicy.fix ? { fix: existingPolicy.fix } : {}),
      ],
    };
  }

  // Writability preflight: fail usage before touching the tree rather
  // than discovering EACCES halfway through the harness write.
  try {
    await access(root, fsConstants.constants.W_OK);
  } catch {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'root_not_writable',
          `The repository root ${root} is not writable.`,
          { fix: 'Fix the directory permissions (or re-run from a writable checkout) and retry.' }
        ),
      ],
    };
  }

  // Workflow template selection (#63) closes the validation phase: it is
  // a pure computation over already-read inputs, so a bad combination
  // (e.g. a non-exact version pin) still rejects before any write.
  let selection: Awaited<ReturnType<typeof selectWorkflowYaml>>;
  try {
    selection = await selectWorkflowYaml(ctx, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_USAGE,
      errors: [errorDiagnostic('workflow_input_invalid', message)],
    };
  }

  // ---- Mutation phase: local writes first (error-atomic), remote last. ----

  const warnings: Diagnostic[] = [];
  if (selection.warning !== undefined) {
    warnings.push(selection.warning);
  }
  // Detection trust boundary (#121): workflows whose triggers include no
  // PR trigger can never report check runs on a PR head. Their jobs are
  // excluded from the policy; init warns so the exclusion is visible and
  // the fix names the legitimate repair paths.
  if (detected !== null && detected.nonPrWorkflows.length > 0) {
    warnings.push({
      severity: 'warning',
      code: 'checks_not_pr_visible',
      message:
        'These workflows never run on a pull request head, so their jobs cannot ' +
        `become required checks: ${detected.nonPrWorkflows.join(', ')}.`,
      fix:
        'Detected checks are suggestions until proven on a PR head. If a job does ' +
        'report on PR heads (e.g. through another workflow), name it explicitly with ' +
        '--required-check; after CI changes, re-run init --force to re-detect — ' +
        'correcting a policy that was wrong at birth is the required repair, not a ' +
        'weakening.',
    });
  }

  // The git hook goes where git actually runs hooks from: worktree and
  // core.hooksPath aware. When git cannot answer, fall back to the legacy
  // .git/hooks probe; when neither resolves, the git hook is skipped.
  const resolveHooksDir = async (repoRoot: string): Promise<string | null> => {
    const hooksEv = await ctx.git.hooksPath(repoRoot);
    if (hooksEv.ok) {
      return hooksEv.value;
    }
    return legacyGitHooksDir(repoRoot);
  };

  let harness: HarnessWriteResult;
  try {
    harness = await writeHarnessAssets(root, { resolveHooksDir, workflowYaml: selection.yaml });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('harness_write_failed', message)],
    };
  }
  for (const warning of harness.warnings) {
    warnings.push({ severity: 'warning', ...warning });
  }

  const policy = { version: 1 as const, required_checks: checks };
  try {
    await ctx.record.writePolicy(root, policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('policy_write_failed', message)],
    };
  }

  if (declaredEndpoint !== null) {
    await persistGitlabHost(declaredEndpoint.host, declaredEndpoint.port, root, warnings);
  }

  const platform = await resolvePlatformMode(options, ctx, root, warnings);

  let protection: ProtectionOutcome | undefined;
  let protectionHuman: string[] = [];
  if (options.protect !== false) {
    const guarded = await guardAcceptanceBypass(options, ctx, root);
    protection = guarded.outcome;
    protectionHuman = guarded.human;
  }

  return {
    exit: EXIT_SUCCESS,
    policy,
    harness: { template: selection.template },
    platform: platform.outcome,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(protection !== undefined ? { protection } : {}),
    ...(detected !== null
      ? {
          detected: {
            platform: detected.platform,
            sources: detected.sources,
            nonPrWorkflows: detected.nonPrWorkflows,
            clis: detected.clis,
            fallback: checks.length === 0,
          },
        }
      : {}),
    human: [
      `Created ${SPEC_GIT_DIR}/${POLICY_FILENAME}`,
      `Required checks (${checks.length}):`,
      ...checks.map((name) => `  - ${name}`),
      ...platform.human,
      ...(detected !== null
        ? [
            `Detected platform: ${detected.platform}`,
            ...detected.sources.map((s) => `  detected from ${s}`),
            ...detected.nonPrWorkflows.map(
              (s) => `  skipped, never runs on a PR head: ${s}`
            ),
          ]
        : []),
      `Created ${harness.workflow}`,
      ...harness.hooks.map((hookPath) => `Created ${hookPath}`),
      ...(harness.gitHook ? [`Installed git pre-push guard (${harness.gitHook})`] : []),
      ...harness.prompts.map((filename) => `Managed block refreshed in ${filename}`),
      ...protectionHuman,
    ],
  };
}
