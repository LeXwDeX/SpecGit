import { parseClosingRefs } from '../../github/closing-refs.js';
import { CODE_INFO } from '../codes.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 10 — closing: the PR body closes every bound issue. The dialect
 * follows the origin's platform marker. On a clean pass the gate also
 * raises the stale-head warning when local HEAD is not the PR head.
 */
export function closingGate(ctx: GateContext): GateFailure[] {
  // #115 (grammar parameterization): the dialect follows the origin's
  // platform marker (#112) — a GitLab-declared origin parses closing
  // references with GitLab's default pattern, everything else with the
  // GitHub grammar. Gate vocabulary is unchanged either way.
  const dialect = ctx.repoRef!.platform === 'gitlab' ? 'gitlab' : 'github';
  const closed = parseClosingRefs(ctx.prFact!.body, dialect, {
    projectPath: `${ctx.repoRef!.owner}/${ctx.repoRef!.repo}`,
    host: dialect === 'gitlab' ? ctx.input.gitlabHost : 'github.com',
  });
  const missing = ctx.binding!.issues.filter((n) => !closed.has(n));
  if (missing.length > 0) {
    return [makeFailure('closing_refs_incomplete', { missing })];
  }

  const { facts, prFact } = ctx;
  if (
    facts !== null &&
    facts.headSha !== null &&
    prFact !== null &&
    prFact.headSha &&
    facts.headSha !== prFact.headSha
  ) {
    ctx.warnings.push({
      severity: 'warning',
      code: 'local_head_stale',
      message: CODE_INFO.local_head_stale.message,
      fix: CODE_INFO.local_head_stale.fix,
    });
  }
  return [];
}
