import type { CheckRunInfo } from '../github/port.js';

export interface CiProblem {
  kind: 'pending' | 'failed';
  check: Readonly<CheckRunInfo>;
}

export interface CiEligibility {
  empty: boolean;
  missingRequired: string[];
  executedCount: number;
  /** Input order lets each caller retain its own diagnostic and waiting policy. */
  problems: CiProblem[];
  eligible: boolean;
}

/** Classify complete CI evidence without deciding how a caller waits or reports it. */
export function classifyCiEligibility(
  checks: readonly CheckRunInfo[],
  requiredNames: readonly string[]
): CiEligibility {
  const required = new Set(requiredNames);
  const names = new Set(checks.map((check) => check.name));
  const missingRequired = requiredNames.filter((name) => !names.has(name));
  const problems: CiProblem[] = [];
  let executedCount = 0;
  for (const check of checks) {
    if (!required.has(check.name) && check.status === 'completed' && check.conclusion === 'skipped') continue;
    executedCount++;
    if (check.status !== 'completed') {
      problems.push({ kind: 'pending', check });
    } else if (check.conclusion !== 'success') {
      problems.push({ kind: 'failed', check });
    }
  }
  return {
    empty: checks.length === 0,
    missingRequired,
    executedCount,
    problems,
    eligible: missingRequired.length === 0 && executedCount > 0 && problems.length === 0,
  };
}
