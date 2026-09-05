/**
 * `specgit doctor` — environment probes, nothing more. Probes: git binary,
 * git repository, parseable supported origin, matching provider CLI present
 * and authenticated, policy present. Exit 0 when every probe passes; exit 3 otherwise
 * (fail-closed). One hygiene warning rides the envelope (#348): open
 * issues that carry the specgit scaffold signature but are bound to no
 * delivery — born outside the pipeline, so no closing reference will
 * ever fire for them.
 */

import { CODE_INFO, type SpecGitCode } from '../../acceptance/codes.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import { errorDiagnostic, humanBuilder, probeLine } from '../output.js';
import type { CommandContext, Diagnostic, RepoRef } from '../types.js';
import type { DoctorOutcome, ProbeResult } from '../output.js';

export interface DoctorOptions {
  json?: boolean;
}

// #166: probe failures surface the catalogue `fix` hint so the --json
// envelope carries a machine-readable remedy, not just a code. Codes the
// catalogue does not know (or that define no fix) yield undefined, which
// errorDiagnostic omits.
function fixFor(code: string | undefined): string | undefined {
  if (code === undefined) {
    return undefined;
  }
  return CODE_INFO[code as SpecGitCode]?.fix;
}

export async function runDoctor(
  _options: DoctorOptions,
  ctx: CommandContext
): Promise<DoctorOutcome> {
  const probes: ProbeResult[] = [];
  const warnings: Diagnostic[] = [];

  const gitProbe = await ctx.probeGitBinary();
  probes.push(
    gitProbe.ok
      ? { name: 'git', ok: true, detail: gitProbe.value }
      : { name: 'git', ok: false, code: gitProbe.code }
  );

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  probes.push(
    rootEv.ok
      ? { name: 'repo', ok: true, detail: rootEv.value }
      : { name: 'repo', ok: false, code: rootEv.code }
  );

  if (rootEv.ok) {
    const facts = await ctx.git.facts(rootEv.value);
    let repoRef: RepoRef | null = null;
    if (!facts.originUrl) {
      probes.push({ name: 'origin', ok: false, code: 'no_origin' });
    } else {
      const parsed = await ctx.parseRepoRef(facts.originUrl);
      if (parsed.ok) {
        repoRef = parsed.value;
        probes.push({
          name: 'origin',
          ok: true,
          detail: `${parsed.value.owner}/${parsed.value.repo}`,
        });
      } else {
        probes.push({ name: 'origin', ok: false, code: parsed.code });
      }
    }

    // #348 tracker hygiene: open issues carrying the specgit scaffold
    // signature but bound to no delivery were born outside the pipeline —
    // no closing reference will ever fire for them. A warning with a
    // mechanical fix (bind sweeps it into the next delivery's closing
    // refs), never an exit-code change: hygiene, not environment.
    if (repoRef !== null) {
      const strayEv = await strayIssues(rootEv.value, repoRef, ctx);
      if (strayEv !== null && strayEv.length > 0) {
        warnings.push({
          severity: 'warning',
          code: 'issue_stray',
          message: `Open issue(s) ${strayEv
            .map((n) => `#${n}`)
            .join(', ')} look like specgit-born deliveries outside any binding.`,
          fix: 'Sweep into the next delivery with "specgit bind --issue <n>", or close explicitly if the work shipped elsewhere.',
        });
      }
    }
  } else {
    probes.push({ name: 'origin', ok: false, code: rootEv.code });
  }

  // #117 (provider routing): the provider probes follow the delivery
  // platform — gh on a GitHub origin, glab on a GitLab-declared one (the
  // routing provider decides; the envelope keys stay stable). The
  // "present" split therefore knows both CLIs' missing codes.
  const preflight = await ctx.gh.preflight();
  if (preflight.ok) {
    probes.push({ name: 'gh_present', ok: true });
    probes.push({ name: 'gh_authenticated', ok: true });
  } else {
    const present = preflight.code !== 'gh_missing' && preflight.code !== 'glab_missing';
    probes.push(
      present
        ? { name: 'gh_present', ok: true }
        : { name: 'gh_present', ok: false, code: preflight.code }
    );
    probes.push({ name: 'gh_authenticated', ok: false, code: preflight.code });
  }

  if (rootEv.ok) {
    const policyEv = await ctx.record.readPolicy(rootEv.value);
    probes.push(
      policyEv.ok
        ? {
            name: 'policy',
            ok: true,
            detail: `${policyEv.value.required_checks.length} required check(s)`,
          }
        : { name: 'policy', ok: false, code: policyEv.code }
    );
  } else {
    probes.push({ name: 'policy', ok: false, code: rootEv.code });
  }

  const allOk = probes.every((probe) => probe.ok);
  const exit = allOk ? EXIT_SUCCESS : EXIT_UNKNOWN;
  const failing = probes.filter((probe) => !probe.ok);

  return {
    exit,
    probes,
    ...(warnings.length > 0 ? { warnings } : {}),
    errors: allOk
      ? undefined
      : failing.map((probe) =>
          errorDiagnostic(
            probe.code ?? 'probe_failed',
            `Probe '${probe.name}' failed${probe.code ? ` (${probe.code})` : ''}.`,
            { fix: fixFor(probe.code) }
          )
        ),
    human: humanBuilder([
      ...probes.map(probeLine),
      ...warnings.map((warning) => `  Warning: ${warning.code} — ${warning.message}`),
    ]).build(),
  };
}

/**
 * Numbers of open issues whose body carries the specgit issue-scaffold
 * signature (#348) and that no current record binds. The signature is the
 * deterministic acceptance line both language catalogs write — generator-
 * exclusive, so human-authored issues never match. Any probe failure
 * degrades to null: hygiene never masquerades as an environment fault.
 */
async function strayIssues(
  root: string,
  repo: RepoRef,
  ctx: CommandContext
): Promise<number[] | null> {
  const SIGNATURES = ['closes this issue;', '关闭本议题'];
  const recordEv = await ctx.record.readRecord(root);
  if (!recordEv.ok && recordEv.code !== 'record_missing') {
    return null;
  }
  let openEv;
  try {
    openEv = await ctx.gh.getOpenIssues(repo);
  } catch {
    return null;
  }
  if (!openEv.ok) {
    return null;
  }
  const bound = new Set(recordEv.ok ? recordEv.value.issues : []);
  return openEv.value
    .filter(
      (fact) =>
        !bound.has(fact.number) &&
        typeof fact.body === 'string' &&
        SIGNATURES.some((signature) => fact.body?.includes(signature))
    )
    .map((fact) => fact.number);
}
