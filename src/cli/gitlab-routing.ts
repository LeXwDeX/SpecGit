import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { GITLAB_BUSINESS_WORKFLOW_PATH, GITLAB_COMPLETION_WORKFLOW_PATH } from './completion-workflow.js';
import type { ManagedStep } from './managed-reconcile.js';

export const GITLAB_ROUTING_PATH = '.gitlab-ci.yml';
const ROUTING_MARKER = '# Managed by SpecGit: isolated GitLab routing.';
const RESERVED = new Set([GITLAB_ROUTING_PATH, GITLAB_BUSINESS_WORKFLOW_PATH, GITLAB_COMPLETION_WORKFLOW_PATH]);

export class GitlabRoutingError extends Error {
  readonly code = 'gitlab_ci_unsupported';
}

export function isSpecGitOwnedGitlabRouting(content: string): boolean {
  return content.startsWith(`${ROUTING_MARKER}\n`) || content.startsWith(`${ROUTING_MARKER}\r\n`);
}

interface LocalFile { content: string; mode: number }

/** Every component stays inside this repository; symlinks cannot redirect writes or includes. */
async function readLocal(root: string, relative: string): Promise<LocalFile | null> {
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const target = path.join(root, ...parts.slice(0, index));
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) return null;
    if (stat.isSymbolicLink() || (index < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new GitlabRoutingError(`Cannot safely route ${relative}: every path component must be an ordinary local file or directory.`);
    }
    if (index === parts.length) {
      if (stat.size > 1_000_000) throw new GitlabRoutingError(`Cannot safely inspect ${relative}: CI files must be at most 1 MB.`);
      const bytes = await fs.readFile(target);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) throw new GitlabRoutingError(`${relative} is not UTF-8 CI configuration.`);
      return { content, mode: stat.mode & 0o777 };
    }
  }
  return null;
}

function localInclude(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== 'local' && key !== 'rules')) {
      throw new GitlabRoutingError('Only static local includes without inputs can be safely moved.');
    }
    value = entry.local;
  }
  if (typeof value !== 'string' || value.length === 0 || /[$*?\[\]{}:\\\p{Cc}]/u.test(value) || value.startsWith('//')) {
    throw new GitlabRoutingError('Only static local include paths can be safely moved; dynamic, external and glob includes are unsupported.');
  }
  const relative = path.posix.normalize(value.replace(/^\//, ''));
  if (relative === '..' || relative.startsWith('../') || RESERVED.has(relative)) {
    throw new GitlabRoutingError(`The local include ${value} escapes or references a managed routing file.`);
  }
  return relative;
}

/** GitLab resolves local includes from the project root, including nested includes. */
async function validateBusiness(root: string, content: string): Promise<void> {
  const visited = new Set<string>();
  let ordinaryJob = false;
  const visit = async (name: string, bytes: string, ancestors: Set<string>): Promise<void> => {
    if (ancestors.has(name)) throw new GitlabRoutingError(`Cyclic local CI include: ${name}.`);
    if (visited.has(name)) return;
    if (visited.size >= 64 || ancestors.size >= 16) throw new GitlabRoutingError('The local CI include tree exceeds the bounded inspection limit.');
    visited.add(name);
    const document = parseDocument(bytes);
    if (document.errors.length > 0) throw new GitlabRoutingError(`Cannot safely parse ${name}: ${document.errors[0].message}`);
    const config: unknown = document.toJS({ maxAliasCount: 100 });
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new GitlabRoutingError(`${name} must contain one CI configuration mapping.`);
    }
    const mapping = config as Record<string, unknown>;
    if (Object.hasOwn(mapping, 'spec') || Object.hasOwn(mapping, 'specgit-request-completion')) {
      throw new GitlabRoutingError(`${name} contains pipeline inputs or the reserved specgit-request-completion job.`);
    }
    const workflow = mapping.workflow as { rules?: Array<{ if?: string; when?: string }> } | undefined;
    const firstRule = Array.isArray(workflow?.rules) ? workflow.rules[0] : undefined;
    if (firstRule?.when === 'never' && (firstRule.if === undefined ||
      /^\s*\$CI_PIPELINE_SOURCE\s*==\s*['"]merge_request_event['"]\s*$/.test(firstRule.if))) {
      throw new GitlabRoutingError(`${name} explicitly prevents merge-request pipelines; permit the required MR pipeline in the business workflow before enabling completion.`);
    }
    for (const [jobName, rawJob] of Object.entries(mapping)) {
      if (jobName.startsWith('.') || rawJob === null || typeof rawJob !== 'object' || Array.isArray(rawJob)) continue;
      const job = rawJob as Record<string, unknown>;
      if (!['script', 'trigger', 'run', 'extends'].some((key) => Object.hasOwn(job, key)) || job.stage === '.pre' || job.stage === '.post') continue;
      if (Array.isArray(job.rules) && job.rules.every((rule: { when?: string } | null) => rule?.when === 'never')) continue;
      ordinaryJob = true;
    }
    const includes = mapping.include === undefined ? [] : Array.isArray(mapping.include) ? mapping.include : [mapping.include];
    for (const include of includes) {
      const relative = localInclude(include);
      const child = await readLocal(root, relative);
      if (child === null) throw new GitlabRoutingError(`Local CI include ${relative} is missing.`);
      await visit(relative, child.content, new Set([...ancestors, name]));
    }
  };
  await visit(GITLAB_BUSINESS_WORKFLOW_PATH, content, new Set());
  if (!ordinaryJob) throw new GitlabRoutingError('Completion requires an existing runnable business job in an ordinary stage; empty CI or only .pre/.post jobs cannot start the MR pipeline.');
}

/** Plan adoption/refresh/restoration together; the reconciler performs all writes atomically. */
export async function buildGitlabRoutingSteps(root: string, routerYaml: string | null): Promise<ManagedStep[]> {
  if (routerYaml === null) {
    const entry = await fs.lstat(path.join(root, GITLAB_ROUTING_PATH)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry === null || !entry.isFile()) return [];
  }
  const current = await readLocal(root, GITLAB_ROUTING_PATH);
  const owned = current !== null && isSpecGitOwnedGitlabRouting(current.content);
  // An unrelated business root is not a retirement candidate.
  if (routerYaml === null && !owned) return [];
  const business = await readLocal(root, GITLAB_BUSINESS_WORKFLOW_PATH);
  if (!owned && business !== null) throw new GitlabRoutingError(`${GITLAB_BUSINESS_WORKFLOW_PATH} already exists without an owned routing root; preserve it and resolve the collision first.`);
  if (owned && business === null) throw new GitlabRoutingError(`The owned routing root has no ${GITLAB_BUSINESS_WORKFLOW_PATH}; restore the business configuration before continuing.`);
  const original = owned ? business : current;
  if (original === null) throw new GitlabRoutingError('Automatic completion requires an existing business CI configuration with a runnable ordinary-stage job.');
  if (routerYaml !== null) await validateBusiness(root, original.content);

  if (routerYaml === null) return [
    { kind: 'write', path: GITLAB_ROUTING_PATH, mode: original.mode,
      isOwned: (bytes) => bytes === current!.content && isSpecGitOwnedGitlabRouting(bytes), merge: () => original.content },
    { kind: 'remove', path: GITLAB_BUSINESS_WORKFLOW_PATH, isOwned: (bytes) => bytes === original.content },
  ];
  return [
    { kind: 'write', path: GITLAB_BUSINESS_WORKFLOW_PATH, mode: original.mode,
      isOwned: (bytes) => owned && bytes === original.content, merge: () => original.content },
    { kind: 'write', path: GITLAB_ROUTING_PATH, mode: current?.mode ?? 0o644,
      isOwned: (bytes) => bytes === current?.content, merge: () => routerYaml },
  ];
}
