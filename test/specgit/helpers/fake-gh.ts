import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeGhRule {
  match: string;
  exit?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
}

export interface FakeGh {
  binDir: string;
  configPath: string;
  logPath: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

const FAKE_GH_SCRIPT = `
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const args = argv.join(' ');
// Mirror real gh: '--body-file -' reads the request body from stdin.
const bodyFileIdx = argv.indexOf('--body-file');
const readsStdin = bodyFileIdx !== -1 && argv[bodyFileIdx + 1] === '-';
function finish(stdinText) {
  const record = readsStdin ? { args, stdin: stdinText } : { args };
  fs.appendFileSync(cfg.logPath, JSON.stringify(record) + '\\n');
  const rule = cfg.rules.find((r) => new RegExp(r.match).test(args));
  if (!rule) {
    process.stderr.write('fake gh: no rule matched: ' + args);
    process.exit(1);
  }
  function respond() {
    if (rule.stdout) process.stdout.write(rule.stdout);
    if (rule.stderr) process.stderr.write(rule.stderr);
    process.exit(typeof rule.exit === 'number' ? rule.exit : 0);
  }
  if (rule.delayMs && rule.delayMs > 0) {
    setTimeout(respond, rule.delayMs);
  } else {
    respond();
  }
}
if (readsStdin) {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (pending += chunk));
  process.stdin.on('end', () => finish(pending));
} else {
  finish('');
}
`;

export function createFakeGh(tempDir: string, rules: FakeGhRule[]): FakeGh {
  const binDir = path.join(tempDir, 'fake-gh-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const configPath = path.join(tempDir, 'fake-gh-config.json');
  const logPath = path.join(tempDir, 'fake-gh-calls.jsonl');
  fs.writeFileSync(configPath, JSON.stringify({ rules, logPath }));

  const recorderPath = path.join(binDir, 'fake-gh.cjs');
  fs.writeFileSync(recorderPath, `#!/usr/bin/env node\n${FAKE_GH_SCRIPT}`);
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
