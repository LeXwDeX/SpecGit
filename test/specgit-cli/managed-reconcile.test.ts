/**
 * Managed-asset reconciliation module (#305), tested through its interface
 * on real temporary filesystems: desired state in (writes with pure merge
 * resolvers, port writes, ownership-proven removals), one reversible
 * transaction out, structured report back. The filesystem stays inside the
 * module — these tests never mock it, they seed real trees.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ManagedReconcileError,
  reconcileManagedAssets,
  restoreManagedSnapshot,
  snapshotManagedFile,
  type ManagedStep,
} from '../../src/cli/managed-reconcile.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

function read(target: string): string {
  return fs.readFileSync(target, 'utf-8');
}

function modeOf(target: string): number {
  return fs.statSync(target).mode;
}

const rel = (root: string, target: string): string => path.relative(root, target);

describe('reconcileManagedAssets', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-reconcile-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('classifies create/update/unchanged and reports repo-relative paths', async () => {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'current\n');
    fs.chmodSync(path.join(root, 'keep.txt'), 0o644); // umask-independent
    fs.writeFileSync(path.join(root, 'drift.txt'), 'old bytes\n');
    const steps: ManagedStep[] = [
      { kind: 'write', path: 'nested/new.txt', mode: 0o644, merge: () => 'fresh\n' },
      { kind: 'write', path: 'drift.txt', mode: 0o644, merge: () => 'current\n' },
      { kind: 'write', path: 'keep.txt', mode: 0o644, merge: () => 'current\n' },
    ];

    const report = await reconcileManagedAssets(root, { steps });

    expect(report.created).toEqual(['nested/new.txt']);
    expect(report.updated).toEqual(['drift.txt']);
    expect(report.removed).toEqual([]);
    expect(report.preserved).toEqual([]);
    expect(read(path.join(root, 'nested', 'new.txt'))).toBe('fresh\n');
    expect(read(path.join(root, 'drift.txt'))).toBe('current\n');
  });

  it('treats a mode drift as an update: desired state includes the mode', async () => {
    const target = path.join(root, 'guard.sh');
    fs.writeFileSync(target, 'body\n');
    fs.chmodSync(target, 0o644);

    const report = await reconcileManagedAssets(root, {
      steps: [{ kind: 'write', path: 'guard.sh', mode: 0o755, merge: () => 'body\n' }],
    });

    expect(report.updated).toEqual(['guard.sh']);
    expect(modeOf(target) & 0o777).toBe(0o755);
  });

  it('plans no write when the merge resolver returns null (merge refused)', async () => {
    fs.writeFileSync(path.join(root, 'user.json'), '{ "user": true }\n');
    const before = read(path.join(root, 'user.json'));

    const report = await reconcileManagedAssets(root, {
      steps: [{ kind: 'write', path: 'user.json', mode: 0o644, merge: () => null }],
    });

    expect(read(path.join(root, 'user.json'))).toBe(before);
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    // A refused merge is not a preserved conflict: it is surfaced by the
    // caller (its resolver knows the reason); the report stays factual.
    expect(report.preserved).toEqual([]);
  });

  it('removes an ownership-proven obsolete asset and prunes the dirs it emptied', async () => {
    const workflowPath = path.join(root, '.github', 'workflows', 'specgit-accept.yml');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'name: SpecGit Acceptance\n');
    const sibling = path.join(root, '.github', 'workflows', 'ci.yml');
    fs.writeFileSync(sibling, 'name: CI\n');

    const report = await reconcileManagedAssets(root, {
      steps: [
        { kind: 'remove', path: '.github/workflows/specgit-accept.yml', isOwned: () => true },
      ],
    });

    expect(report.removed).toEqual(['.github/workflows/specgit-accept.yml']);
    expect(fs.existsSync(workflowPath)).toBe(false);
    // Only the dirs the removal emptied disappear; the sibling keeps its tree.
    expect(fs.existsSync(path.join(root, '.github', 'workflows'))).toBe(true);
    expect(read(sibling)).toBe('name: CI\n');
  });

  it('prunes every dir a removal emptied, up to the root', async () => {
    const workflowPath = path.join(root, '.github', 'workflows', 'specgit-accept.yml');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'name: SpecGit Acceptance\n');

    await reconcileManagedAssets(root, {
      steps: [{ kind: 'remove', path: '.github/workflows/specgit-accept.yml', isOwned: () => true }],
    });

    expect(fs.existsSync(path.join(root, '.github'))).toBe(false);
  });

  it('preserves an obsolete asset when ownership is not proven, and reports it', async () => {
    const workflowPath = path.join(root, '.github', 'workflows', 'specgit-accept.yml');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'name: Someone Else\n');

    const report = await reconcileManagedAssets(root, {
      steps: [
        { kind: 'remove', path: '.github/workflows/specgit-accept.yml', isOwned: () => false },
      ],
    });

    expect(report.removed).toEqual([]);
    expect(report.preserved).toEqual(['.github/workflows/specgit-accept.yml']);
    expect(read(workflowPath)).toBe('name: Someone Else\n');
  });

  it('an already-absent removal target is a no-op, not a preserved conflict', async () => {
    const report = await reconcileManagedAssets(root, {
      steps: [{ kind: 'remove', path: '.github/workflows/specgit-accept.yml', isOwned: () => true }],
    });
    expect(report.removed).toEqual([]);
    expect(report.preserved).toEqual([]);
  });

  it('rolls the whole transaction back when a later write fails', async () => {
    const existing = path.join(root, 'existing.txt');
    fs.writeFileSync(existing, 'user bytes\n');
    fs.chmodSync(existing, 0o600);
    // A regular file where a directory is needed: the LAST write fails after
    // earlier steps already mutated the tree.
    fs.writeFileSync(path.join(root, 'blocker'), 'not a directory');

    let caught: unknown;
    try {
      await reconcileManagedAssets(root, {
        steps: [
          { kind: 'write', path: 'existing.txt', mode: 0o644, merge: () => 'specgit bytes\n' },
          { kind: 'write', path: 'nested/deep/file.txt', mode: 0o644, merge: () => 'x\n' },
          { kind: 'write', path: 'blocker/child.txt', mode: 0o644, merge: () => 'never\n' },
        ],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ManagedReconcileError);
    expect((caught as ManagedReconcileError).phase).toBe('commit');
    expect((caught as ManagedReconcileError).step?.path).toBe('blocker/child.txt');
    // Prior mutations round-trip: bytes and mode of the rewritten file…
    expect(read(existing)).toBe('user bytes\n');
    expect(modeOf(existing) & 0o777).toBe(0o600);
    // …and every path this run created is gone, including directories.
    expect(fs.existsSync(path.join(root, 'nested'))).toBe(false);
  });

  it('rolls back a removed file too: deletes are inside the transaction', async () => {
    const owned = path.join(root, '.github', 'workflows', 'specgit-accept.yml');
    fs.mkdirSync(path.dirname(owned), { recursive: true });
    fs.writeFileSync(owned, 'name: SpecGit Acceptance\n');
    fs.writeFileSync(path.join(root, 'blocker'), 'not a directory');

    let caught: unknown;
    try {
      await reconcileManagedAssets(root, {
        steps: [
          { kind: 'remove', path: '.github/workflows/specgit-accept.yml', isOwned: () => true },
          { kind: 'write', path: 'blocker/child.txt', mode: 0o644, merge: () => 'never\n' },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManagedReconcileError);
    // The removed owned asset comes back byte-identically.
    expect(read(owned)).toBe('name: SpecGit Acceptance\n');
  });

  it('wraps an owned port write: snapshot, classification, rollback', async () => {
    const policyPath = path.join(root, 'spec_git', 'policy.yaml');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, 'version: 1\nrequired_checks: [Old]\n');

    const report = await reconcileManagedAssets(root, {
      steps: [
        {
          kind: 'portWrite',
          path: 'spec_git/policy.yaml',
          write: async () => {
            fs.writeFileSync(policyPath, 'version: 1\nrequired_checks: [New]\n');
          },
        },
      ],
    });

    expect(report.updated).toEqual(['spec_git/policy.yaml']);
    expect(report.created).toEqual([]);
    expect(read(policyPath)).toBe('version: 1\nrequired_checks: [New]\n');

    // A port write that lands identical bytes is not an update.
    const stable = await reconcileManagedAssets(root, {
      steps: [
        {
          kind: 'portWrite',
          path: 'spec_git/policy.yaml',
          write: async () => {
            fs.writeFileSync(policyPath, 'version: 1\nrequired_checks: [New]\n');
          },
        },
      ],
    });
    expect(stable.updated).toEqual([]);
    expect(stable.created).toEqual([]);

    // A failing later step restores the port-written file's prior bytes.
    fs.writeFileSync(path.join(root, 'blocker'), 'not a directory');
    let caught: unknown;
    try {
      await reconcileManagedAssets(root, {
        steps: [
          {
            kind: 'portWrite',
            path: 'spec_git/policy.yaml',
            write: async () => {
              fs.writeFileSync(policyPath, 'version: 1\nrequired_checks: [Rewritten]\n');
            },
          },
          { kind: 'write', path: 'blocker/child.txt', mode: 0o644, merge: () => 'never\n' },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManagedReconcileError);
    expect(read(policyPath)).toBe('version: 1\nrequired_checks: [New]\n');
  });

  it('classifies a port write that creates its target', async () => {
    const report = await reconcileManagedAssets(root, {
      steps: [
        {
          kind: 'portWrite',
          path: 'spec_git/policy.yaml',
          write: async () => {
            const target = path.join(root, 'spec_git', 'policy.yaml');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, 'version: 1\n');
          },
        },
      ],
    });
    expect(report.created).toEqual(['spec_git/policy.yaml']);
  });

  it('a plan-phase failure (resolver throws) writes nothing', async () => {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'user bytes\n');
    const before = read(path.join(root, 'existing.txt'));

    let caught: unknown;
    try {
      await reconcileManagedAssets(root, {
        steps: [
          {
            kind: 'write',
            path: 'existing.txt',
            mode: 0o644,
            merge: () => {
              throw new Error('resolver exploded');
            },
          },
          { kind: 'write', path: 'fresh.txt', mode: 0o644, merge: () => 'x\n' },
        ],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ManagedReconcileError);
    expect((caught as ManagedReconcileError).phase).toBe('plan');
    expect((caught as ManagedReconcileError).message).toContain('resolver exploded');
    expect(read(path.join(root, 'existing.txt'))).toBe(before);
    expect(fs.existsSync(path.join(root, 'fresh.txt'))).toBe(false);
  });

  it('is idempotent: a converged second run plans no writes at all', async () => {
    // Deterministic desired bytes: whatever exists, the resolver wants
    // exactly `managed\n` — the second run must find nothing to do.
    const steps: ManagedStep[] = [
      { kind: 'write', path: 'managed.txt', mode: 0o644, merge: () => 'managed\n' },
    ];
    await reconcileManagedAssets(root, { steps });
    const firstBytes = read(path.join(root, 'managed.txt'));

    const report = await reconcileManagedAssets(root, { steps });

    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(read(path.join(root, 'managed.txt'))).toBe(firstBytes);
  });

  it('a snapshot taken before the target existed restores by removing file AND directory chain', async () => {
    // Snapshot, then the run creates the whole chain and the file. The
    // restore must return the COMPLETE tree: unlink the file and prune
    // every directory this run created, deepest-first up to the root.
    const shot = await snapshotManagedFile(root, 'spec_git/providers.yaml');
    fs.mkdirSync(path.join(root, 'spec_git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'spec_git', 'providers.yaml'), 'gitlab:\n');

    await restoreManagedSnapshot(shot);

    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'spec_git'))).toBe(false);
  });

  it('a restore prunes several created directory levels, up to the root', async () => {
    const shot = await snapshotManagedFile(root, '.config/specgit/deep/managed.yaml');
    fs.mkdirSync(path.join(root, '.config', 'specgit', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.config', 'specgit', 'deep', 'managed.yaml'), 'x\n');

    await restoreManagedSnapshot(shot);

    expect(fs.existsSync(path.join(root, '.config'))).toBe(false);
  });

  it('a restore never prunes a directory that picked up user content', async () => {
    const shot = await snapshotManagedFile(root, 'spec_git/providers.yaml');
    fs.mkdirSync(path.join(root, 'spec_git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'spec_git', 'providers.yaml'), 'gitlab:\n');
    fs.writeFileSync(path.join(root, 'spec_git', 'user-notes.txt'), 'user\n');

    await restoreManagedSnapshot(shot);

    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);
    expect(read(path.join(root, 'spec_git', 'user-notes.txt'))).toBe('user\n');
    expect(fs.existsSync(path.join(root, 'spec_git'))).toBe(true);
  });

  it('a restore of a file that pre-existed puts its bytes, mode, and directory back', async () => {
    const target = path.join(root, 'spec_git', 'providers.yaml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# team config\n');
    fs.chmodSync(target, 0o600);
    const shot = await snapshotManagedFile(root, 'spec_git/providers.yaml');
    // The run rewrites the file, and a later cleanup loses the directory.
    fs.rmSync(path.join(root, 'spec_git'), { recursive: true, force: true });

    await restoreManagedSnapshot(shot);

    expect(read(target)).toBe('# team config\n');
    expect(modeOf(target) & 0o777).toBe(0o600);
  });
});
