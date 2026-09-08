import { createHash } from 'node:crypto';
import { extractOriginHost } from '../../gitfacts/origin.js';
import { assessScope } from '../../scope/assess.js';
import { scopePath, verifyScopeHistory } from '../../scope/declaration.js';
import { errorDiagnostic, humanBuilder, sanitize, type ScopeOutcome } from '../output.js';
import type { CommandContext } from '../types.js';

/** Scope assessment selects its own approved evidence; it never reads the current delivery record. */
export async function runScope(name: string, ctx: CommandContext): Promise<ScopeOutcome> {
  const stop = (error: { code: string; message: string; fix?: string }, exit = 3): ScopeOutcome => ({
    exit, errors: [errorDiagnostic(error.code, error.message, error.fix ? { fix: error.fix } : {})],
  });
  const path = scopePath(name);
  if (!path.ok) return stop(path, 2);
  const root = await ctx.discoverRoot(ctx.cwd);
  if (!root.ok) return stop(root);
  const facts = await ctx.git.facts(root.value);
  if (!facts.originUrl) return stop({ code: 'no_origin', message: 'No origin remote is configured.' });
  const repo = await ctx.parseRepoRef(facts.originUrl);
  if (!repo.ok) return stop(repo);
  const branch = await ctx.git.remoteDefaultBranch(root.value, { requireEvidence: true });
  if (!branch.ok) return stop(branch);
  const file = await ctx.git.readFileAtRemoteRef(root.value, branch.value, path.value);
  if (!file.ok) return stop(file);
  if (file.value.content === null) return stop({ code: 'scope_unapproved', message: `Scope '${name}' is not approved on the remote default branch.`,
    fix: `Commit ${path.value} through a delivery and merge it into '${branch.value}', then retry.` });
  const history = await ctx.git.readFileHistory(root.value, file.value.sha, path.value);
  if (!history.ok) return stop(history);
  const latest = history.value.at(-1);
  if (latest?.sha !== file.value.sha || latest.content !== file.value.content) {
    return stop({ code: 'scope_history_unavailable', message: 'Scope history does not terminate at the pinned approved declaration.' });
  }
  const declaration = verifyScopeHistory(name, history.value.map((revision) => revision.content));
  if (!declaration.ok) return stop(declaration);
  const origin = extractOriginHost(facts.originUrl);
  const host = origin ? `${origin.host}${origin.port && !['443', '22'].includes(origin.port) ? `:${origin.port}` : ''}` : undefined;
  const assessment = await assessScope(declaration.value, { root: root.value, repo: repo.value, host, git: ctx.git, forge: ctx.gh });
  const current = await ctx.git.readFileAtRemoteRef(root.value, branch.value, path.value);
  if (!current.ok) return stop(current);
  if (current.value.sha !== file.value.sha || current.value.content !== file.value.content) {
    assessment.state = 'unknown';
    assessment.diagnostics.push({ code: 'scope_changed', message: 'The approved scope revision changed during assessment. Retry with fresh evidence.' });
  }
  const scope = { ...assessment, declaration: { path: path.value, branch: branch.value, sha: file.value.sha,
    hash: createHash('sha256').update(file.value.content).digest('hex'), history: history.value.map((revision) => revision.sha) } };
  const errors = [...assessment.diagnostics, ...assessment.members.flatMap((member) => member.diagnostics)]
    .map((error) => errorDiagnostic(error.code, error.message, error.fix ? { fix: error.fix } : {}));
  return { exit: assessment.state === 'completed' ? 0 : assessment.state === 'unknown' ? 3 : 1, scope,
    ...(errors.length ? { errors } : {}),
    human: humanBuilder().line(`Scope ${sanitize(name)}: ${assessment.state}`)
      .detail(`Parent #${scope.parent.issue}: ${scope.parent.state}`)
      .append(scope.members.map((member) => `  #${member.issue} -> ${sanitize(member.target)}: ${member.state}`)).build() };
}
