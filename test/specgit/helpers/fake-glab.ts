import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeGlabRule {
  match: string;
  exit?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  /**
   * #330 seam: label-create POST answers `{ "name": <requested> }`,
   * echoing the `-f name=` argument the adapter verifies against.
   */
  labelEcho?: boolean;
  /**
   * #330 seam: issue-label apply (PUT with `-f add_labels=a,b`) answers
   * with the updated issue entity carrying a `labels` array of names.
   */
  issueLabelEcho?: boolean;
}

export interface FakeGlab {
  binDir: string;
  configPath: string;
  logPath: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/**
 * GitLab's real method routing for the endpoints this double serves
 * (#234). The double is a routing oracle, not just a request matcher: a
 * call hitting a known path with an unrouted verb gets GitLab's shaped
 * 404 instead of a rule match — the class of bug that let #229 (PATCH
 * on the PUT-only edit-project endpoint) sail through CI. More specific
 * patterns first; unmatched paths fall through to the scripted rules.
 */
const GITLAB_API_ROUTES: Array<{ pattern: string; methods: string[] }> = [
  { pattern: '^projects/[^/]+/labels$', methods: ['GET', 'POST'] },
  { pattern: '^projects/[^/]+/issues/\\d+/notes$', methods: ['POST'] },
  { pattern: '^projects/[^/]+/issues/\\d+$', methods: ['GET', 'PUT'] },
  { pattern: '^projects/[^/]+/issues$', methods: ['GET', 'POST'] },
  { pattern: '^projects/[^/]+/merge_requests/[^/]+$', methods: ['GET'] },
  { pattern: '^projects/[^/]+/merge_requests$', methods: ['GET', 'POST'] },
  { pattern: '^projects/[^/]+/protected_branches/[^/]+$', methods: ['GET'] },
  { pattern: '^projects/[^/]+/protected_branches$', methods: ['GET', 'POST'] },
  { pattern: '^projects/[^/]+/pipelines(/.*)?$', methods: ['GET'] },
  { pattern: '^projects/[^/]+$', methods: ['GET', 'PUT'] },
];

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
  rejectMrOnUnpushedBranch();
  checkRouting();
  const rule = cfg.rules.find((r) => new RegExp(r.match).test(args));
  if (!rule) {
    process.stderr.write('fake glab: no rule matched: ' + args);
    process.exit(1);
  }
  var stdout = rule.stdout;
  // #330 seam: label-create echoes the requested name (no '#' color form
  // differences matter here — the adapter verifies the name only).
  if (rule.labelEcho === true && stdout === undefined) {
    var m = /[ ]name=([^ ]+)/.exec(args);
    stdout = JSON.stringify({ name: m ? decodeURIComponent(m[1]) : '' });
  }
  // #330 seam: the apply answers the updated issue with a labels array.
  if (rule.issueLabelEcho === true && stdout === undefined) {
    var requested = [];
    var lm = /[ ]add_labels=([^ ]+)/.exec(args);
    if (lm) requested = decodeURIComponent(lm[1]).split(',');
    stdout = JSON.stringify({ iid: 0, labels: requested });
  }
  const exitCode = typeof rule.exit === 'number' ? rule.exit : 0;
  const writes = [];
  if (stdout) writes.push(function (done) { process.stdout.write(stdout, done); });
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
// GitLab rejects MR creation whose source branch was never pushed to
// the remote (#270). When cfg.repoDir points at the bare remote, the
// double enforces the same constraint: a POST merge_requests for an
// unpushed branch gets GitLab's shaped 400 instead of a rule match.
function rejectMrOnUnpushedBranch() {
  if (!cfg.repoDir || argv[0] !== 'api') return;
  let method = 'GET';
  let endpoint = null;
  let sourceBranch = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-X' || a === '--hostname' || a === '--input') {
      if (a === '-X') method = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '-f' || a === '--field') {
      const value = argv[i + 1] || '';
      if (value.indexOf('source_branch=') === 0) sourceBranch = value.slice('source_branch='.length);
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (endpoint === null) endpoint = a;
  }
  if (method !== 'POST' || endpoint === null || sourceBranch === null) return;
  if (!/merge_requests$/.test(endpoint.split('?')[0])) return;
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('git', ['--git-dir', cfg.repoDir, 'show-ref', '--verify', 'refs/heads/' + sourceBranch], { stdio: 'ignore' });
  } catch (err) {
    process.stdout.write('{"message":{"source_branch":["does not exist"]}}\\n');
    process.stderr.write('glab: HTTP 400 {"message":{"source_branch":["does not exist"]}}\\n');
    process.exit(1);
  }
}
function checkRouting() {
  if (argv[0] !== 'api') return;
  let method = 'GET';
  let endpoint = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-X' || a === '--hostname' || a === '--input') {
      if (a === '-X') method = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (endpoint === null) endpoint = a;
  }
  if (endpoint === null) return;
  const routePath = endpoint.split('?')[0];
  for (const route of cfg.routes) {
    if (!new RegExp(route.pattern).test(routePath)) continue;
    if (route.methods.indexOf(method) === -1) {
      process.stdout.write('{"error":"404 Not Found"}\\n');
      process.stderr.write('glab: HTTP 404\\n');
      process.exit(1);
    }
    return;
  }
}
`;

export interface FakeGlabOptions {
  /**
   * Bare remote the double verifies pushed branches against (#270): a
   * POST merge_requests whose source_branch is absent from this repo is
   * rejected with GitLab's shaped 400, like the real API.
   */
  repoDir?: string;
}

export function createFakeGlab(
  tempDir: string,
  rules: FakeGlabRule[],
  options: FakeGlabOptions = {}
): FakeGlab {
  const binDir = path.join(tempDir, 'fake-glab-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const configPath = path.join(tempDir, 'fake-glab-config.json');
  const logPath = path.join(tempDir, 'fake-glab-calls.jsonl');
  // #330 baseline: bootstrap probes the project label pool in inferred
  // mode. User rules stay first so scenarios can override any behavior.
  const labelBaseline: FakeGlabRule[] = [
    { match: '/labels\\?per_page=', stdout: '[]' },
    { match: '-X POST projects/[^ ]+/labels', labelEcho: true },
    { match: '-X PUT projects/[^ ]+/issues/[0-9]+', issueLabelEcho: true },
  ];
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      rules: [...rules, ...labelBaseline],
      routes: GITLAB_API_ROUTES,
      logPath,
      ...(options.repoDir === undefined ? {} : { repoDir: options.repoDir }),
    })
  );

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
