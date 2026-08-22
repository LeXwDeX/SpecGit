import { formatRepoRef, parseRepoRef } from '../../gitfacts/origin.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 5 — origin: the origin remote must resolve to a repository ref.
 * Publishes the resolved ref and the repo evidence.
 */
export function originGate(ctx: GateContext): GateFailure[] {
  const { facts } = ctx;
  if (!facts || facts.originUrl === null) {
    return [makeFailure('no_origin')];
  }
  const parsed = parseRepoRef(
    facts.originUrl,
    ctx.input.gitlabHost !== undefined ? { gitlabHost: ctx.input.gitlabHost } : {}
  );
  if (!parsed.ok) {
    // 88-6 (origin gate folding): the origin gate reports the classification
    // that was actually made — a GitLab origin fails as
    // gitlab_unsupported (factual, exit 1), never folded into
    // origin_unresolvable with GitHub-pointing advice.
    return [makeFailure(parsed.code === 'gitlab_unsupported' ? 'gitlab_unsupported' : 'origin_unresolvable')];
  }
  // #117 (provider routing): the origin resolved through the
  // providers.yaml GitLab declaration (platform marker on the ref —
  // the substring heuristic never resolves one). The declaration
  // and the nested-group grammar are accepted; evaluation evidence
  // flows through the neutral provider input, which the production
  // composition routes to glab for platform-marked refs (the
  // closing gate below already parses per the platform dialect).
  ctx.repoRef = parsed.value;
  ctx.evidence.repo = formatRepoRef(parsed.value);
  return [];
}
