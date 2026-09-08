export interface ActionsWorkflow {
  key: string;
  checkSuiteId: unknown;
  runAttempt: unknown;
  check: { id: number; startedAt: string | null; status: string };
}

export interface ActionsOwnership<T extends ActionsWorkflow> {
  readonly latest: readonly T[];
  /** null means a proven owner was superseded; unknown ownership throws. */
  currentFor(checkSuiteId: unknown): T | null;
}

export function isGithubActionsApp(app: unknown): boolean;
export function createActionsOwnership<T extends ActionsWorkflow>(workflows: readonly T[]): ActionsOwnership<T>;
