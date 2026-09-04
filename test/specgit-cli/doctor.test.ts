import { describe, expect, it } from 'vitest';
import { CODE_INFO } from '../../src/acceptance/codes.js';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../../src/cli/exit-codes.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import {
  makeCtx,
  makeGhProvider,
  makeGitFacts,
  parseStdoutJson,
  sampleBinding,
  samplePolicy,
  stdoutText,
} from './helpers.js';

describe('specgit doctor', () => {
  it('reports all probes green and exits 0', async () => {
    const t = makeCtx({ policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.probes.map((p: any) => p.name)).toEqual([
      'git',
      'repo',
      'origin',
      'gh_present',
      'gh_authenticated',
      'policy',
    ]);
    for (const probe of envelope.probes) {
      expect(probe.ok).toBe(true);
    }
  });

  it('prints a probe table in text mode', async () => {
    const t = makeCtx({ policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'doctor'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(stdoutText(t.io)).toContain('git');
    expect(stdoutText(t.io)).toContain('policy');
  });

  it('exits 3 when the GitHub provider is unauthenticated', async () => {
    const t = makeCtx({
      policy: samplePolicy(),
      gh: {
        preflight: async () => ({ ok: false, code: 'gh_unauthenticated', message: 'gh auth status failed.' }),
        getIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getOpenIssueNumbers: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getOpenIssues: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        searchIssueHistory: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getCiConfigPath: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        listIssuePullRequests: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getPr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getCheckRuns: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getPrChecks: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        mergePr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        closeIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getEvidenceAnchor: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        createIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        createDraftPr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        listOpenPrsByHead: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        addIssueComment: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        addIssueLabels: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getBranchProtection: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        enableBranchProtection: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getRepoAutomerge: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        enableRepoAutomerge: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        listRepoLabels: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        ensureRepoLabels: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
      },
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'gh_authenticated');
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe('gh_unauthenticated');
  });

  it('exits 3 when the policy is missing', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'policy');
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe('policy_missing');
  });

  it('exits 3 outside a git repository', async () => {
    const t = makeCtx({
      root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' },
      policy: samplePolicy(),
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'repo');
    expect(probe.ok).toBe(false);
  });

  it('reports an undeclared gitlab.com origin as gitlab_unsupported and still probes gh', async () => {
    const t = makeCtx({
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://gitlab.com/owner/repo.git' }),
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const probe = envelope.probes.find((p: any) => p.name === 'origin');
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe('gitlab_unsupported');
    const ghPresent = envelope.probes.find((p: any) => p.name === 'gh_present');
    expect(ghPresent.ok).toBe(true);
  });

  // #117 (provider routing): a DECLARED GitLab origin resolves through
  // the platform marker — the origin probe passes with the nested-group
  // ref — and the provider probes report the glab CLI's evidence codes
  // through the same envelope keys.
  it('passes the origin probe for a declared GitLab origin and maps glab probe codes', async () => {
    const t = makeCtx({
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'https://git.example.com/g/sg/p.git' }),
      parseRepoRef: (url: string) =>
        parseRepoRef(url, { gitlabHost: 'git.example.com' }),
      gh: makeGhProvider({
        preflight: fail('glab_missing', 'GitLab CLI (glab) is not installed or not on PATH.'),
      }),
    });
    const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    const origin = envelope.probes.find((p: any) => p.name === 'origin');
    expect(origin.ok).toBe(true);
    expect(origin.detail).toBe('g/sg/p');
    const ghPresent = envelope.probes.find((p: any) => p.name === 'gh_present');
    expect(ghPresent.ok).toBe(false);
    expect(ghPresent.code).toBe('glab_missing');
    const ghAuthenticated = envelope.probes.find((p: any) => p.name === 'gh_authenticated');
    expect(ghAuthenticated.ok).toBe(false);
    expect(ghAuthenticated.code).toBe('glab_missing');
  });

  // #166: a failing probe's diagnostic must carry the `fix` string from the
  // codes catalogue (src/acceptance/codes.ts), so an agent consuming the
  // --json envelope gets a machine-readable remedy, not just a code.
  describe('failing probes surface catalogue fix hints (#166)', () => {
    it('attaches the gh_unauthenticated fix to the --json error', async () => {
      const t = makeCtx({
        policy: samplePolicy(),
        gh: {
          preflight: async () => ({ ok: false, code: 'gh_unauthenticated', message: 'gh auth status failed.' }),
          getIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getOpenIssueNumbers: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getOpenIssues: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          searchIssueHistory: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getCiConfigPath: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          listIssuePullRequests: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getPr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getCheckRuns: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        getPrChecks: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        mergePr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        closeIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getEvidenceAnchor: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          createIssue: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          createDraftPr: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          listOpenPrsByHead: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          addIssueComment: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          addIssueLabels: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getBranchProtection: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          enableBranchProtection: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          getRepoAutomerge: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          enableRepoAutomerge: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          listRepoLabels: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
          ensureRepoLabels: async () => ({ ok: false, code: 'gh_transport', message: 'unreachable' }),
        },
      });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_UNKNOWN);
      const envelope = parseStdoutJson(t.io);
      const error = envelope.errors.find((e: any) => e.code === 'gh_unauthenticated');
      expect(error).toBeDefined();
      expect(error.fix).toBe(CODE_INFO.gh_unauthenticated.fix);
    });

    it('attaches the policy_missing fix to the --json error', async () => {
      const t = makeCtx();
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_UNKNOWN);
      const envelope = parseStdoutJson(t.io);
      const error = envelope.errors.find((e: any) => e.code === 'policy_missing');
      expect(error).toBeDefined();
      expect(error.fix).toBe(CODE_INFO.policy_missing.fix);
    });

    it('attaches the not_a_git_repo fix to the --json error', async () => {
      const t = makeCtx({
        root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' },
        policy: samplePolicy(),
      });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_UNKNOWN);
      const envelope = parseStdoutJson(t.io);
      const error = envelope.errors.find((e: any) => e.code === 'not_a_git_repo');
      expect(error).toBeDefined();
      expect(error.fix).toBe(CODE_INFO.not_a_git_repo.fix);
    });

    it('attaches the glab_missing fix to the --json error', async () => {
      const t = makeCtx({
        policy: samplePolicy(),
        facts: makeGitFacts({ originUrl: 'https://git.example.com/g/sg/p.git' }),
        parseRepoRef: (url: string) =>
          parseRepoRef(url, { gitlabHost: 'git.example.com' }),
        gh: makeGhProvider({
          preflight: fail('glab_missing', 'GitLab CLI (glab) is not installed or not on PATH.'),
        }),
      });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_UNKNOWN);
      const envelope = parseStdoutJson(t.io);
      const error = envelope.errors.find((e: any) => e.code === 'glab_missing');
      expect(error).toBeDefined();
      expect(error.fix).toBe(CODE_INFO.glab_missing.fix);
    });

    it('leaves doctor exit-code semantics unchanged', async () => {
      const t = makeCtx({ policy: samplePolicy() });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_SUCCESS);
      const envelope = parseStdoutJson(t.io);
      expect(envelope.errors ?? []).toEqual([]);
    });
  });

  describe('stray issue probe (#348)', () => {
    const SCAFFOLD_BODY =
      '## Why\nsome title\n\n## Scope\n\n## Approach\n\n## Acceptance\nThe delivery pull request closes this issue; `specgit finish` must exit 0.';
    const openIssue = {
      getOpenIssues: () =>
        ok([
          { number: 21, title: 'feat: stray one', body: SCAFFOLD_BODY },
          { number: 22, title: 'human question', body: 'how do I configure X?' },
        ]),
    };

    it('warns about a specgit-scaffolded open issue outside any delivery', async () => {
      const t = makeCtx({ policy: samplePolicy(), gh: makeGhProvider(openIssue) });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_SUCCESS);
      const envelope = parseStdoutJson(t.io);
      const stray = (envelope.warnings ?? []).find(
        (w: any) => w.code === 'issue_stray'
      );
      expect(stray).toBeDefined();
      expect(stray.message).toContain('#21');
      expect(stray.message).not.toContain('#22');
    });

    it('never flags a bound issue or a human-authored body', async () => {
      const bound = sampleBinding({ issues: [21] });
      const t = makeCtx({
        policy: samplePolicy(),
        gh: makeGhProvider(openIssue),
        record: bound,
      });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_SUCCESS);
      const envelope = parseStdoutJson(t.io);
      expect(envelope.warnings ?? []).toEqual([]);
    });

    it('degrades silently when open-issue evidence cannot be gathered', async () => {
      const t = makeCtx({
        policy: samplePolicy(),
        gh: makeGhProvider({
          getOpenIssues: () => fail('gh_transport', 'down'),
        }),
      });
      const code = await runCliWith(['node', 'specgit', 'doctor', '--json'], t.ctx);
      expect(code).toBe(EXIT_SUCCESS);
      const envelope = parseStdoutJson(t.io);
      expect(envelope.warnings ?? []).toEqual([]);
    });
  });
});
