/**
 * The delivery-tag apply step (#330): resolve the run's tag selection
 * against the repository's label pool, seed what the catalog or the
 * policy declares and the pool lacks, and apply the resolved slugs to
 * every bound issue.
 *
 * Priority contract (the one this module exists to enforce):
 *   1. The pool is the primary selection universe — a form-valid label
 *      already on the repository wins outright and is never duplicated
 *      under a second name.
 *   2. A missing label is seeded only from vocabulary that is
 *      *declared* — the built-in `kind::` catalog or `spec_git/policy.yaml`
 *      `tags:` — never invented at apply time. Off-spec pool leftovers
 *      are reported and left untouched; migrating history is a human
 *      decision.
 *
 * Two strictness modes share this flow:
 *  - explicit (`--tags <a,b>`): tagging is part of the command's job;
 *    every failure propagates fail-closed and unknown/invalid slugs are
 *    usage errors with zero side effects.
 *  - inferred (no flag): only the title-linked `kind::<type>` candidate,
 *    applied best-effort — a probe, seed, or apply failure degrades to
 *    a stderr warning so the quick bootstrap path keeps working in
 *    repositories without label permissions.
 *
 * Every remote call is idempotent by port contract, so re-runs converge:
 * seeding skips present names and applying unions into carried labels.
 */

import { EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, sanitize, type IssueOutcome } from '../output.js';
import { catalogFor } from '../../i18n/language.js';
import type { CommandContext, RepoRef } from '../types.js';
import type { PolicyLanguage } from '../../record/policy.js';
import {
  classifyPool,
  fallbackColorFor,
  isTagSlug,
  resolveTagSelection,
  seedSpecsFor,
  TAG_GRAMMAR_FIX,
} from '../../tags/catalog.js';
import type { TagSpec } from '../../tags/catalog.js';
import { passthrough } from './bootstrap.js';

/** How much of a long list shows before truncating for readability. */
const SAMPLE_LIMIT = 5;

export interface TaggingOutcome {
  status: 'applied' | 'degraded' | 'skipped';
  /**
   * Slugs applied this run: explicit mode puts every one on every bound
   * issue; inferred mode (#338) is the union of the per-issue slugs.
   */
  applied: string[];
  /** Slugs newly created in the repository during this run. */
  seeded: string[];
  /** Off-spec labels the pool carries (reported, untouched). */
  dirty: string[];
}

const SKIPPED: TaggingOutcome = { status: 'skipped', applied: [], seeded: [], dirty: [] };

function degraded(partial: Partial<TaggingOutcome> = {}): TaggingOutcome {
  return { status: 'degraded', applied: [], seeded: [], dirty: [], ...partial };
}

function sampleOf(names: string[]): string {
  const listed = names.slice(0, SAMPLE_LIMIT).map((name) => `'${sanitize(name)}'`);
  const rest = names.length - listed.length;
  return `${listed.join(', ')}${rest > 0 ? `, … (+${rest})` : ''}`;
}

function invalidTagsError(slugs: string[]): IssueOutcome {
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(
        'issue_tags_invalid',
        `--tags value(s) ${slugs.map((s) => `'${sanitize(s)}'`).join(', ')} ${slugs.length === 1 ? 'is' : 'are'} not valid tag slugs.`,
        {
          fix: `${TAG_GRAMMAR_FIX} Example: specgit issue "feat: add login" --tags kind::feat,module::auth.`,
        }
      ),
    ],
  };
}

function unknownTagsError(slugs: string[], available: string[]): IssueOutcome {
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(
        'issue_tags_unknown',
        `--tags value(s) ${slugs.map((s) => `'${sanitize(s)}'`).join(', ')} ${slugs.length === 1 ? 'is' : 'are'} unknown: not in the repository pool, the built-in kind:: catalog, or the policy declarations.`,
        {
          fix:
            'Use an existing pool label by its exact name, a kind::<type> member, or declare new vocabulary under tags: in spec_git/policy.yaml. ' +
            `Available now: ${sampleOf(available.map((n) => n)) || '(empty pool)'}.`,
        }
      ),
    ],
  };
}

/** The policy's own vocabulary (#330), fail-open like the presentation language. */
async function declaredTags(
  ctx: CommandContext,
  root: string,
  language: PolicyLanguage
): Promise<TagSpec[]> {
  const read = await ctx.record.readPolicy(root);
  if (!read.ok) {
    // A missing policy declares nothing (the normal case). An unreadable
    // one stays loud: silently shrinking the selection universe would be
    // a guess — the same discipline as a truncated evidence list.
    if (read.code !== 'policy_missing') {
      ctx.io.stderr(`  Warning: the policy could not be read (${read.code}); its tags vocabulary was ignored.`);
      void language;
    }
    return [];
  }
  return (read.value.tags ?? []).map((tag) => ({
    name: tag.name,
    color: tag.color ?? fallbackColorFor(tag.name),
  }));
}

function warnPoolUnreadable(ctx: CommandContext, language: PolicyLanguage): void {
  ctx.io.stderr(catalogFor(language).human.tagProbeWarning());
}

/**
 * The explicit-mode snapshot {@link validateExplicitTags} hands to
 * {@link applyDeliveryTags}: resolved tokens plus the exact probe state
 * they were resolved against, so the apply step probes once per run.
 */
export interface ResolvedTagSelection {
  tokens: string[];
  poolNames: string[];
  declared: TagSpec[];
}

/**
 * slugs and resolve them against the pool ∪ catalog ∪ policy BEFORE
 * `specgit issue` creates anything — a typo must never leave a created
 * issue behind. The pool probe here is a read; its result travels
 * forward so the apply step does not probe twice.
 *
 * Returns the failure to surface (exit 2), or the pre-resolved
 * selection snapshot for {@link applyDeliveryTags}.
 */
export async function validateExplicitTags(deps: {
  ctx: CommandContext;
  root: string;
  repo: RepoRef;
  language: PolicyLanguage;
  tokens: string[];
}): Promise<IssueOutcome | { pre: ResolvedTagSelection }> {
  const grammarBad = deps.tokens.filter((token) => !isTagSlug(token));
  if (grammarBad.length > 0) {
    return invalidTagsError(grammarBad);
  }

  const listEv = await deps.ctx.gh.listRepoLabels(deps.repo);
  if (!listEv.ok) {
    return passthrough(listEv);
  }

  const poolNames = listEv.value.names;
  const pool = classifyPool(poolNames);
  if (pool.dirty.length > 0) {
    deps.ctx.io.stderr(
      catalogFor(deps.language).human.tagPoolWarning(sampleOf(pool.dirty), pool.dirty.length)
    );
  }

  const declared = await declaredTags(deps.ctx, deps.root, deps.language);
  const resolution = resolveTagSelection(deps.tokens, [...pool.valid, ...declared.map((d) => d.name)]);
  if (resolution.kind === 'invalid') {
    return invalidTagsError(resolution.slugs);
  }
  if (resolution.kind === 'unknown') {
    return unknownTagsError(resolution.slugs, pool.valid);
  }

  return { pre: { tokens: resolution.tags, poolNames, declared } };
}

/**
 * Resolve, seed, and apply (#330) — the single entry issue.ts calls
 * after every bound issue is durable. Never throws command-level
 * failures: every refusal comes back as an IssueOutcome, every
 * tolerated failure as a degraded outcome whose stderr warnings were
 * already emitted here.
 *
 * `pre` carries the explicit-mode snapshot from
 * {@link validateExplicitTags}: the probe already ran before issue
 * creation, so this step reuses it verbatim (one probe per run) and
 * skips the duplicate dirty-pool warning.
 */
export async function applyDeliveryTags(deps: {
  ctx: CommandContext;
  root: string;
  repo: RepoRef;
  language: PolicyLanguage;
  /** Bound issue numbers after the creation loop (recorded state). */
  issues: number[];
  /** Raw `--tags` split: defined ⇔ explicit mode. */
  requested?: string[];
  /**
   * #338: the inferred-mode candidates, per issue — each bound issue's
   * OWN title kind. An issue absent from the map carries no kind and
   * never inherits another's. Absent map ⇔ nothing inferred.
   */
  inferredByIssue?: Map<number, string>;
  /** Explicit-mode pre-validation snapshot; absent ⇔ infer-and-probe here. */
  pre?: ResolvedTagSelection;
}): Promise<TaggingOutcome | IssueOutcome> {
  const { ctx, root, repo, language, issues } = deps;

  let tokens: string[];
  let explicit: boolean;
  let poolNames: string[] | null = null;
  let declared: TagSpec[] | null = null;
  if (deps.pre !== undefined) {
    explicit = true;
    tokens = deps.pre.tokens;
    poolNames = deps.pre.poolNames;
    declared = deps.pre.declared;
  } else {
    explicit = deps.requested !== undefined;
    if (deps.requested !== undefined) {
      tokens = [...deps.requested];
    } else {
      // The union of every bound issue's own inferred slug, in
      // first-bound order — the seed universe for this run.
      tokens = [];
      for (const issue of issues) {
        const slug = deps.inferredByIssue?.get(issue);
        if (slug !== undefined && !tokens.includes(slug)) {
          tokens.push(slug);
        }
      }
    }
  }

  if (issues.length === 0 || tokens.length === 0) {
    return SKIPPED;
  }

  if (poolNames === null || declared === null) {
    const listEv = await ctx.gh.listRepoLabels(repo);
    if (!listEv.ok) {
      if (explicit) {
        return passthrough(listEv);
      }
      warnPoolUnreadable(ctx, language);
      return degraded();
    }
    poolNames = listEv.value.names;
    declared = await declaredTags(ctx, root, language);

    const lateProbe = classifyPool(poolNames);
    if (lateProbe.dirty.length > 0) {
      ctx.io.stderr(
        catalogFor(language).human.tagPoolWarning(sampleOf(lateProbe.dirty), lateProbe.dirty.length)
      );
    }
  }

  const pool = classifyPool(poolNames);
  const resolution =
    deps.pre !== undefined
      ? { kind: 'ok' as const, tags: deps.pre.tokens }
      : resolveTagSelection(tokens, [...pool.valid, ...declared.map((d) => d.name)]);
  if (resolution.kind === 'invalid') {
    return invalidTagsError(resolution.slugs);
  }
  if (resolution.kind === 'unknown') {
    return unknownTagsError(resolution.slugs, pool.valid);
  }

  let seeded: string[] = [];
  const seeds = seedSpecsFor(resolution.tags, poolNames, declared);
  if (seeds.length > 0) {
    const ensureEv = await ctx.gh.ensureRepoLabels(repo, seeds);
    if (!ensureEv.ok) {
      if (explicit) {
        return passthrough(ensureEv);
      }
      warnPoolUnreadable(ctx, language);
      return degraded({ dirty: pool.dirty });
    }
    // The ensure fact confirms exactly the requested specs (port contract),
    // so every requested seed landed: created now, or already present.
    seeded = seeds.map((spec) => spec.name);
  }

  for (const issue of issues) {
    // #338: inferred mode applies each issue its OWN slug; an issue with
    // no inferred kind is left untouched — labels are additive by port
    // contract, so skipping is the faithful no-inheritance behaviour.
    const issueTags = explicit
      ? resolution.tags
      : (() => {
          const slug = deps.inferredByIssue?.get(issue);
          return slug !== undefined ? [slug] : [];
        })();
    if (issueTags.length === 0) {
      continue;
    }
    const applyEv = await ctx.gh.addIssueLabels(repo, issue, issueTags);
    if (!applyEv.ok) {
      if (explicit) {
        return passthrough(applyEv);
      }
      warnPoolUnreadable(ctx, language);
      return degraded({ dirty: pool.dirty, seeded });
    }
  }

  return { status: 'applied', applied: resolution.tags, seeded, dirty: pool.dirty };
}
