/**
 * Static discovery for `specgit init`: platform classification from the
 * origin URL (no network), required-check names from local CI files
 * (.github/workflows job names/ids, .gitlab-ci.yml top-level job keys),
 * and gh/glab presence on PATH (reported only).
 *
 * #310 truth boundary: detection only ever reports names static reading
 * can prove — a job whose check-run name depends on matrix expansion or a
 * reusable-workflow call is reported as ambiguous, never armed as a
 * required check.
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
  'services', 'before_script', 'after_script', 'cache', 'types', 'spec',
]);

export type OriginPlatform = 'github' | 'gitlab' | 'unknown';

export interface DetectionReport {
  platform: OriginPlatform;
  requiredChecks: string[];
  sources: string[];
  /** Workflow files with jobs that never run on a PR head (#121) — reported so init can warn. */
  nonPrWorkflows: string[];
  /**
   * #310: jobs whose check-run name static reading cannot prove, as
   * `<source>: <job id>` — matrix fan-out (placeholder or not) and
   * reusable-workflow calls. Reported so init can warn; never armed as
   * proven required checks.
   */
  ambiguousJobs: string[];
  clis: { gh: boolean; glab: boolean };
}

interface WorkflowJobsShape {
  jobs?: Record<string, unknown>;
}

/** What static reading can honestly claim about one job's check-run name (#310). */
type JobCheckName = { kind: 'proven'; name: string } | { kind: 'ambiguous' };

/**
 * A matrix with at least one key fans the job out into one check run per
 * combination; an empty `matrix: {}` object is a single un-expanded leg.
 * A non-empty string (`matrix: ${{ fromJson(...) }}`) is a dynamic
 * fan-out: the expansion — and every reported name with it — is decided
 * by the runtime expression, never provable from this file.
 */
function hasMatrixFanOut(strategy: unknown): boolean {
  if (typeof strategy !== 'object' || strategy === null) return false;
  const matrix = (strategy as { matrix?: unknown }).matrix;
  if (typeof matrix === 'string') {
    return matrix.trim().length > 0;
  }
  return typeof matrix === 'object' && matrix !== null && Object.keys(matrix).length > 0;
}

function jobCheckName(id: string, job: unknown): JobCheckName | null {
  if (typeof job !== 'object' || job === null) return null;
  const record = job as { name?: unknown; uses?: unknown; strategy?: unknown };
  // #310: a reusable-workflow call reports the CALLED job's name; a matrix
  // fans out into per-combination check runs whose names come from the
  // expansion GitHub performs. Neither name is provable from this file —
  // ambiguity is evidence, never a guessed success.
  if (typeof record.uses === 'string') return { kind: 'ambiguous' };
  if (hasMatrixFanOut(record.strategy)) return { kind: 'ambiguous' };
  const name = record.name;
  if (typeof name === 'string' && name.trim().length > 0) {
    // An expression placeholder (e.g. "Tests (${{ matrix.os }})") resolves
    // only at expansion time — and the #39 job-id fallback is NOT the
    // expanded check-run name either, so neither may be claimed.
    return name.includes('${{') ? { kind: 'ambiguous' } : { kind: 'proven', name: name.trim() };
  }
  return { kind: 'proven', name: id };
}

/**
 * The detection trust boundary (#121): detected checks are suggestions
 * until proven on a PR head. A workflow's jobs can become required-check
 * candidates only if the workflow's triggers include a PR trigger —
 * `pull_request` is the PR event whose checks are relevant here;
 * `pull_request_target` runs against the trusted default branch, not
 * the delivery head. push (filtered or not), schedule,
 * workflow_dispatch, and other triggers are not inferred as PR checks; classifying by
 * "not dispatch" would arm a stillborn policy (permanent checks_missing).
 * An omitted `on` key is not a valid workflow trigger declaration.
 * YAML 1.1 parses the bare key `on` as boolean true — both shapes are read.
 */
const PR_TRIGGERS = new Set(['pull_request']);

function runsOnPullRequests(parsed: unknown): boolean {
  const record = parsed as { on?: unknown; true?: unknown } | null;
  const on = record?.on ?? record?.true;
  if (on === undefined) return false;
  let triggers: string[];
  if (typeof on === 'string') {
    triggers = [on];
  } else if (Array.isArray(on)) {
    triggers = on.filter((trigger): trigger is string => typeof trigger === 'string');
  } else if (typeof on === 'object' && on !== null) {
    triggers = Object.keys(on);
  } else {
    return false;
  }
  return triggers.some((trigger) => PR_TRIGGERS.has(trigger));
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

async function detectGithubChecks(
  root: string,
  sources: string[],
  nonPrWorkflows: string[],
  ambiguousJobs: string[]
): Promise<string[]> {
  const dir = path.join(root, ...WORKFLOWS_DIR_SEGMENTS);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  // #310: one wait list never names the same check twice — exact repeated
  // display names (e.g. two aggregator jobs) collapse to the first
  // occurrence, preserving discovery order.
  const names: string[] = [];
  const seen = new Set<string>();
  const addProven = (name: string): void => {
    if (name === EXCLUDED_CHECK || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  const addAmbiguous = (entry: string): void => {
    if (!seen.has(entry)) {
      seen.add(entry);
      ambiguousJobs.push(entry);
    }
  };
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
    if (!runsOnPullRequests(parsed)) {
      // #121: jobs in a workflow with no PR trigger can never report on a
      // PR head — excluded from the policy, surfaced for the init warning.
      nonPrWorkflows.push(`.github/workflows/${entry}`);
      continue;
    }
    sources.push(`.github/workflows/${entry}`);
    for (const [id, job] of Object.entries(jobs)) {
      const resolution = jobCheckName(id, job);
      if (resolution === null) continue;
      if (resolution.kind === 'ambiguous') {
        addAmbiguous(`.github/workflows/${entry}: ${id}`);
        continue;
      }
      addProven(resolution.name);
    }
  }
  return names;
}

async function detectGitlabChecks(root: string, sources: string[], ambiguousJobs: string[]): Promise<string[]> {
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
  return Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
    if (key.startsWith('.') || GITLAB_RESERVED_KEYS.has(key) ||
      typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    if ('parallel' in value || key.includes('$[[')) {
      ambiguousJobs.push(`${GITLAB_CI_FILENAME}: ${key}`);
      return [];
    }
    return [key];
  });
}

export async function detectRequiredChecks(cwd: string): Promise<string[]> {
  const report = await detectInitInputs(cwd, null);
  return report.requiredChecks;
}

export async function detectInitInputs(
  root: string,
  originUrl: string | null,
  declaredPlatform?: OriginPlatform
): Promise<DetectionReport> {
  const platform = declaredPlatform ?? await classifyPlatform(originUrl);
  const sources: string[] = [];
  const nonPrWorkflows: string[] = [];
  const ambiguousJobs: string[] = [];
  const github = platform === 'gitlab' ? [] : await detectGithubChecks(root, sources, nonPrWorkflows, ambiguousJobs);
  const gitlab = platform === 'github' || github.length > 0 ? [] : await detectGitlabChecks(root, sources, ambiguousJobs);
  const [gh, glab] = await Promise.all([probeCli('gh'), probeCli('glab')]);
  return {
    platform,
    requiredChecks: [...github, ...gitlab],
    sources,
    nonPrWorkflows,
    ambiguousJobs,
    clis: { gh, glab },
  };
}
