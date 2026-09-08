import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Evidence } from '../../src/kernel/evidence.js';
import type { RepoRef } from '../../src/gitfacts/origin.js';
import type { ForgeProvider } from '../../src/github/port.js';
import { GhCliGitHubProvider } from '../../src/providers/github/gh-cli.js';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { createFakeGh, type FakeGhRule } from './helpers/fake-gh.js';
import { createFakeGlab, type FakeGlabRule } from './helpers/fake-glab.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

/**
 * The behavioural forge contract (#275): provider-port-contract.test.ts
 * proves every in-tree adapter has the same *shape*; this suite proves
 * every adapter gives the same *answers* on the paths the verdict trusts.
 * The table below is written once against the port and runs against every
 * registration — adding a platform means adding one (adapter, fake) pair
 * to {@link REGISTRATIONS}; the contract is inherited, never restated.
 *
 * Two contract axes, mirroring the port's documented promises:
 *
 * - I3b list completeness (`src/github/port.ts`): `ok` means the list was
 *   gathered to exhaustion — a short page proves exhaustion and is `ok`;
 *   the page cap reached with a full page must fail `evidence_truncated`,
 *   never return a silently partial list.
 * - I3a fail-closed classification: a missing CLI, an unauthenticated
 *   session, and a transport failure each fail closed with the adapter's
 *   platform-prefixed code; single-entity lookups report the
 *   platform-neutral `issue_not_found` / `pr_not_found`.
 */

type ListMember = 'getOpenIssueNumbers' | 'getOpenIssues' | 'getCheckRuns';
type LookupMember = 'getIssue' | 'getPr';
type ReadMember = 'preflight' | LookupMember | ListMember;

const LIST_MEMBERS: readonly ListMember[] = [
  'getOpenIssueNumbers',
  'getOpenIssues',
  'getCheckRuns',
];

const READ_MEMBERS: readonly ReadMember[] = [
  'preflight',
  'getIssue',
  'getPr',
  ...LIST_MEMBERS,
];

const SHA = 'a'.repeat(40);
const STARTED_AT = '2026-08-20T14:00:00Z';

/** One port-level call per member — the table drives these, never adapter internals. */
const CALLS: Record<ReadMember, (provider: ForgeProvider, repo: RepoRef) => Promise<Evidence<unknown>>> = {
  preflight: (provider) => provider.preflight(),
  getIssue: (provider, repo) => provider.getIssue(repo, 7),
  getPr: (provider, repo) => provider.getPr(repo, 42),
  getOpenIssueNumbers: (provider, repo) => provider.getOpenIssueNumbers(repo),
  getOpenIssues: (provider, repo) => provider.getOpenIssues(repo),
  getCheckRuns: (provider, repo) => provider.getCheckRuns(repo, SHA),
};

type Scenario =
  | { kind: 'exhausted-list'; member: ListMember }
  | { kind: 'capped-full-page'; member: ListMember }
  | { kind: 'missing-cli'; member: ReadMember }
  | { kind: 'unauthenticated'; member: ReadMember }
  | { kind: 'transport-failure'; member: ReadMember }
  | { kind: 'not-found'; member: LookupMember };

/**
 * One (adapter, fake) pair. `build` wires a fresh provider whose fake
 * encodes exactly one scenario — the platform-specific endpoint shapes
 * and stderr markers live here, so the assertions below stay about the
 * port, not about gh or glab.
 */
interface BehaviourHarness {
  readonly name: string;
  readonly repo: RepoRef;
  readonly codes: {
    missing: string;
    unauthenticated: string;
    transport: string;
  };
  build(tempDir: string, scenario: Scenario): ForgeProvider;
}

// ---------------------------------------------------------------------
// gh registration
// ---------------------------------------------------------------------

const GH_REPO: RepoRef = { owner: 'LeXwDeX', repo: 'SpecGit', platform: 'github' };

function ghSearchPage(items: Array<{ number: number; title: string }>): string {
  return JSON.stringify({ incomplete_results: false, items });
}

function ghCheckRunPage(runs: Array<{ name: string; id: number }>): string {
  return JSON.stringify({
    check_runs: runs.map((run) => ({
      name: run.name,
      status: 'completed',
      conclusion: 'success',
      id: run.id,
      started_at: STARTED_AT,
    })),
  });
}

function ghRules(scenario: Scenario): FakeGhRule[] {
  switch (scenario.kind) {
    case 'exhausted-list':
      switch (scenario.member) {
        case 'getOpenIssueNumbers':
        case 'getOpenIssues':
          return [{ match: 'search/issues', stdout: ghSearchPage([{ number: 7, title: 'one open issue' }]) }];
        case 'getCheckRuns':
          return [{ match: 'check-runs', stdout: ghCheckRunPage([{ name: 'ci', id: 1 }]) }];
      }
      break;
    case 'capped-full-page':
      switch (scenario.member) {
        case 'getOpenIssueNumbers':
        case 'getOpenIssues':
          return [
            {
              match: 'search/issues',
              stdout: ghSearchPage(
                Array.from({ length: 100 }, (_, i) => ({ number: 1 + i, title: `filler ${1 + i}` }))
              ),
            },
          ];
        case 'getCheckRuns':
          return [
            {
              match: 'check-runs',
              stdout: ghCheckRunPage(
                Array.from({ length: 100 }, (_, i) => ({ name: `run-${1 + i}`, id: 1 + i }))
              ),
            },
          ];
      }
      break;
    case 'unauthenticated':
      if (scenario.member === 'preflight') {
        return [
          { match: '^--version$', stdout: 'gh version 2.60.0\n' },
          { match: '^auth status$', exit: 1, stderr: 'gh auth status failed\n' },
        ];
      }
      return [{ match: '^api ', exit: 1, stderr: 'gh: HTTP 401 (github.com)\n' }];
    case 'transport-failure':
      if (scenario.member === 'preflight') {
        return [
          { match: '^--version$', stdout: 'gh version 2.60.0\n' },
          { match: '^auth status$', exit: 2, stderr: 'fatal: gh crashed\n' },
        ];
      }
      return [{ match: '^api ', exit: 1, stderr: 'gh: rate limit exceeded\n' }];
    case 'not-found':
      return scenario.member === 'getIssue'
        ? [{ match: '/issues/7$', exit: 1, stderr: 'gh: Not Found (HTTP 404)\n' }]
        : [{ match: '/pulls/42$', exit: 1, stderr: 'gh: Not Found (HTTP 404)\n' }];
    case 'missing-cli':
      return [];
  }
}

const ghHarness: BehaviourHarness = {
  name: 'GhCliGitHubProvider',
  repo: GH_REPO,
  codes: {
    missing: 'gh_missing',
    unauthenticated: 'gh_unauthenticated',
    transport: 'gh_transport',
  },
  build(tempDir, scenario) {
    if (scenario.kind === 'missing-cli') {
      const emptyBin = path.join(tempDir, 'empty-bin');
      fs.mkdirSync(emptyBin, { recursive: true });
      return new GhCliGitHubProvider({ env: { PATH: emptyBin } });
    }
    const fake = createFakeGh(tempDir, ghRules(scenario));
    return new GhCliGitHubProvider({ env: fake.env() });
  },
};

// ---------------------------------------------------------------------
// glab registration
// ---------------------------------------------------------------------

const GL_REPO: RepoRef = { owner: 'group/subgroup', repo: 'project', platform: 'gitlab' };
const GL_HOST = 'git.example.com';

function glabIssuePage(items: Array<{ iid: number; title?: string }>): string {
  return JSON.stringify(items);
}

function glabJobPage(jobs: Array<{ id: number; name: string }>): string {
  return JSON.stringify(
    jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: 'success',
      allow_failure: false,
      started_at: STARTED_AT,
    }))
  );
}

function glabRules(scenario: Scenario): FakeGlabRule[] {
  const onePipeline: FakeGlabRule = {
    match: 'pipelines\\?sha=',
    stdout: JSON.stringify([{ id: 1, sha: SHA, status: 'success' }]),
  };
  switch (scenario.kind) {
    case 'exhausted-list':
      switch (scenario.member) {
        case 'getOpenIssueNumbers':
        case 'getOpenIssues':
          return [{ match: 'issues\\?state=opened', stdout: glabIssuePage([{ iid: 7, title: 'one open issue' }]) }];
        case 'getCheckRuns':
          return [onePipeline, { match: 'pipelines/1/jobs', stdout: glabJobPage([{ id: 1, name: 'ci' }]) }];
      }
      break;
    case 'capped-full-page':
      switch (scenario.member) {
        case 'getOpenIssueNumbers':
        case 'getOpenIssues':
          return [
            {
              match: 'issues\\?state=opened',
              stdout: glabIssuePage(Array.from({ length: 100 }, (_, i) => ({ iid: 1 + i }))),
            },
          ];
        case 'getCheckRuns':
          return [
            onePipeline,
            {
              match: 'pipelines/1/jobs',
              stdout: glabJobPage(Array.from({ length: 100 }, (_, i) => ({ id: 1 + i, name: `job-${1 + i}` }))),
            },
          ];
      }
      break;
    case 'unauthenticated':
      if (scenario.member === 'preflight') {
        return [
          { match: '^--version$', stdout: 'glab version 1.113.0\n' },
          { match: '^auth status --hostname', exit: 1, stderr: 'no token for host\n' },
        ];
      }
      return [{ match: '^api ', exit: 1, stderr: 'glab: 401 Unauthorized\n' }];
    case 'transport-failure':
      if (scenario.member === 'preflight') {
        return [
          { match: '^--version$', stdout: 'glab version 1.113.0\n' },
          { match: '^auth status --hostname', exit: 2, stderr: 'fatal: glab crashed\n' },
        ];
      }
      return [{ match: '^api ', exit: 1, stderr: 'glab: 502 Bad Gateway\n' }];
    case 'not-found':
      return scenario.member === 'getIssue'
        ? [{ match: '/issues/7$', exit: 1, stderr: 'glab: 404 Issue Not Found\n' }]
        : [{ match: '/merge_requests/42$', exit: 1, stderr: 'glab: 404 Not Found\n' }];
    case 'missing-cli':
      return [];
  }
}

const glabHarness: BehaviourHarness = {
  name: 'GlabProvider',
  repo: GL_REPO,
  codes: {
    missing: 'glab_missing',
    unauthenticated: 'glab_unauthenticated',
    transport: 'glab_transport',
  },
  build(tempDir, scenario) {
    if (scenario.kind === 'missing-cli') {
      const emptyBin = path.join(tempDir, 'empty-bin');
      fs.mkdirSync(emptyBin, { recursive: true });
      return new GlabProvider({ hostname: GL_HOST, env: { PATH: emptyBin } });
    }
    const fake = createFakeGlab(tempDir, glabRules(scenario));
    return new GlabProvider({ hostname: GL_HOST, env: fake.env() });
  },
};

// ---------------------------------------------------------------------
// The contract table — written once, inherited by every registration.
// ---------------------------------------------------------------------

const REGISTRATIONS: readonly BehaviourHarness[] = [ghHarness, glabHarness];

describe('forge adapter behavioural contract (#275)', () => {
  for (const harness of REGISTRATIONS) {
    describe(harness.name, () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = makeTempDir('specgit-contract-');
      });

      afterEach(() => {
        rmDir(tempDir);
      });

      describe('list completeness (I3b)', () => {
        for (const member of LIST_MEMBERS) {
          it(`${member}: a list exhausted to a short page is ok`, async () => {
            const provider = harness.build(tempDir, { kind: 'exhausted-list', member });
            const result = await CALLS[member](provider, harness.repo);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(Array.isArray(result.value)).toBe(true);
            expect(result.value as unknown[]).toHaveLength(1);
          });

          it(`${member}: the page cap reached with a full page fails evidence_truncated`, async () => {
            const provider = harness.build(tempDir, { kind: 'capped-full-page', member });
            const result = await CALLS[member](provider, harness.repo);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe('evidence_truncated');
          });
        }
      });

      describe('fail-closed classification (I3a)', () => {
        for (const member of READ_MEMBERS) {
          it(`${member}: a missing CLI fails closed with ${harness.codes.missing}`, async () => {
            const provider = harness.build(tempDir, { kind: 'missing-cli', member });
            const result = await CALLS[member](provider, harness.repo);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe(harness.codes.missing);
          });

          it(`${member}: an unauthenticated session fails closed with ${harness.codes.unauthenticated}`, async () => {
            const provider = harness.build(tempDir, { kind: 'unauthenticated', member });
            const result = await CALLS[member](provider, harness.repo);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe(harness.codes.unauthenticated);
          });

          it(`${member}: a transport failure fails closed with ${harness.codes.transport}`, async () => {
            const provider = harness.build(tempDir, { kind: 'transport-failure', member });
            const result = await CALLS[member](provider, harness.repo);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe(harness.codes.transport);
          });
        }

        for (const member of ['getIssue', 'getPr'] as const) {
          const expected = member === 'getIssue' ? 'issue_not_found' : 'pr_not_found';
          it(`${member}: a 404 lookup fails closed with the platform-neutral ${expected}`, async () => {
            const provider = harness.build(tempDir, { kind: 'not-found', member });
            const result = await CALLS[member](provider, harness.repo);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe(expected);
          });
        }
      });
    });
  }
});
