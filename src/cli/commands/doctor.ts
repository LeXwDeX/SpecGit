/**
 * `specgit doctor` — environment probes, nothing more. Probes: git binary,
 * git repository, parseable GitHub origin, gh present, gh authenticated,
 * policy present. Exit 0 when every probe passes; exit 3 otherwise
 * (fail-closed).
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../exit-codes.js';
import { errorDiagnostic, type CommandOutcome, type ProbeResult } from '../output.js';
import type { CommandContext } from '../types.js';

export interface DoctorOptions {
  json?: boolean;
}

export async function runDoctor(
  _options: DoctorOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  const probes: ProbeResult[] = [];

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
    if (!facts.originUrl) {
      probes.push({ name: 'origin', ok: false, code: 'no_origin' });
    } else {
      const parsed = ctx.parseRepoRef(facts.originUrl);
      probes.push(
        parsed.ok
          ? { name: 'origin', ok: true, detail: `${parsed.value.owner}/${parsed.value.repo}` }
          : { name: 'origin', ok: false, code: parsed.code }
      );
    }
  } else {
    probes.push({ name: 'origin', ok: false, code: rootEv.code });
  }

  const preflight = await ctx.gh.preflight();
  if (preflight.ok) {
    probes.push({ name: 'gh_present', ok: true });
    probes.push({ name: 'gh_authenticated', ok: true });
  } else {
    const present = preflight.code !== 'gh_missing';
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
    errors: allOk
      ? undefined
      : failing.map((probe) =>
          errorDiagnostic(
            probe.code ?? 'probe_failed',
            `Probe '${probe.name}' failed${probe.code ? ` (${probe.code})` : ''}.`
          )
        ),
    human: probes.map((probe) =>
      probe.ok
        ? `ok    ${probe.name}${probe.detail ? ` — ${probe.detail}` : ''}`
        : `FAIL  ${probe.name}${probe.code ? ` (${probe.code})` : ''}`
    ),
  };
}
