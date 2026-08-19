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

import { extractOriginHost } from '../gitfacts/origin.js';

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
  if (typeof name === 'string' && name.trim().length > 0) {
    // A matrix placeholder (e.g. "Tests (${{ matrix.os }})") never appears
    // in check-runs; the job id is the stable identity.
    return name.includes('${{') ? id : name.trim();
  }
  return id;
}

/**
 * Workflows that cannot run on a PR head (dispatch-only) never register
 * check runs there, so their jobs must not become required checks.
 * YAML 1.1 parses the bare key `on` as boolean true — both shapes are read.
 */
function runsOnPullRequests(parsed: unknown): boolean {
  const record = parsed as { on?: unknown; true?: unknown } | null;
  const on = record?.on ?? record?.true;
  if (on === undefined) return true; // implicit push/PR per GitHub defaults
  if (typeof on === 'string') return on !== 'workflow_dispatch';
  if (Array.isArray(on)) return on.some((trigger) => trigger !== 'workflow_dispatch');
  if (typeof on === 'object' && on !== null) {
    return Object.keys(on).some((trigger) => trigger !== 'workflow_dispatch');
  }
  return true;
}

const GITHUB_HOST = 'github.com';
const GITLAB_HOST_TOKEN = 'gitlab';

/**
 * Explicit ports are accepted only in the forms tracked by #78: a port
 * equal to the scheme default classifies like the portless form, every
 * other explicit port fails closed to 'unknown'.
 */
const DEFAULT_PORT_BY_SCHEME: Record<string, string> = {
  git: '9418',
  http: '80',
  https: '443',
  ssh: '22',
};

/**
 * Structural platform trust (#83, CodeQL alert 1): the decision reads
 * the host component extracted by extractOriginHost — bounded, regex
 * free, and with userinfo/path/query/fragment structurally excluded —
 * and compares it exactly. 'github' requires the host to be literally
 * github.com; 'gitlab' answers the same host-level heuristic predicate
 * parseRepoRef uses for gitlab_unsupported (charset-valid host
 * containing "gitlab"), which grants no capability because GitLab is
 * explicitly unsupported. Anything else — spoofed suffixes such as
 * github.com.evil.example, tokens hidden in credentials or paths,
 * non-default ports, malformed or over-long input — fails closed to
 * 'unknown'.
 */
export async function classifyPlatform(originUrl: string | null): Promise<OriginPlatform> {
  if (originUrl === null) return 'unknown';
  const parts = extractOriginHost(originUrl);
  if (parts === null) return 'unknown';
  if (parts.port !== null) {
    const defaultPort = parts.scheme === null ? undefined : DEFAULT_PORT_BY_SCHEME[parts.scheme];
    if (defaultPort === undefined || parts.port !== defaultPort) return 'unknown';
  }
  if (parts.host === GITHUB_HOST) return 'github';
  if (parts.host.includes(GITLAB_HOST_TOKEN)) return 'gitlab';
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
    if (!runsOnPullRequests(parsed)) continue;
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
