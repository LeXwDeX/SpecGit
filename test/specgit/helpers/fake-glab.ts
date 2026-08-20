import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeGlabRule {
  match: string;
  exit?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
}

export interface FakeGlab {
  binDir: string;
  configPath: string;
  logPath: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

// Same scripted-recorder contract as fake-gh.ts, with glab's own env
// names (FAKE_GLAB_CONFIG / SPECGIT_GLAB) so a scripted glab never
// collides with a scripted gh in the same environment.
const FAKE_GLAB_SCRIPT = `
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const args = argv.join(' ');
const inputIdx = argv.indexOf('--input');
const readsStdin = inputIdx !== -1 && argv[inputIdx + 1] === '-';
function finish(stdinText) {
  const record = readsStdin ? { args, stdin: stdinText } : { args };
  fs.appendFileSync(cfg.logPath, JSON.stringify(record) + '\\n');
  const rule = cfg.rules.find((r) => new RegExp(r.match).test(args));
  if (!rule) {
    process.stderr.write('fake glab: no rule matched: ' + args);
    process.exit(1);
  }
  const exitCode = typeof rule.exit === 'number' ? rule.exit : 0;
  const writes = [];
  if (rule.stdout) writes.push(function (done) { process.stdout.write(rule.stdout, done); });
  if (rule.stderr) writes.push(function (done) { process.stderr.write(rule.stderr, done); });
  function respond() {
    if (writes.length === 0) {
      process.exit(exitCode);
      return;
    }
    let remaining = writes.length;
    for (const write of writes) {
      write(function () {
        remaining -= 1;
        if (remaining === 0) process.exit(exitCode);
      });
    }
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

export function createFakeGlab(tempDir: string, rules: FakeGlabRule[]): FakeGlab {
  const binDir = path.join(tempDir, 'fake-glab-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const configPath = path.join(tempDir, 'fake-glab-config.json');
  const logPath = path.join(tempDir, 'fake-glab-calls.jsonl');
  fs.writeFileSync(configPath, JSON.stringify({ rules, logPath }));

  const recorderPath = path.join(binDir, 'fake-glab.cjs');
  fs.writeFileSync(recorderPath, `#!/usr/bin/env node\n${FAKE_GLAB_SCRIPT}`);
  fs.chmodSync(recorderPath, 0o755);

  const posixExecutable = path.join(binDir, 'glab');
  fs.writeFileSync(posixExecutable, `#!/bin/sh\nexec node ${JSON.stringify(recorderPath)} "$@"\n`);
  fs.chmodSync(posixExecutable, 0o755);
  fs.writeFileSync(
    path.join(binDir, 'glab.cmd'),
    `@echo off\r\nnode "${recorderPath}" %*\r\n`
  );

  return {
    binDir,
    configPath,
    logPath,
    env: (extra) => ({
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_GLAB_CONFIG: configPath,
      SPECGIT_GLAB: recorderPath,
      ...extra,
    }),
  };
}

export function readFakeGlabCalls(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { args: string }).args);
}

export function readFakeGlabStdin(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { stdin?: string })
    .filter((record) => typeof record.stdin === 'string')
    .map((record) => record.stdin as string);
}
