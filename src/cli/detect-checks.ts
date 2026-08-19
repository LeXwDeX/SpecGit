/**
 * Static required-check discovery for `specgit init`.
 *
 * Reads `.github/workflows/*.{yml,yaml}` and returns the job check names:
 * the job's `name:` when set, otherwise the job id. The generated SpecGit
 * Acceptance job is excluded (it must never be a required check of
 * itself). Unparsable workflow files are skipped, not fatal — detection is
 * a convenience; the written policy remains human-editable.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

const WORKFLOWS_DIR_SEGMENTS = ['.github', 'workflows'];
const EXCLUDED_CHECK = 'SpecGit Acceptance';

interface WorkflowJobsShape {
  jobs?: Record<string, unknown>;
}

function jobName(id: string, job: unknown): string | null {
  if (typeof job !== 'object' || job === null) return null;
  const name = (job as { name?: unknown }).name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : id;
}

export async function detectRequiredChecks(cwd: string): Promise<string[]> {
  const dir = path.join(cwd, ...WORKFLOWS_DIR_SEGMENTS);
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
    for (const [id, job] of Object.entries(jobs)) {
      const name = jobName(id, job);
      if (name !== null && name !== EXCLUDED_CHECK) names.push(name);
    }
  }
  return names;
}
