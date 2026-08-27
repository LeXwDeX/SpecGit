/**
 * The issue-tag contract (#330): a portable, dual-forge tag vocabulary
 * the delivery agent selects from, seeded from the repository's label
 * pool when the pool lacks it.
 *
 * The grammar is the compatibility boundary. GitHub and GitLab differ in
 * what a label title tolerates (GitHub's bulk flows split on commas;
 * GitLab's `::` is scoped-label syntax on Premium tiers and plain
 * characters on CE), so SpecGit standardizes on an ASCII subset that is
 * valid everywhere and degrades upward: lowercase kebab segments joined
 * by at most one `::` axis separator (`kind::feat`, `module::auth`). A
 * bare slug stays legal — an existing repository's plain labels (bug,
 * enhancement) are first-class selection candidates, never rewritten.
 * Selection never invents names; when a wanted label is missing, the
 * catalog seeds it (`ensureIssueLabels`), so the pool converges on the
 * spec without renaming anyone's history.
 *
 * This module is pure: no process, no network. The adapters own every
 * forge quirk; this file owns the grammar and the built-in catalog.
 */

/**
 * The delivery `<type>` vocabulary (single source of truth, #174): the
 * same list validates issue-title prefixes, names delivery branches,
 * and names the members of the seeded `kind::` axis below. The command
 * layer re-exports it (`ISSUE_TITLE_TYPES`) so validators and skill
 * text never drift from this list.
 */
export const DELIVERY_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'docs',
  'test',
  'chore',
  'style',
  'build',
  'ci',
  'revert',
  'security',
  'deprecate',
  'dogfood',
] as const;

/**
 * A single tag slug: one or two kebab segments joined by `::`.
 * Lowercase ASCII letters, digits, hyphens; no commas, spaces, colons
 * beyond the one axis separator; 64 characters total.
 */
export const TAG_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:::[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export const TAG_GRAMMAR_FIX =
  'Use a lowercase ASCII slug of up to two kebab-case segments joined by "::" ' +
  '(e.g. kind::fix, module::auth) or a bare slug (e.g. bug). No commas, spaces, or uppercase.';

/** Total length cap (including the separator) that both forges tolerate. */
export const TAG_MAX_LENGTH = 64;

export function isTagSlug(value: string): boolean {
  return value.length <= TAG_MAX_LENGTH && TAG_SLUG_REGEX.test(value);
}

/**
 * A tag as declared by the built-in catalog or a project policy:
 * the slug plus the seed color (six hex digits, no `#` — the form both
 * forge APIs take).
 */
export interface TagSpec {
  name: string;
  color: string;
}

/** A single stable hue per conventional type, so the seeded kind axis reads as a family. */
const KIND_COLORS: Record<string, string> = {
  feat: '0E8A16',
  fix: 'D93F0B',
  perf: '6F42C1',
  refactor: 'FBCA04',
  docs: '0075CA',
  test: '0E8A16',
  chore: 'C5DEF5',
  style: 'BFD4F2',
  build: 'D4C5F9',
  ci: 'D4C5F9',
  revert: 'F9D0C4',
  security: 'B60205',
  deprecate: 'FEF2C0',
  dogfood: 'C2E0C6',
};

/**
 * The built-in catalog: one `kind::` member per allowed `<type>` prefix,
 * same source list as the branch-name types (#174), so a delivery's
 * inferred tag always has a seed spec. Extra axes (module::, feature::,
 * ui::, …) are grammatical but never pre-seeded wholesale — their values
 * are project-specific vocabulary a policy declares.
 */
export const DEFAULT_TAG_CATALOG: readonly TagSpec[] = Object.freeze(
  DELIVERY_TYPES.map((type) => ({ name: `kind::${type}`, color: KIND_COLORS[type] ?? '5319E7' }))
);

/**
 * Pool reconciliation (#330): partition a repository's existing labels
 * into form-valid slugs (selection candidates) and off-spec leftovers.
 * Dirty labels are reported, never renamed or deleted — migrating
 * history is a human decision; the harness only refuses to build on it.
 */
export function classifyPool(names: string[]): { valid: string[]; dirty: string[] } {
  const valid: string[] = [];
  const dirty: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    if (isTagSlug(name)) {
      valid.push(name);
    } else {
      dirty.push(name);
    }
  }
  return { valid, dirty };
}

/**
 * How `--tags <slugs>` resolves against what exists. Everything a
 * command can report lives here; the CLI layer turns kinds into exit
 * codes and diagnostics.
 */
export type TagResolution =
  | { kind: 'ok'; tags: string[] }
  | { kind: 'invalid'; slugs: string[] }
  | { kind: 'unknown'; slugs: string[] };

/**
 * Resolve requested slugs against the pool ∪ catalog (#330 priority):
 * everything already correct in the pool wins outright; anything absent
 * must be named by the built-in catalog or an explicit `tags:` policy
 * declaration before it may be seeded. Duplicate requests collapse; bad
 * grammar and unknown vocabulary are refused with zero side effects.
 */
export function resolveTagSelection(
  requested: string[],
  available: Iterable<string>
): TagResolution {
  const known = new Set<string>(available);
  for (const spec of DEFAULT_TAG_CATALOG) {
    known.add(spec.name);
  }
  const tags: string[] = [];
  const invalid: string[] = [];
  const unknown: string[] = [];
  for (const raw of requested) {
    const name = raw.trim();
    if (name === '' || tags.includes(name)) continue;
    if (!isTagSlug(name)) {
      invalid.push(name);
      continue;
    }
    if (!known.has(name)) {
      unknown.push(name);
      continue;
    }
    tags.push(name);
  }
  if (invalid.length > 0) {
    return { kind: 'invalid', slugs: invalid };
  }
  if (unknown.length > 0) {
    return { kind: 'unknown', slugs: unknown };
  }
  return { kind: 'ok', tags };
}

/**
 * Seed specs for a resolved selection: only labels the pool actually
 * lacks. Existing names are applied as-is — selection is from the pool
 * first, creation second. `declared` carries the policy's own
 * vocabulary (`policy.yaml` `tags:`); a declared name with no color
 * takes a stable fallback assignment below.
 */
export function seedSpecsFor(tags: string[], poolNames: string[], declared: readonly TagSpec[] = []): TagSpec[] {
  const present = new Set(poolNames.map((name) => name.trim()));
  const byName = new Map<string, string>(
    [...DEFAULT_TAG_CATALOG, ...declared].map((spec) => [spec.name, spec.color])
  );
  const specs: TagSpec[] = [];
  for (const name of tags) {
    if (present.has(name)) continue;
    const color = byName.get(name);
    if (color === undefined) continue; // Never seed vocabulary nothing declares.
    specs.push({ name, color });
  }
  return specs;
}

/**
 * Stable fallback colors for seeded tags that declare none (#330):
 * deterministic from the slug itself, so the same name seeds to the
 * same hue on every machine without state.
 */
const FALLBACK_PALETTE = ['5319E7', '006B75', 'B60205', '1D76DB', 'C2E0C6', 'FBCA04'] as const;

export function fallbackColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}
