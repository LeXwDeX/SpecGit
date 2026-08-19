/**
 * Static discovery for `specgit init`: platform classification from the
 * origin URL (no network), required-check names from local CI files
 * (.github/workflows job names/ids, .gitlab-ci.yml top-level job keys),
 * and gh/glab presence on PATH (reported only).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);

const WORKFLOWS_DIR_SEGMENTS = ['.github', 'workflows'];
const EXCLUDED_CHECK = 'SpecGit Acceptance';
const GITLAB_CI_FILENAME = '.gitlab-ci.yml';

// GitLab CI top-level reserved keys that are not jobs.
const GITLAB_RESERVED_KEYS = new Set([
  'stages', 'include', 'workflow', 'default', 'variables', 'image',
  'services', 'before_script', 'after_script', 'cache', 'pages', 'types',
]);

export type OriginPlatform = 'github' | 'gitlab' | 'unknown';

export interface DetectionReport {
  platform: OriginPlatform;
  requiredChecks: string[];
  sources: string[];
  clis: { gh: boolean; glab: boolean };
}

interface WorkflowJobsShape {
  jobs?: Record<string, unknown>;
}

function jobName(id: string, job: unknown): string | null {
  if (typeof job !== 'object' || job === null) return null;
  const name = (job as { name?: unknown }).name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : id;
}

export async function classifyPlatform(originUrl: string | null): Promise<OriginPlatform> {
  const url = originUrl?.trim().toLowerCase() ?? '';
  if (!url) return 'unknown';
  if (url.includes('github.com')) return 'github';
  if (url.includes('gitlab')) return 'gitlab';
  return 'unknown';
}

async function probeCli(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function detectGithubChecks(root: string, sources: string[]): Promise<string[]> {
  const dir = path.join(root, ...WORKFLOWS_DIR_SEGMENTS);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries.sort()) {
    if (!/\.(yml|yaml)$/i.test(entry)) continue;
    let parsed: unknown;
    try {
      parsed = parse(await fs.readFile(path.join(dir, entry), 'utf-8'));
    } catch {
      continue;
    }
    const jobs = (parsed as WorkflowJobsShape | null)?.jobs;
    if (typeof jobs !== 'object' || jobs === null) continue;
    sources.push(`.github/workflows/${entry}`);
    for (const [id, job] of Object.entries(jobs)) {
      const name = jobName(id, job);
      if (name !== null && name !== EXCLUDED_CHECK) names.push(name);
    }
  }
  return names;
}

async function detectGitlabChecks(root: string, sources: string[]): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, GITLAB_CI_FILENAME), 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  sources.push(GITLAB_CI_FILENAME);
  return Object.keys(parsed as Record<string, unknown>).filter(
    (key) => !GITLAB_RESERVED_KEYS.has(key)
  );
}

export async function detectRequiredChecks(cwd: string): Promise<string[]> {
  const report = await detectInitInputs(cwd, null);
  return report.requiredChecks;
}

export async function detectInitInputs(
  root: string,
  originUrl: string | null
): Promise<DetectionReport> {
  const platform = await classifyPlatform(originUrl);
  const sources: string[] = [];
  const github = await detectGithubChecks(root, sources);
  const gitlab = github.length > 0 ? [] : await detectGitlabChecks(root, sources);
  const [gh, glab] = await Promise.all([probeCli('gh'), probeCli('glab')]);
  return {
    platform,
    requiredChecks: [...github, ...gitlab],
    sources,
    clis: { gh, glab },
  };
}
