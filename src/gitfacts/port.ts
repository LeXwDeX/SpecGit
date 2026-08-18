export interface GitFacts {
  repo: boolean;
  toplevel: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  isLinkedWorktree: boolean | null;
  worktreeLabel: string | null;
  worktrees: Array<{ label: string; branch: string | null }>;
  originUrl: string | null;
  upstreamDrift: { ahead: number; behind: number } | null;
  gitAvailable: boolean;
}

export interface GitPort {
  facts(root: string): Promise<GitFacts>;
}

export interface SpawnOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => Promise<{ stdout: string; stderr: string }>;
