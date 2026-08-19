import { describe, expect, it } from 'vitest';

import { buildProtectionUpdateBody } from '../../src/github/protection-merge.js';

/**
 * A realistic classic-protection GET payload: enriched objects (urls, ids)
 * that the PUT endpoint would reject — the read-modify-write transform
 * must translate them back to slugs and preserve every dimension.
 */
const RICH_PROTECTION = {
  url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection',
  required_status_checks: {
    url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection/required_status_checks',
    enforcement_level: 'non_admins',
    contexts: ['build', 'Test (linux)'],
    checks: [{ context: 'build', app_id: 15368 }],
  },
  required_pull_request_reviews: {
    url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection/required_pull_request_reviews',
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    require_last_push_approval: false,
    required_approving_review_count: 2,
    dismissal_restrictions: {
      url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection/dismissal_restrictions',
      users_url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection/dismissal_restrictions/users',
      users: [{ login: 'alice', id: 1, type: 'User' }],
      teams: [{ id: 2, slug: 'core', permission: 'push' }],
    },
  },
  enforce_admins: {
    url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection/enforce_admins',
    enabled: true,
  },
  restrictions: {
    url: 'https://api.github.com/repos/LeXwDeX/SpecGit/branches/main/protection/restrictions',
    users_url: 'https://api.github.com/users',
    teams_url: 'https://api.github.com/teams',
    apps_url: 'https://api.github.com/apps',
    users: [{ login: 'bob', id: 3, type: 'User' }],
    teams: [{ id: 4, slug: 'devs', permission: 'push' }],
    apps: [{ id: 5, slug: 'deploy-bot', owner: { login: 'acme' } }],
  },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_conversation_resolution: { enabled: true },
};

describe('buildProtectionUpdateBody', () => {
  it('an unprotected branch yields the minimal additive body', () => {
    expect(buildProtectionUpdateBody(null, 'SpecGit Acceptance')).toEqual({
      required_status_checks: { strict: false, contexts: ['SpecGit Acceptance'] },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    });
  });

  it('a garbage payload is treated as unprotected, never as governance to copy', () => {
    expect(buildProtectionUpdateBody('nonsense', 'SpecGit Acceptance')).toEqual(
      buildProtectionUpdateBody(null, 'SpecGit Acceptance')
    );
  });

  it('preserves reviews, restrictions, admin enforcement, and rule booleans while adding the check', () => {
    const body = buildProtectionUpdateBody(RICH_PROTECTION, 'SpecGit Acceptance') as Record<string, any>;

    // Checks: union, existing order first, no duplicates.
    expect(body.required_status_checks).toEqual({
      strict: false,
      contexts: ['build', 'Test (linux)', 'SpecGit Acceptance'],
    });

    // Admin enforcement survives.
    expect(body.enforce_admins).toBe(true);

    // Reviews survive with enriched actor objects mapped back to slugs.
    expect(body.required_pull_request_reviews).toEqual({
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: false,
      required_approving_review_count: 2,
      dismissal_restrictions: { users: ['alice'], teams: ['core'] },
    });

    // Restrictions survive: users/teams/apps as logins and slugs.
    expect(body.restrictions).toEqual({
      users: ['bob'],
      teams: ['devs'],
      apps: ['deploy-bot'],
    });

    // Boolean rule dimensions survive as booleans.
    expect(body.required_linear_history).toBe(true);
    expect(body.allow_force_pushes).toBe(false);
    expect(body.allow_deletions).toBe(false);
    expect(body.required_conversation_resolution).toBe(true);
  });

  it('missing reviews and restrictions stay null (absent governance is preserved as absent)', () => {
    const body = buildProtectionUpdateBody(
      { required_status_checks: { enforcement_level: 'everyone', contexts: ['build'] } },
      'SpecGit Acceptance'
    ) as Record<string, any>;
    expect(body.required_pull_request_reviews).toBeNull();
    expect(body.restrictions).toBeNull();
    expect(body.enforce_admins).toBe(false);
    expect(body.required_status_checks).toEqual({
      strict: true,
      contexts: ['build', 'SpecGit Acceptance'],
    });
  });

  it('never duplicates a check that is already required', () => {
    const body = buildProtectionUpdateBody(
      { required_status_checks: { strict: true, contexts: ['SpecGit Acceptance'] } },
      'SpecGit Acceptance'
    ) as Record<string, any>;
    expect(body.required_status_checks.contexts).toEqual(['SpecGit Acceptance']);
    expect(body.required_status_checks.strict).toBe(true);
  });

  it('null dismissal restrictions and empty actor lists round-trip as-is', () => {
    const body = buildProtectionUpdateBody(
      {
        required_pull_request_reviews: {
          dismissal_restrictions: { users: [], teams: [] },
        },
        restrictions: { users: [], teams: [] },
      },
      'SpecGit Acceptance'
    ) as Record<string, any>;
    expect(body.required_pull_request_reviews.dismissal_restrictions).toEqual({
      users: [],
      teams: [],
    });
    expect(body.restrictions).toEqual({ users: [], teams: [] });
  });
});
