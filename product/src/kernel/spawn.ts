/**
 * The single subprocess spawn contract for SpecGit (#185). Both subprocess
 * seams consume it: the local git facts adapter (`src/gitfacts`) and the
 * forge CLI provider adapters (`src/providers`). Defined once in the
 * kernel so the two transports can never drift apart and one shared test
 * double can satisfy both. The constraint it carries is the product's:
 * authenticated CLIs are the only transport — no REST client, no tokens.
 */

export interface SpawnOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Body piped to the child's stdin (used by `--body-file -` / `--input -`). */
  stdin?: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => Promise<{ stdout: string; stderr: string }>;
