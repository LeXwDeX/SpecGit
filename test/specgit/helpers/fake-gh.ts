import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakeGhRule {
  match: string;
  exit?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  /**
   * Stateful output for rules hit more than once: every `%SEQ%` in
   * stdout is replaced by start + step*n (n = number of prior matches
   * of this rule), tracked in a per-fake state file. Lets `gh issue
   * create`-style rules return increasing numbers across invocations.
   */
  seq?: { start: number; step?: number };
  /**
   * #330 seam: label-create POST answers with `{ "name": <requested> }`,
   * echoing the `-f name=` argument the adapter can verify against.
   */
  labelEcho?: boolean;
  /**
   * #330 seam: issue-label apply answers with the requested slugs as a
   * label array, parsed from the stdin JSON this call reads (`--input -`).
   */
  issueLabelEcho?: boolean;
}

export interface FakeGh {
  binDir: string;
  configPath: string;
  logPath: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

// The fake gh implementation is a real script file (#189): it gets syntax
// highlighting and checkJs typechecking instead of living as an inline
// string. The helper copies it verbatim into the temp bin dir; the lock
// test in fake-gh-script.test.ts pins materialized content to this file.
const FAKE_GH_SCRIPT_PATH = fileURLToPath(new URL('./fake-gh-script.cjs', import.meta.url));

export function createFakeGh(tempDir: string, rules: FakeGhRule[]): FakeGh {
  const binDir = path.join(tempDir, 'fake-gh-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const configPath = path.join(tempDir, 'fake-gh-config.json');
  const logPath = path.join(tempDir, 'fake-gh-calls.jsonl');
  // #330 baseline: every bootstrap probes the label pool (inferred tag
  // mode), so the fake answers it by default — an empty pool plus echo
  // responders for seed and apply. User rules stay first: a caller may
  // override any of these behaviors per scenario.
  const labelBaseline: FakeGhRule[] = [
    // Fresh bootstrap has no prior traceability comment. Scenario rules
    // can supply existing comments or failures before this baseline.
    { match: '/issues/[0-9]+/comments\\?per_page=', stdout: '[]' },
    { match: '/labels\\?per_page=', stdout: '[]' },
    // The issue-apply rule stays ahead of the create rule: its path
    // (`/issues/<n>/labels`) also ends in `/labels`.
    { match: '-X POST repos/[^ ]+/issues/[0-9]+/labels', issueLabelEcho: true },
    { match: '-X POST repos/[^/]+/[^/ ]+/labels( |$)', labelEcho: true },
  ];
  fs.writeFileSync(
    configPath,
    JSON.stringify({ rules: [...rules, ...labelBaseline], logPath })
  );

  const recorderPath = path.join(binDir, 'fake-gh.cjs');
  // The script file carries its own POSIX node shebang; copy it verbatim.
  fs.writeFileSync(recorderPath, fs.readFileSync(FAKE_GH_SCRIPT_PATH, 'utf8'));
  // Executable bit so POSIX execFile can run the shebang directly; Windows
  // goes through the provider's node-shebang detection instead.
  fs.chmodSync(recorderPath, 0o755);

  // The extensionless `gh` script works on POSIX (kernel shebang) and — via
  // the provider's node-shebang detection — on Windows too. gh.cmd stays for
  // any shell-based consumer.
  const posixExecutable = path.join(binDir, 'gh');
  fs.writeFileSync(posixExecutable, `#!/bin/sh\nexec node ${JSON.stringify(recorderPath)} "$@"\n`);
  fs.chmodSync(posixExecutable, 0o755);
  fs.writeFileSync(
    path.join(binDir, 'gh.cmd'),
    `@echo off\r\nnode "${recorderPath}" %*\r\n`
  );

  return {
    binDir,
    configPath,
    logPath,
    env: (extra) => ({
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_GH_CONFIG: configPath,
      // Cross-platform: point SPECGIT_GH at the node-shebang script so the
      // provider executes it through node on every OS (real gh stays
      // unreachable even where a system gh exists).
      SPECGIT_GH: recorderPath,
      ...extra,
    }),
  };
}

export function readFakeGhCalls(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { args: string }).args);
}

/**
 * Stdin bodies captured from invocations that read stdin (`--body-file -`),
 * in call order; invocations that do not read stdin contribute nothing.
 */
export function readFakeGhStdin(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { stdin?: string })
    .filter((record) => typeof record.stdin === 'string')
    .map((record) => record.stdin as string);
}
