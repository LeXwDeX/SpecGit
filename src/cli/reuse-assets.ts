import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ReuseWorkflowPathSchema, type ReuseProfile } from '../verification/reuse-profile.js';
import { githubReuseWorkflow, gitlabReuseWorkflow } from '../verification/reuse-workflow.js';
import { buildGitlabRoutingSteps, isSpecGitOwnedGitlabRouting } from './gitlab-routing.js';
import { GITLAB_BUSINESS_WORKFLOW_PATH } from './completion-workflow.js';
import type { ManagedStep } from './managed-reconcile.js';

/** A derived retirement index, never execution or acceptance authority. */
export const REUSE_ASSET_MANIFEST = 'spec_git/generated-verification.json';
const manifestSchema = z.object({ managed_by: z.literal('specgit-verification'), version: z.literal(1),
  paths: z.array(ReuseWorkflowPathSchema).max(30),
}).strict();
export const isOwnedReuseWorkflow = (content: string): boolean => /^# Managed by SpecGit: verified-input execution\.\r?\n/.test(content);
const isOwnedManifest = (content: string): boolean => {
  try { return manifestSchema.safeParse(JSON.parse(content)).success; } catch { return false; }
};

async function readLocal(root: string, relative: string): Promise<string | null> {
  const parts = relative.split('/');
  for (let count = 1; count <= parts.length; count++) {
    const target = path.join(root, ...parts.slice(0, count));
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) return null;
    if (stat.isSymbolicLink() || (count < parts.length ? !stat.isDirectory() : !stat.isFile()) || stat.size > 1_000_000) {
      throw new Error(`Cannot safely inspect generated verification asset ${relative}.`);
    }
  }
  return readFile(path.join(root, relative), 'utf8');
}

/** Only a valid derived manifest can nominate previously generated assets. */
async function previousPaths(root: string): Promise<string[] | null> {
  const manifest = await readLocal(root, REUSE_ASSET_MANIFEST);
  if (manifest !== null && !isOwnedManifest(manifest)) throw new Error('Preserve the conflicting generated-verification manifest before refreshing the harness.');
  return manifest === null ? null : manifestSchema.parse(JSON.parse(manifest)).paths;
}

/** Declared and retiring remote harness assets; ordinary project CI is outside this set. */
export async function reuseRemoteAssetPaths(root: string, profiles: ReuseProfile[]): Promise<Set<string>> {
  return new Set([REUSE_ASSET_MANIFEST, ...(await previousPaths(root) ?? []),
    ...profiles.flatMap((profile) => [
      ...(profile.github ? [profile.github.entry] : []),
      ...(profile.gitlab ? [profile.gitlab.entry, GITLAB_BUSINESS_WORKFLOW_PATH] : []),
    ]),
  ]);
}

/** Plan workflow generation, completion composition and ownership-proven retirement together. */
export async function buildReuseAssetSteps(root: string, options: {
  platform: 'github' | 'gitlab'; profiles: ReuseProfile[]; routingYaml: string | null;
}): Promise<ManagedStep[]> {
  const previous = await previousPaths(root);
  const desired = new Map<string, string>();
  const gitlab = options.platform === 'gitlab' ? options.profiles.filter((profile) => profile.gitlab) : [];
  for (const profile of options.profiles) {
    if (options.platform === 'github' && profile.github) desired.set(profile.github.entry, githubReuseWorkflow(profile));
  }
  if (gitlab.length) {
    const entries = new Set(gitlab.map((profile) => profile.gitlab!.entry));
    if (entries.size !== 1) throw new Error('All reusable GitLab profiles must share one CI entry.');
    const entry = [...entries][0];
    if (options.routingYaml !== null && entry !== '.gitlab-ci.yml') throw new Error('Automatic completion requires the standard GitLab root entry.');
    const current = await readLocal(root, entry);
    if (current !== null && isSpecGitOwnedGitlabRouting(current)) {
      const business = await readLocal(root, GITLAB_BUSINESS_WORKFLOW_PATH);
      if (business === null || !isOwnedReuseWorkflow(business)) throw new Error('Preserve the existing business workflow; it is not owned by the verification integration.');
    }
    desired.set(options.routingYaml === null ? entry : GITLAB_BUSINESS_WORKFLOW_PATH, gitlabReuseWorkflow(gitlab));
    if (options.routingYaml !== null) desired.set(entry, options.routingYaml);
  }
  let routing: ManagedStep[] = [];
  if (!gitlab.length) {
    if (options.routingYaml !== null && previous?.includes(GITLAB_BUSINESS_WORKFLOW_PATH)) {
      throw new Error('Completion still requires business CI. Replace the managed verification business workflow before removing its last profile.');
    }
    if (!previous?.includes('.gitlab-ci.yml')) routing = await buildGitlabRoutingSteps(root, options.routingYaml);
  }
  const owned = (content: string) => isOwnedReuseWorkflow(content) || isSpecGitOwnedGitlabRouting(content);
  const steps: ManagedStep[] = [...routing];
  for (const [file, content] of desired) steps.push({ kind: 'write', path: file, mode: 0o644, isOwned: owned, merge: () => content });
  const retained = new Set([...desired.keys(), ...routing.map((step) => step.path)]);
  for (const file of new Set(previous ?? [])) {
    if (!retained.has(file) && file !== REUSE_ASSET_MANIFEST) steps.push({ kind: 'remove', path: file, isOwned: owned });
  }
  if (desired.size) {
    const content = JSON.stringify({ managed_by: 'specgit-verification', version: 1, paths: [...desired.keys()].sort() }, null, 2) + '\n';
    steps.push({ kind: 'write', path: REUSE_ASSET_MANIFEST, mode: 0o644, isOwned: isOwnedManifest, merge: () => content });
  } else if (previous !== null) steps.push({ kind: 'remove', path: REUSE_ASSET_MANIFEST, isOwned: isOwnedManifest });
  return steps;
}
