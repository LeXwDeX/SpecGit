/**
 * End-to-end tests for the one-command delivery story (issue #4):
 *
 *  1. `specgit issue` bootstraps a delivery from two NEW issues — real
 *     git branch/commit/push against a local bare remote, fake `gh`
 *     wired for createIssue/createDraftPr — and after a simulated
 *     merge `specgit finish` accepts with both issues closed by the PR
 *     body.
 *  2. A simulated failure between bootstrap steps (PR creation fails
 *     after the issues exist) heals on re-run: no duplicate issues are
 *     created, the chain resumes and completes.
 *  3. `specgit pr` auto-discovers the single open PR for the head
 *     branch and repairs the record.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { renderPrScaffold } from '../../src/github/pr-scaffold.js';
import {
  checkRunsJson,
  createFakeGh,
  emptyTimelineRule,
  git,
  greenGhRules,
  initPolicy,
  issueJson,
  makeRepo,
  OWNER,
  parseEnvelope,
  prJson,
  readFakeGhCalls,
  readFakeGhStdin,
  REQUIRED_CHECK,
  REPO,
  rmDir,
  specgit,
  type FakeGhRule,
  type RepoFixture,
} from './helpers.js';

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    rmDir(dir);
  }
});

/**
 * A repo whose `origin` is the GitHub URL but whose pushes land in a
 * local bare remote (url.<bare>.insteadOf rewrite): real git transport,
 * no network, origin still parses to OWNER/REPO.
 */
function makePushableRepo(branch: string): RepoFixture & { bareDir: string } {
  const repo = makeRepo(branch);
  const bareDir = path.join(os.tmpdir(), `specgit-e2e-bare-${randomUUID().slice(0, 8)}.git`);
  git(repo.dir, 'init', '--bare', bareDir);
  git(repo.dir, 'config', `url.${bareDir}.insteadOf`, `https://github.com/${OWNER}/${REPO}.git`);
  cleanupDirs.push(bareDir, repo.dir);
  return { ...repo, bareDir };
}

/**
 * Fake gh with its artifacts OUTSIDE the repo working tree, so the
 * bootstrap's commit and the acceptance dirty gate see a clean tree.
 */
function makeGh(rules: FakeGhRule[]) {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-e2e-issue-gh-'));
  cleanupDirs.push(fakeDir);
  return createFakeGh(fakeDir, rules);
}

/**
 * Traceability comment rule (#160): posted once per bound issue on every
 * rule table whose bootstrap reaches the PR binding. The URL is
 * deliberately constant — the e2e pins the call, not the payload.
 */
const COMMENT_RULE: FakeGhRule = {
  match: `^api repos/${OWNER}/${REPO}/issues/[0-9]+/comments `,
  stdout: `{"html_url":"https://github.com/${OWNER}/${REPO}/issues/11#issuecomment-1"}`,
};

/** Fake gh for the bootstrap: issues created as #11, #12, …; draft PR #<pr>. */
function bootstrapRules(pr: number | undefined): FakeGhRule[] {  return [
    { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
    {
      match: `^api repos/${OWNER}/${REPO}/issues `,
      stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
      seq: { start: 11 },
    },
    // Traceability comment (#160): posted once per bound issue. The fake's
    // URL is deliberately constant — the e2e pins the call, not the payload.
    COMMENT_RULE,
    { match: '^pr list ', stdout: '[]' },
    ...(pr !== undefined
      ? [{ match: '^pr create --draft ', stdout: `https://github.com/${OWNER}/${REPO}/pull/${pr}\n` }]
      : []),
  ];
}

describe('e2e issue: one-command bootstrap closes both new issues after merge', () => {
  // Three full CLI passes (issue bootstrap with real git transport, init,
  // finish) plus ~10 direct git spawns: the global 10s test budget cannot
  // hold three passes that each may legally run up to the 30s per-CLI
  // limit (run-cli DEFAULT_CLI_TIMEOUT_MS), and it intermittently overruns
  // on the serialized 1-worker windows-pwsh runner (observed 2026-08-23,
  // run 32643134007 / job 97203205775) — the same headroom the
  // bootstrap-pair test below already needed (30s, runs
  // 32438687376/32438704880). Runtime variance, not a regression: this
  // test passed the windows-pwsh leg before 588f245e, which never touched
  // the bootstrap/finish path.
  it('bootstraps two issues → branch → draft PR → record → commit → push, then finish accepts post-merge', { timeout: 30_000 }, async () => {
    const repo = makePushableRepo('main');
    const deliveryBranch = 'feat/11-strict-delivery-harness';

    const gh = makeGh(bootstrapRules(77));
    const result = await specgit(
      ['issue', 'feat: strict delivery harness', 'fix: harden the evaluator', '--json'],
      { cwd: repo.dir, env: gh.env() }
    );

    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.command).toBe('issue');
    expect(envelope.status).toBe('ok');
    expect(envelope.state).toBe('bound');
    expect(envelope.record).toMatchObject({
      delivery: 'strict-delivery-harness',
      context: { kind: 'branch', branch: deliveryBranch },
      issues: [11, 12],
      pr: 77,
    });

    // Real git state: on the delivery branch, record committed, pushed.
    expect(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(deliveryBranch);
    expect(git(repo.dir, 'log', '-1', '--format=%s').trim()).toBe(
      'chore: record delivery binding for strict-delivery-harness'
    );
    expect(git(repo.dir, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo.bareDir, 'rev-parse', '--verify', `refs/heads/${deliveryBranch}`).trim()).toBe(
      git(repo.dir, 'rev-parse', 'HEAD').trim()
    );

    // The draft PR body is the deterministic scaffold (#87): closing
    // refs for every bound issue first, then the advisory sections.
    const createdBody = readFakeGhStdin(gh.logPath)[0];
    expect(createdBody).toBe(renderPrScaffold([11, 12]));
    for (const section of ['## Why', '## What changed', '## Evidence', '## Checklist']) {
      expect(createdBody).toContain(section);
    }

    // Traceability edge issue→branch (#160): every bound issue received
    // the delivery branch and PR number as a comment, exactly once each.
    const comments = readFakeGhCalls(gh.logPath).filter((args) =>
      args.startsWith(`api repos/${OWNER}/${REPO}/issues/`)
    );
    expect(comments).toEqual([
      `api repos/${OWNER}/${REPO}/issues/11/comments -f body=SpecGit delivery branch: \`${deliveryBranch}\` (draft pull request #77).`,
      `api repos/${OWNER}/${REPO}/issues/12/comments -f body=SpecGit delivery branch: \`${deliveryBranch}\` (draft pull request #77).`,
    ]);

    // Simulate the merge: PR merged, issues closed by GitHub, checks
    // green at the (pushed) head commit — finish must accept. The PR
    // keeps the exact scaffold body the bootstrap wrote, proving the
    // created scaffold parses as closing every bound issue.
    const sha = git(repo.dir, 'rev-parse', 'HEAD').trim();
    const ghMerged = makeGh([
      { match: '^--version$', stdout: 'gh version 2.60.0-specgit-e2e\n' },
      { match: '^auth status', stdout: 'Logged in to github.com\n' },
      { match: `^api repos/${OWNER}/${REPO}/issues/11$`, stdout: issueJson(11, 'closed') },
      { match: `^api repos/${OWNER}/${REPO}/issues/12$`, stdout: issueJson(12, 'closed') },
      {
        match: `^api repos/${OWNER}/${REPO}/pulls/77$`,
        stdout: prJson({
          number: 77,
          branch: deliveryBranch,
          sha,
          body: createdBody,
          mergedAt: '2026-01-02T03:04:05Z',
        }),
      },
      emptyTimelineRule(),
      {
        match: `^api repos/${OWNER}/${REPO}/commits/[0-9a-f]+/check-runs`,
        stdout: checkRunsJson([{ name: REQUIRED_CHECK }]),
      },
    ]);
    await initPolicy(repo.dir, ghMerged.env());

    const finish = await specgit(['finish', '--json'], { cwd: repo.dir, env: ghMerged.env() });
    expect(finish.exitCode).toBe(0);
    const finishEnvelope = parseEnvelope(finish);
    expect(finishEnvelope.command).toBe('finish');
    expect(finishEnvelope.status).toBe('ok');
    expect(finishEnvelope.verdict.classification).toBe('accepted');
    expect(finishEnvelope.verdict.evidence.issues).toEqual([11, 12]);
  });
});

describe('e2e issue: idempotent resume after a failure between steps', () => {
  it('re-runs the same command after PR-creation failure without duplicating issues', async () => {
    const repo = makePushableRepo('main');

    // First run: issue creation succeeds, PR creation has no gh rule
    // (the fake refuses) — a failure between steps.
    const ghBroken = makeGh(bootstrapRules(undefined));
    const first = await specgit(['issue', 'feat: resume flow', 'chore: second why', '--json'], {
      cwd: repo.dir,
      env: ghBroken.env(),
    });
    expect(first.exitCode).toBe(3);
    expect(parseEnvelope(first).errors[0].code).toBe('gh_transport');

    // The partial record is on disk with both issues and no PR.
    const partial = fs.readFileSync(path.join(repo.dir, '.specgit.yaml'), 'utf-8');
    expect(partial).toContain('- 11');
    expect(partial).toContain('- 12');
    expect(partial).not.toMatch(/^pr:/m);
    expect(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/11-resume-flow');

    // Second run with the healed transport: same command line resumes.
    const ghWhole = makeGh(bootstrapRules(77));
    const second = await specgit(['issue', 'feat: resume flow', 'chore: second why', '--json'], {
      cwd: repo.dir,
      env: ghWhole.env(),
    });
    expect(second.exitCode).toBe(0);
    const envelope = parseEnvelope(second);
    expect(envelope.state).toBe('bound');
    expect(envelope.record.pr).toBe(77);

    // Exactly two issue creations total — both from the first run; the
    // resumed run must not create issues again. The two fake instances
    // keep separate logs, so count across both.
    const createCalls = [...readFakeGhCalls(ghBroken.logPath), ...readFakeGhCalls(ghWhole.logPath)].filter(
      (args) => args.startsWith(`api repos/${OWNER}/${REPO}/issues `)
    );
    expect(createCalls.length).toBe(2);
    expect(readFakeGhStdin(ghWhole.logPath)).toEqual([renderPrScaffold([11, 12])]);
    expect(git(repo.bareDir, 'rev-parse', '--verify', 'refs/heads/feat/11-resume-flow').trim()).toBe(
      git(repo.dir, 'rev-parse', 'HEAD').trim()
    );
  });
});

describe('e2e issue: exactly-once across partial failures (fault injection)', () => {
  it('adopts the remotely created issue when the creation response was lost', async () => {
    const repo = makePushableRepo('main');

    // Run 1: the fake allocates #11 remotely (seq state consumed) but
    // exits 1 — the client sees a transport failure. The issue exists,
    // nothing is recorded.
    const ghLost = makeGh([
      { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
      {
        match: `^api repos/${OWNER}/${REPO}/issues `,
        stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
        seq: { start: 11 },
        exit: 1,
      },
    ]);
    const first = await specgit(['issue', 'feat: phoenix flow', 'chore: second wing', '--json'], {
      cwd: repo.dir,
      env: ghLost.env(),
    });
    expect(first.exitCode).toBe(3);
    expect(parseEnvelope(first).errors[0].code).toBe('gh_transport');
    expect(fs.existsSync(path.join(repo.dir, '.specgit.yaml'))).toBe(false);

    // Run 2: the remote reports open issue #11 with the exact title —
    // adopt it; only the second WHY is created. The title rides the
    // search payload itself (#77): one title-carrying scan, no per-issue
    // lookup.
    const ghWhole = makeGh([
      {
        match: '^api search/issues',
        stdout: JSON.stringify({ items: [{ number: 11, title: 'feat: phoenix flow' }] }),
      },
      {
        match: `^api repos/${OWNER}/${REPO}/issues `,
        stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
        seq: { start: 12 },
      },
      { match: '^pr list ', stdout: '[]' },
      { match: '^pr create --draft ', stdout: `https://github.com/${OWNER}/${REPO}/pull/77\n` },
      COMMENT_RULE,
    ]);
    const second = await specgit(['issue', 'feat: phoenix flow', 'chore: second wing', '--json'], {
      cwd: repo.dir,
      env: ghWhole.env(),
    });
    expect(second.exitCode).toBe(0);
    expect(parseEnvelope(second).record).toMatchObject({ issues: [11, 12], pr: 77 });

    const creates = readFakeGhCalls(ghWhole.logPath).filter((args) =>
      args.startsWith(`api repos/${OWNER}/${REPO}/issues `)
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('title=chore: second wing');
    expect(readFakeGhStdin(ghWhole.logPath)).toEqual([renderPrScaffold([11, 12])]);
  });

  // Two full bootstraps (fault + heal) with real git work each; the global
  // 10s budget intermittently overruns on the slower windows-pwsh runner
  // (observed 2026-08-21, runs 32438687376/32438704880) — neighbors with
  // one bootstrap pass at 2.7–5.9s there.
  it('reconciles by title when the record write failed after creation', { timeout: 30_000 }, async () => {
    const repo = makePushableRepo('main');

    // Fault: a directory where the record lock file belongs makes every
    // writeRecord fail — the issue is created remotely, nothing persists.
    const lockDir = path.join(repo.dir, '.specgit.yaml.lock');
    fs.mkdirSync(lockDir);
    const ghCreated = makeGh([
      { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
      {
        match: `^api repos/${OWNER}/${REPO}/issues `,
        stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
        seq: { start: 11 },
      },
    ]);
    const first = await specgit(['issue', 'feat: durable state model', '--json'], {
      cwd: repo.dir,
      env: ghCreated.env(),
    });
    expect(first.exitCode).toBe(3);
    expect(parseEnvelope(first).errors[0].code).toBe('record_write_failed');
    expect(fs.existsSync(path.join(repo.dir, '.specgit.yaml'))).toBe(false);

    // Heal the write path; the retry adopts #11 by its exact title and
    // creates nothing.
    fs.rmSync(lockDir, { recursive: true, force: true });
    const ghHealed = makeGh([
      {
        match: '^api search/issues',
        stdout: JSON.stringify({ items: [{ number: 11, title: 'feat: durable state model' }] }),
      },
      { match: '^pr list ', stdout: '[]' },
      { match: '^pr create --draft ', stdout: `https://github.com/${OWNER}/${REPO}/pull/77\n` },
      COMMENT_RULE,
    ]);
    const second = await specgit(['issue', 'feat: durable state model', '--json'], {
      cwd: repo.dir,
      env: ghHealed.env(),
    });
    expect(second.exitCode).toBe(0);
    expect(parseEnvelope(second).record).toMatchObject({ issues: [11], pr: 77 });
    expect(
      readFakeGhCalls(ghHealed.logPath).filter((args) =>
        args.startsWith(`api repos/${OWNER}/${REPO}/issues `)
      )
    ).toHaveLength(0);
  });

  it('resumes from the durable partial record even when the remote title drifted', async () => {
    const repo = makePushableRepo('main');

    // Run 1: the first WHY is created and recorded; the second creation
    // fails — a partial record with issues [11] survives on disk.
    const ghBroken = makeGh([
      { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
      {
        match: `^api repos/${OWNER}/${REPO}/issues .*title=feat: alpha why`,
        stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
        seq: { start: 11 },
      },
      { match: `^api repos/${OWNER}/${REPO}/issues `, exit: 1 },
    ]);
    const args = ['feat: alpha why', 'fix: beta why'];
    const first = await specgit(['issue', ...args, '--json'], {
      cwd: repo.dir,
      env: ghBroken.env(),
    });
    expect(first.exitCode).toBe(3);
    const partial = fs.readFileSync(path.join(repo.dir, '.specgit.yaml'), 'utf-8');
    expect(partial).toContain('- 11');
    expect(partial).not.toContain('- 12');
    expect(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');

    // Run 2: #11 was renamed remotely by a teammate. The resume must trust
    // the durable binding for the consumed argument and only create the
    // second WHY — reconciliation alone would duplicate the first.
    const ghWhole = makeGh([
      {
        match: '^api search/issues',
        stdout: JSON.stringify({ items: [{ number: 11, title: 'renamed by a teammate' }] }),
      },
      {
        match: `^api repos/${OWNER}/${REPO}/issues `,
        stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
        seq: { start: 12 },
      },
      { match: '^pr list ', stdout: '[]' },
      { match: '^pr create --draft ', stdout: `https://github.com/${OWNER}/${REPO}/pull/77\n` },
      COMMENT_RULE,
    ]);
    const second = await specgit(['issue', ...args, '--json'], {
      cwd: repo.dir,
      env: ghWhole.env(),
    });
    expect(second.exitCode).toBe(0);
    expect(parseEnvelope(second).record).toMatchObject({ issues: [11, 12], pr: 77 });

    const creates = readFakeGhCalls(ghWhole.logPath).filter((argsList) =>
      argsList.startsWith(`api repos/${OWNER}/${REPO}/issues `)
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('title=fix: beta why');
    expect(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/11-alpha-why');
    expect(readFakeGhStdin(ghWhole.logPath)).toEqual([renderPrScaffold([11, 12])]);
  });

  it('adopts the open PR for the head branch when the PR response was lost', async () => {
    const repo = makePushableRepo('main');

    // Run 1: the issue is created and recorded; the PR is created remotely
    // (conceptually) but the client sees a failure — no PR number recorded.
    const ghBroken = makeGh([
      { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
      {
        match: `^api repos/${OWNER}/${REPO}/issues `,
        stdout: `{"number":%SEQ%,"html_url":"https://github.com/${OWNER}/${REPO}/issues/%SEQ%"}`,
        seq: { start: 11 },
      },
      { match: '^pr list ', stdout: '[]' },
      { match: '^pr create --draft ', exit: 1 },
    ]);
    const first = await specgit(['issue', 'feat: wing repair', '--json'], {
      cwd: repo.dir,
      env: ghBroken.env(),
    });
    expect(first.exitCode).toBe(3);
    const partial = fs.readFileSync(path.join(repo.dir, '.specgit.yaml'), 'utf-8');
    expect(partial).toContain('- 11');
    expect(partial).not.toMatch(/^pr:/m);

    // Run 2: the remote has exactly one open PR for the head branch —
    // adopt it; a second PR must not be created.
    const ghWhole = makeGh([
      {
        match: '^pr list ',
        stdout: JSON.stringify([
          {
            number: 77,
            title: 'feat: wing repair',
            url: `https://github.com/${OWNER}/${REPO}/pull/77`,
          },
        ]),
      },
      COMMENT_RULE,
    ]);
    const second = await specgit(['issue', 'feat: wing repair', '--json'], {
      cwd: repo.dir,
      env: ghWhole.env(),
    });
    expect(second.exitCode).toBe(0);
    const envelope = parseEnvelope(second);
    expect(envelope.state).toBe('bound');
    expect(envelope.record.pr).toBe(77);

    const prCreates = [...readFakeGhCalls(ghBroken.logPath), ...readFakeGhCalls(ghWhole.logPath)].filter(
      (argsList) => argsList.startsWith('pr create --draft')
    );
    expect(prCreates).toHaveLength(1);
    expect(git(repo.bareDir, 'rev-parse', '--verify', 'refs/heads/feat/11-wing-repair').trim()).toBe(
      git(repo.dir, 'rev-parse', 'HEAD').trim()
    );
  });
});

describe('e2e pr: auto-discovery repairs the binding', () => {
  it('binds the single open PR found for the head branch', async () => {
    const repo = makePushableRepo('feat/55-repair-binding');

    const gh = makeGh([
      {
        match: '^pr list ',
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Repair the PR binding',
            url: `https://github.com/${OWNER}/${REPO}/pull/42`,
          },
        ]),
      },
    ]);
    await initPolicy(repo.dir, gh.env());
    await specgit(
      ['bind', '--delivery', 'repair-binding', '--issue', '55', '--json'],
      { cwd: repo.dir, env: gh.env() }
    );

    const result = await specgit(['pr', '--json'], { cwd: repo.dir, env: gh.env() });
    expect(result.exitCode).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.command).toBe('pr');
    expect(envelope.status).toBe('ok');
    expect(envelope.state).toBe('bound');
    expect(envelope.record.pr).toBe(42);

    const record = fs.readFileSync(path.join(repo.dir, '.specgit.yaml'), 'utf-8');
    expect(record).toMatch(/^pr: 42$/m);
    expect(readFakeGhCalls(gh.logPath).some((args) => args.includes('--head feat/55-repair-binding'))).toBe(
      true
    );
  });
});
