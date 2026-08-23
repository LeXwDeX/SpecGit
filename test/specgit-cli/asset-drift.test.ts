/**
 * #308 — the read-only generated-asset inspector: per-asset states
 * (current/stale/missing/conflict), surface grouping with exact fixes,
 * portWrite exclusion, and the no-claim refusals (undecided platform,
 * unresolved default branch, unmergeable hooks.json, committed-
 * authoritative ignore opt-out). Completeness fails closed: a report
 * with any unknown part is `complete: false` and can never be `clean`,
 * while the proven committed-authoritative opt-out rides `skipped` and
 * never spoils an otherwise current report. Written RED against the
 * pre-#308 tree: `inspectManagedAssets`, `inspectGeneratedAssets`, and
 * the `assets.generated` report did not exist, and old/missing/current
 * fixtures were indistinguishable in `status` output.
 *
 * Real temporary filesystems throughout — no fake filesystem port. The
 * only doubles are the CLI context ports (git facts, record policy) the
 * production composition injects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCliWith } from '../../src/cli/index.js';
import {
  inspectManagedAssets,
  type DesiredManagedAssets,
} from '../../src/cli/managed-reconcile.js';
import {
  inspectGeneratedAssets,
  renderGeneratedAssetsHuman,
  type GeneratedAssetsReport,
} from '../../src/cli/asset-drift.js';
import { ENTRY_POINT_MARKER } from '../../src/cli/agent-surface.js';
import { HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-placement.js';
import { catalogFor } from '../../src/i18n/language.js';
import type { StatusOutcome } from '../../src/cli/output.js';
import type { Evidence } from '../../src/kernel/evidence.js';
import type { Policy } from '../../src/record/policy.js';
import { makeCtx, makeGitFacts, samplePolicy } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const POLICY_OK = { ok: true, value: samplePolicy() } as const;

function write(root: string, rel: string, content: string): string {
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** Full-file snapshot: bytes AND mode, so read-only guarantees are exact. */
function treeState(root: string): Map<string, { content: string; mode: number }> {
  const state = new Map<string, { content: string; mode: number }>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        state.set(path.relative(root, full), {
          content: fs.readFileSync(full, 'utf-8'),
          mode: fs.statSync(full).mode,
        });
      }
    }
  };
  walk(root);
  return state;
}

const OWNED_MARKER_CONTENT = `name: SpecGit Acceptance\n\nruns specgit finish --json\n`;

describe('inspectManagedAssets: per-step read-only states (#308)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-inspect-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('reports a write step whose target is absent as missing', async () => {
    const desired: DesiredManagedAssets = {
      steps: [{ kind: 'write', path: 'a.txt', mode: 0o644, merge: () => 'bytes\n' }],
    };
    const inspection = await inspectManagedAssets(root, desired);
    expect(inspection.findings).toEqual([
      { path: 'a.txt', state: 'missing', code: 'asset_missing' },
    ]);
    expect(inspection.notInspected).toEqual([]);
  });

  it('reports matching bytes and mode as current, and drifted bytes as stale', async () => {
    write(root, 'same.txt', 'bytes\n');
    write(root, 'drifted.txt', 'other\n');
    const desired: DesiredManagedAssets = {
      steps: [
        { kind: 'write', path: 'same.txt', mode: 0o644, merge: () => 'bytes\n' },
        { kind: 'write', path: 'drifted.txt', mode: 0o644, merge: () => 'bytes\n' },
      ],
    };
    const inspection = await inspectManagedAssets(root, desired);
    expect(inspection.findings).toEqual([
      { path: 'same.txt', state: 'current' },
      { path: 'drifted.txt', state: 'stale', code: 'asset_stale' },
    ]);
  });

  it('reports a mode-only difference as stale — the writer chmods, so drift is not just bytes', async () => {
    const target = write(root, 'modeled.txt', 'bytes\n');
    fs.chmodSync(target, 0o755);
    const desired: DesiredManagedAssets = {
      steps: [{ kind: 'write', path: 'modeled.txt', mode: 0o644, merge: () => 'bytes\n' }],
    };
    const inspection = await inspectManagedAssets(root, desired);
    expect(inspection.findings).toEqual([{ path: 'modeled.txt', state: 'stale', code: 'asset_stale' }]);
  });

  it('makes no claim when the write resolver declines (an optional target)', async () => {
    const desired: DesiredManagedAssets = {
      steps: [{ kind: 'write', path: 'optional.txt', mode: 0o644, merge: () => null }],
    };
    const inspection = await inspectManagedAssets(root, desired);
    expect(inspection.findings).toEqual([]);
  });

  it('reports a remove step by ownership: absent no claim, owned stale, unowned conflict', async () => {
    write(root, 'owned-removal.txt', OWNED_MARKER_CONTENT);
    write(root, 'user-file.txt', 'user bytes\n');
    const desired: DesiredManagedAssets = {
      steps: [
        { kind: 'remove', path: 'absent-removal.txt', isOwned: () => true },
        {
          kind: 'remove',
          path: 'owned-removal.txt',
          isOwned: (existing) => existing.includes('SpecGit Acceptance'),
        },
        {
          kind: 'remove',
          path: 'user-file.txt',
          isOwned: (existing) => existing.includes('SpecGit Acceptance'),
        },
      ],
    };
    const inspection = await inspectManagedAssets(root, desired);
    expect(inspection.findings).toEqual([
      { path: 'owned-removal.txt', state: 'stale', code: 'asset_stale' },
      { path: 'user-file.txt', state: 'conflict', code: 'asset_conflict' },
    ]);
  });

  it('excludes portWrite steps BY KIND and never executes their closures', async () => {
    const wouldMutate = vi.fn(async (): Promise<void> => {
      throw new Error('a port write must never run during inspection');
    });
    const desired: DesiredManagedAssets = {
      steps: [
        { kind: 'portWrite', path: 'spec_git/policy.yaml', write: wouldMutate },
        { kind: 'write', path: 'a.txt', mode: 0o644, merge: () => 'bytes\n' },
      ],
    };
    const inspection = await inspectManagedAssets(root, desired);
    expect(wouldMutate).not.toHaveBeenCalled();
    expect(inspection.notInspected).toEqual(['spec_git/policy.yaml']);
    expect(inspection.findings.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('never touches the tree: bytes and modes round-trip a full inspection', async () => {
    write(root, 'AGENTS.md', '# notes\n');
    const before = treeState(root);
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, policy: samplePolicy() });
    await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    expect(treeState(root)).toEqual(before);
    expect(t.ghProvider.calls).toEqual([]);
    expect(t.recordPort.writePolicy).not.toHaveBeenCalled();
    expect(t.recordPort.writeRecord).not.toHaveBeenCalled();
  });
});

describe('inspectGeneratedAssets: surface grouping and exact fixes (#308)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-drift-');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // legacy hooks fallback
  });

  afterEach(() => {
    rmDir(root);
  });

  /** The policy seam is typed by the production Evidence<Policy>, not inferred narrow. */
  async function inspect(facts = makeGitFacts(), policy: Evidence<Policy> = POLICY_OK) {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      facts,
    });
    return inspectGeneratedAssets({ root, ctx: t.ctx, policy, facts });
  }

  it('an empty repository: init surface missing with the --force fix, setup surfaces absent and clean-listed nowhere', async () => {
    const report = await inspect();
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.state).toBe('missing');
    expect(init?.fix).toBe('specgit init --force');
    expect(init?.assets.map((a) => `${a.state}:${a.path}`)).toEqual(
      expect.arrayContaining([
        `missing:${HARNESS_WORKFLOW_PATH}`,
        'missing:AGENTS.md',
        'missing:.opencode/hooks.json',
        'missing:.opencode/hooks/specgit-merge-guard.sh',
        'missing:.git/hooks/pre-push',
        'missing:.gitignore',
      ])
    );
    for (const surface of report.surfaces.filter((s) => s.surface !== 'init')) {
      expect(surface.state).toBe('absent');
      expect(surface.fix).toBeUndefined();
      expect(surface.assets).toEqual([]);
    }
    expect(report.clean).toBe(false);
  });

  it('an empty repository without a policy suggests plain init, not --force', async () => {
    const report = await inspect(makeGitFacts(), { ok: false, code: 'policy_missing', message: 'none' });
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.state).toBe('missing');
    expect(init?.fix).toBe('specgit init');
  });

  /** Converge the fixture with the REAL writers — the report's premise is their desired state. */
  async function converge(): Promise<void> {
    // No policy yet (the memory port): plain init creates one and writes the harness.
    const initCtx = makeCtx({ root: { ok: true, value: root }, cwd: root });
    const initExit = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json', '--no-protect'],
      initCtx.ctx
    );
    expect(initExit).toBe(0);
    const setupCtx = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy({ required_checks: ['Test'] }),
    });
    const setupExit = await runCliWith(['node', 'specgit', 'setup', '--tool', 'all', '--json'], setupCtx.ctx);
    expect(setupExit).toBe(0);
  }

  it('a fixture converged by the real writers reports every surface current and clean', async () => {
    await converge();

    const report = await inspect();
    expect(report.uninspected).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.complete).toBe(true); // every desired part was claimed
    for (const surface of report.surfaces) {
      expect(surface.state, surface.surface).toBe('current');
      expect(surface.fix).toBeUndefined();
      for (const asset of surface.assets) {
        expect(asset.state, asset.path).toBe('current');
        expect(asset.code).toBeUndefined();
      }
    }
    expect(report.clean).toBe(true);
  });

  it('diagnoses an old opencode surface independently: stale entries, owned retirement, unowned conflict', async () => {
    const oldEntry = (body: string) => `---\ndescription: old\n---\n\n${ENTRY_POINT_MARKER}\n\n${body}`;
    write(root, '.opencode/command/specgit-issue.md', oldEntry('old issue trigger'));
    write(
      root,
      '.opencode/command/specgit-retired.md',
      oldEntry('an entry point this version retired')
    );
    write(root, '.opencode/command/specgit-unowned.md', '# looks like ours, is not\n');
    write(root, '.opencode/command/user-notes.md', '# user content\n');

    const report = await inspect();
    const opencode = report.surfaces.find((s) => s.surface === 'opencode');
    expect(opencode?.state).toBe('conflict'); // conflict outranks stale and missing
    expect(opencode?.fix).toBe('specgit setup --tool opencode');
    const byPath = new Map(opencode?.assets.map((a) => [a.path, a]));
    expect(byPath.get('.opencode/command/specgit-issue.md')).toMatchObject({
      state: 'stale',
      code: 'asset_stale',
    });
    expect(byPath.get('.opencode/command/specgit-retired.md')).toMatchObject({
      state: 'stale',
      code: 'asset_stale',
    });
    expect(byPath.get('.opencode/command/specgit-unowned.md')).toMatchObject({
      state: 'conflict',
      code: 'asset_conflict',
    });
    expect(byPath.get('.opencode/command/specgit-finish.md')).toMatchObject({
      state: 'missing',
      code: 'asset_missing',
    });
    // User content is never a candidate: no finding names it.
    expect(byPath.has('.opencode/command/user-notes.md')).toBe(false);
    // The other setup surface stays independently absent.
    expect(report.surfaces.find((s) => s.surface === 'generic')?.state).toBe('absent');
    expect(report.clean).toBe(false);
  });

  it('diagnoses the generic surface independently of opencode', async () => {
    write(
      root,
      '.agents/skills/specgit-issue/SKILL.md',
      `---\nname: specgit-issue\nmetadata:\n  author: specgit\n---\n\nold skill body\n`
    );
    write(
      root,
      '.agents/skills/specgit-audit/SKILL.md',
      `---\nname: specgit-audit\n---\n\n${ENTRY_POINT_MARKER}\n\nretired skill\n`
    );

    const report = await inspect();
    const generic = report.surfaces.find((s) => s.surface === 'generic');
    expect(generic?.state).toBe('missing'); // the stale pair plus four absent current skills
    expect(generic?.fix).toBe('specgit setup --tool generic');
    expect(report.surfaces.find((s) => s.surface === 'opencode')?.state).toBe('absent');
  });

  it('a declared GitLab platform desires no workflow: owned is stale, unowned is conflict, neutral assets still inspected', async () => {
    write(root, HARNESS_WORKFLOW_PATH, OWNED_MARKER_CONTENT);
    write(root, 'AGENTS.md', `# notes\n`);
    const gitlabFacts = makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' });
    write(root, 'spec_git/providers.yaml', 'gitlab:\n  host: git.ycgame.com\n  insecure_ssl: false\n');

    const report = await inspect(gitlabFacts);
    const init = report.surfaces.find((s) => s.surface === 'init');
    const workflow = init?.assets.find((a) => a.path === HARNESS_WORKFLOW_PATH);
    expect(workflow).toEqual({ path: HARNESS_WORKFLOW_PATH, state: 'stale', code: 'asset_stale' });
    expect(init?.fix).toBe('specgit init --force');
    expect(report.uninspected).not.toContain('workflow_platform_undecided');

    // Unowned bytes at the managed workflow path: a conflict, never a removal claim.
    fs.writeFileSync(path.join(root, ...HARNESS_WORKFLOW_PATH.split('/')), 'name: My own\n');
    const conflictReport = await inspect(gitlabFacts);
    const conflict = conflictReport.surfaces
      .find((s) => s.surface === 'init')
      ?.assets.find((a) => a.path === HARNESS_WORKFLOW_PATH);
    expect(conflict).toEqual({
      path: HARNESS_WORKFLOW_PATH,
      state: 'conflict',
      code: 'asset_conflict',
    });
  });

  it('an undecided platform makes no workflow claim instead of a false one', async () => {
    write(root, HARNESS_WORKFLOW_PATH, OWNED_MARKER_CONTENT);
    const undecidedFacts = makeGitFacts({ originUrl: 'https://git.example.com/o/r.git' });
    const report = await inspect(undecidedFacts);
    expect(report.uninspected).toContain('workflow_platform_undecided');
    expect(report.complete).toBe(false); // an unknown desired part fails completeness closed
    expect(report.clean).toBe(false); // ...and can never be called clean
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.assets.find((a) => a.path === HARNESS_WORKFLOW_PATH)).toBeUndefined();
    // Platform-neutral assets are still inspected.
    expect(init?.assets.find((a) => a.path === 'AGENTS.md')).toMatchObject({ state: 'missing' });
  });

  it('invalid providers bytes refuse platform classification even on a github.com origin (#308 Delta 2)', async () => {
    await converge();
    // Invalid YAML in the authoritative declaration: the platform is
    // unknowable — old bug: classification fell through to the origin
    // heuristic, claimed the GitHub workflow current, and reported
    // complete/clean over unreadable declaration bytes.
    write(root, 'spec_git/providers.yaml', 'gitlab: [unclosed\n');
    const report = await inspect(); // default facts: github.com origin
    expect(report.uninspected).toEqual(['workflow_platform_providers_invalid']);
    expect(report.complete).toBe(false);
    expect(report.clean).toBe(false);
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.assets.find((a) => a.path === HARNESS_WORKFLOW_PATH)).toBeUndefined();
    // Every claim that WAS made is still current — incompleteness is the
    // only defect, and the platform-neutral assets stay inspected.
    expect(init?.assets.find((a) => a.path === 'AGENTS.md')).toMatchObject({ state: 'current' });
  });

  it('a shape-invalid providers declaration fails closed the same way', async () => {
    // Parses as YAML but violates the schema: host must be bare.
    write(root, 'spec_git/providers.yaml', 'gitlab:\n  host: https://git.example.com\n');
    const report = await inspect();
    expect(report.uninspected).toContain('workflow_platform_providers_invalid');
    expect(report.complete).toBe(false);
    expect(report.clean).toBe(false);
    expect(
      report.surfaces.find((s) => s.surface === 'init')?.assets.find((a) => a.path === HARNESS_WORKFLOW_PATH)
    ).toBeUndefined();
  });

  it('a missing providers file is the optional case: the GitHub heuristic path stays complete and clean', async () => {
    await converge();
    // spec_git/providers.yaml does not exist and never needed to: the file
    // is optional, the github.com origin heuristic classifies, and a fully
    // current report remains complete/clean (no over-failing).
    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);
    const report = await inspect();
    expect(report.uninspected).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.clean).toBe(true);
  });

  it('a providers read that throws fails closed: the inspection itself is unavailable, never an origin guess', async () => {
    // A directory at the providers path: readProviders rethrows EISDIR —
    // the error propagates and status renders asset_inspection_failed with
    // NO generated report (the existing fail-closed seam, exit unchanged).
    fs.mkdirSync(path.join(root, 'spec_git', 'providers.yaml'), { recursive: true });
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, policy: samplePolicy() });
    await expect(
      inspectGeneratedAssets({ root, ctx: t.ctx, policy: POLICY_OK, facts: makeGitFacts() })
    ).rejects.toThrow();
  });

  it('an unmergeable hooks.json is a no-claim code, not a guessed state', async () => {
    write(root, '.opencode/hooks.json', 'not json at all');
    const report = await inspect();
    expect(report.uninspected).toContain('hooks_json_unmerged');
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.assets.find((a) => a.path === '.opencode/hooks.json')).toBeUndefined();
  });

  it('a committed-authoritative repository with no ignore region opts out: no false missing claim', async () => {
    write(root, 'spec_git/policy.yaml', 'version: 1\nrequired_checks: []\n');
    write(root, '.gitignore', 'node_modules/\n');
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      gitWrites: {
        trackedFiles: (paths) => ({ ok: true, value: paths }),
      },
    });
    const report = await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    expect(report.skipped).toContain('ignore_committed_authoritative');
    expect(report.uninspected).not.toContain('ignore_committed_authoritative');
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.assets.find((a) => a.path === '.gitignore')).toBeUndefined();
  });

  it('a repository with a managed ignore region keeps it inspected even when authoritative files are tracked', async () => {
    write(
      root,
      '.gitignore',
      'node_modules/\n# >>> specgit: local delivery assets (managed by specgit init) >>>\n/.specgit.yaml\n# <<< specgit: local delivery assets (managed by specgit init) <<<\n'
    );
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      gitWrites: {
        trackedFiles: (paths) => ({ ok: true, value: paths }),
      },
    });
    const report = await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    expect(report.uninspected).not.toContain('ignore_committed_authoritative');
    const gitignore = report.surfaces
      .find((s) => s.surface === 'init')
      ?.assets.find((a) => a.path === '.gitignore');
    expect(gitignore).toMatchObject({ state: 'stale', code: 'asset_stale' }); // region predates the /spec_git/ entry
  });

  it('a failed tracked probe refuses to claim the ignore region', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      gitWrites: {
        trackedFiles: () => ({
          ok: false,
          code: 'tracked_probe_failed',
          message: 'git ls-files failed',
        }),
      },
    });
    const report = await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    expect(report.uninspected).toContain('ignore_tracked_unknown');
    expect(report.skipped).toEqual([]); // a failed probe is unknown, never a proven skip
    expect(report.complete).toBe(false);
    expect(report.clean).toBe(false);
  });

  it('an unreadable .gitignore (EISDIR) is an unknown, never the committed-authoritative skip (#308 Delta 2)', async () => {
    await converge();
    // The tracked-authoritative precondition that used to expose the false
    // skip, plus unreadable local evidence: `.gitignore` is a DIRECTORY, so
    // readFile fails EISDIR (deterministic on POSIX).
    fs.rmSync(path.join(root, '.gitignore'));
    fs.mkdirSync(path.join(root, '.gitignore'));
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      gitWrites: {
        trackedFiles: (paths) => ({ ok: true, value: paths }),
      },
    });
    const before = treeState(root);
    const report = await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    // Old bug: the read error collapsed to "absent", so the tracked tier
    // turned it into the proven skip — complete/clean despite evidence
    // status never even read.
    expect(report.skipped).toEqual([]);
    expect(report.uninspected).toContain('ignore_unreadable');
    expect(report.complete).toBe(false);
    expect(report.clean).toBe(false);
    expect(
      report.surfaces.find((s) => s.surface === 'init')?.assets.find((a) => a.path === '.gitignore')
    ).toBeUndefined();
    // Read-only still holds: the unreadable path is left exactly as-is.
    expect(treeState(root)).toEqual(before);
  });

  it('completeness fails closed: a converged fixture under an undecided platform has every claimed asset current yet is not clean', async () => {
    await converge();
    const undecidedFacts = makeGitFacts({ originUrl: 'https://git.example.com/o/r.git' });
    const report = await inspect(undecidedFacts);
    expect(report.uninspected).toEqual(['workflow_platform_undecided']);
    expect(report.complete).toBe(false);
    expect(report.clean).toBe(false); // "no detected drift" is not "proven clean"
    // Every claim that WAS made is current — incompleteness is the only defect.
    for (const surface of report.surfaces) {
      for (const asset of surface.assets) {
        expect(asset.state, asset.path).toBe('current');
      }
    }
  });

  it('an unresolvable remote default branch leaves the workflow unclaimed and the report incomplete', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      gitWrites: {
        remoteDefaultBranch: () => ({
          ok: false,
          code: 'default_branch_unresolved',
          message: 'origin/HEAD points nowhere',
        }),
      },
    });
    const report = await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    expect(report.uninspected).toContain('workflow_default_branch_unresolved');
    expect(report.complete).toBe(false);
    expect(report.clean).toBe(false);
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.assets.find((a) => a.path === HARNESS_WORKFLOW_PATH)).toBeUndefined();
  });

  it('the committed-authoritative ignore opt-out is a proven skip: a fully current report stays complete and clean', async () => {
    await converge();
    // This adopter chose the committed-authoritative model: the managed
    // ignore region is gone and the authoritative tier is tracked.
    write(root, '.gitignore', 'node_modules/\n');
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      policy: samplePolicy(),
      gitWrites: {
        trackedFiles: (paths) => ({ ok: true, value: paths }),
      },
    });
    const report = await inspectGeneratedAssets({
      root,
      ctx: t.ctx,
      policy: POLICY_OK,
      facts: makeGitFacts(),
    });
    expect(report.skipped).toEqual(['ignore_committed_authoritative']);
    expect(report.uninspected).toEqual([]);
    expect(report.complete).toBe(true); // an intentional, proven skip never makes it incomplete
    expect(report.clean).toBe(true); // ...and an otherwise current report stays clean
    const init = report.surfaces.find((s) => s.surface === 'init');
    expect(init?.assets.find((a) => a.path === '.gitignore')).toBeUndefined();
  });

  it('human rendering: machine parts verbatim, localized labels via the catalog', async () => {
    write(root, '.opencode/command/specgit-issue.md', `---\ndescription: old\n---\n\n${ENTRY_POINT_MARKER}\n\nold\n`);
    const report = await inspect();
    const en = renderGeneratedAssetsHuman(report, catalogFor('en').human);
    expect(en.some((line) => line.includes('specgit setup --tool opencode'))).toBe(true);
    expect(en.some((line) => line.includes('conflict .opencode/command/specgit-issue.md') || line.includes('stale .opencode/command/specgit-issue.md'))).toBe(true);
    const zh = renderGeneratedAssetsHuman(report, catalogFor('zh').human);
    expect(zh.some((line) => line.includes('specgit setup --tool opencode'))).toBe(true);
    // A clean report renders the current line; proven skips follow it.
    const cleanReport: GeneratedAssetsReport = {
      clean: true,
      complete: true,
      surfaces: [
        { surface: 'init', state: 'current', assets: [] },
        { surface: 'opencode', state: 'absent', assets: [] },
      ],
      uninspected: [],
      skipped: ['ignore_committed_authoritative'],
    };
    expect(renderGeneratedAssetsHuman(cleanReport, catalogFor('en').human)).toEqual([
      catalogFor('en').human.statusAssetsCurrent(),
      catalogFor('en').human.statusAssetSkipped('ignore_committed_authoritative'),
    ]);
    // An incomplete report never renders the current claim — its own state line.
    const incompleteReport: GeneratedAssetsReport = {
      clean: false,
      complete: false,
      surfaces: [{ surface: 'init', state: 'current', assets: [] }],
      uninspected: ['workflow_platform_undecided'],
      skipped: [],
    };
    const incompleteEn = renderGeneratedAssetsHuman(incompleteReport, catalogFor('en').human);
    expect(incompleteEn).toEqual([
      catalogFor('en').human.statusAssetsIncomplete(),
      catalogFor('en').human.statusAssetUninspected('workflow_platform_undecided'),
    ]);
    expect(incompleteEn).not.toContain(catalogFor('en').human.statusAssetsCurrent());
    const incompleteZh = renderGeneratedAssetsHuman(incompleteReport, catalogFor('zh').human);
    expect(incompleteZh).toEqual([
      catalogFor('zh').human.statusAssetsIncomplete(),
      catalogFor('zh').human.statusAssetUninspected('workflow_platform_undecided'),
    ]);
    expect(incompleteZh).not.toContain(catalogFor('zh').human.statusAssetsCurrent());
  });
});

describe('the generated report shape is typed and pinned (#308)', () => {
  it('a full report assigns to the documented shape and the status assets area', () => {
    const report: GeneratedAssetsReport = {
      clean: false,
      complete: false,
      surfaces: [
        {
          surface: 'init',
          state: 'stale',
          fix: 'specgit init --force',
          assets: [{ path: 'AGENTS.md', state: 'stale', code: 'asset_stale' }],
        },
        {
          surface: 'opencode',
          state: 'conflict',
          fix: 'specgit setup --tool opencode',
          assets: [
            { path: '.opencode/command/specgit-unowned.md', state: 'conflict', code: 'asset_conflict' },
          ],
        },
        { surface: 'generic', state: 'absent', assets: [] },
      ],
      uninspected: ['workflow_platform_undecided'],
      skipped: ['ignore_committed_authoritative'],
    };
    const outcome: StatusOutcome = { exit: 0, assets: { generated: report } };
    expect(outcome.assets?.generated).toBe(report);
  });

  it('rejects shape drift at compile time', () => {
    // @ts-expect-error 'drift' is not a surface state
    const badState: GeneratedAssetsReport = { clean: true, complete: true, surfaces: [{ surface: 'init', state: 'drift', assets: [] }], uninspected: [], skipped: [] };
    // @ts-expect-error a fix must be one of the exact repair commands
    const badFix: GeneratedAssetsReport = { clean: false, complete: true, surfaces: [{ surface: 'init', state: 'stale', fix: 'specgit regenerate', assets: [] }], uninspected: [], skipped: [] };
    // @ts-expect-error 'absent' is a surface state, not an asset state
    const badAsset: GeneratedAssetsReport = { clean: true, complete: true, surfaces: [{ surface: 'init', state: 'current', assets: [{ path: 'x', state: 'absent' }] }], uninspected: [], skipped: [] };
    // @ts-expect-error `complete` is required — clean without completeness is the hidden-evidence bug
    const missingComplete: GeneratedAssetsReport = { clean: true, surfaces: [], uninspected: [], skipped: [] };
    // @ts-expect-error `skipped` is required — intentional opt-outs stay machine-visible
    const missingSkipped: GeneratedAssetsReport = { clean: true, complete: true, surfaces: [], uninspected: [] };
    expect(badState).toBeDefined();
    expect(badFix).toBeDefined();
    expect(badAsset).toBeDefined();
    expect(missingComplete).toBeDefined();
    expect(missingSkipped).toBeDefined();
  });
});
