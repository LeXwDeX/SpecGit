/**
 * Read-modify-write transform for classic branch protection (#62).
 *
 * `specgit init --protect` must never weaken existing governance: the PUT
 * body sent to `repos/{owner}/{repo}/branches/{branch}/protection` is
 * derived from the GET payload (enriched with ids/urls GitHub would reject
 * on write) and translated back to the slugs the PUT endpoint accepts,
 * preserving required checks, reviews, dismissal restrictions, push
 * restrictions, admin enforcement, and the boolean rule dimensions. The
 * only addition is the SpecGit Acceptance check.
 */

export interface BranchProtectionUpdateBody {
  [key: string]: unknown;
  required_status_checks: { strict: boolean; contexts: string[] };
  enforce_admins: boolean;
  required_pull_request_reviews: unknown;
  restrictions: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GET renders rule dimensions as `{ enabled: bool }`; PUT takes the bool. */
function enabledOf(value: unknown): boolean | undefined {
  if (!isPlainObject(value)) return undefined;
  const enabled = value.enabled;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

/**
 * GET actor lists carry enriched objects; PUT accepts logins/slugs. Strings
 * pass through (some proxies already return slugs).
 */
function actorSlugs(list: unknown, key: 'login' | 'slug'): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((actor) => {
      if (typeof actor === 'string') return actor;
      if (isPlainObject(actor) && typeof actor[key] === 'string') return actor[key] as string;
      return null;
    })
    .filter((slug): slug is string => slug !== null);
}

/** Map a GET restrictions/dismissal_restrictions object to its PUT shape. */
function actorRestrictions(value: unknown): Record<string, string[]> | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return {};
  const mapped: Record<string, string[]> = {};
  if (Array.isArray(value.users)) mapped.users = actorSlugs(value.users, 'login');
  if (Array.isArray(value.teams)) mapped.teams = actorSlugs(value.teams, 'slug');
  if (Array.isArray(value.apps)) mapped.apps = actorSlugs(value.apps, 'slug');
  return mapped;
}

function mapReviews(value: unknown): unknown {
  if (!isPlainObject(value)) return null;
  const mapped: Record<string, unknown> = {};
  for (const flag of [
    'dismiss_stale_reviews',
    'require_code_owner_reviews',
    'require_last_push_approval',
  ] as const) {
    if (typeof value[flag] === 'boolean') mapped[flag] = value[flag];
  }
  if (typeof value.required_approving_review_count === 'number') {
    mapped.required_approving_review_count = value.required_approving_review_count;
  }
  if (value.dismissal_restrictions !== undefined) {
    mapped.dismissal_restrictions = actorRestrictions(value.dismissal_restrictions);
  }
  return mapped;
}

/**
 * Build the PUT body that adds `requiredCheck` to `current` (the GET
 * protection payload, or null/anything unrecognizable for an unprotected
 * branch) without weakening any existing dimension.
 */
export function buildProtectionUpdateBody(
  current: unknown,
  requiredCheck: string
): BranchProtectionUpdateBody {
  const base = isPlainObject(current) ? current : {};

  const rsc = isPlainObject(base.required_status_checks) ? base.required_status_checks : null;
  const existingContexts = Array.isArray(rsc?.contexts)
    ? (rsc?.contexts as unknown[]).filter((name): name is string => typeof name === 'string')
    : [];
  const contexts = existingContexts.includes(requiredCheck)
    ? existingContexts
    : [...existingContexts, requiredCheck];
  const strict =
    typeof rsc?.strict === 'boolean'
      ? (rsc?.strict as boolean)
      : rsc?.enforcement_level === 'everyone';

  const reviews = base.required_pull_request_reviews;
  const restrictions = base.restrictions;

  const body: BranchProtectionUpdateBody = {
    required_status_checks: { strict, contexts },
    enforce_admins: enabledOf(base.enforce_admins) ?? false,
    required_pull_request_reviews: isPlainObject(reviews) || reviews === null ? (reviews === null ? null : mapReviews(reviews)) : null,
    restrictions: actorRestrictions(restrictions),
  };

  // Boolean rule dimensions the classic API reports as {enabled} objects.
  for (const dimension of [
    'required_linear_history',
    'allow_force_pushes',
    'allow_deletions',
    'required_conversation_resolution',
  ] as const) {
    const enabled = enabledOf(base[dimension]);
    if (enabled !== undefined) body[dimension] = enabled;
  }

  return body;
}
