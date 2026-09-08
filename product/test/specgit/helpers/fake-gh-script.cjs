#!/usr/bin/env node
const fs = require('node:fs');
// The helper always sets FAKE_GH_CONFIG; the fallback keeps this script
// checkJs-clean (env vars are string | undefined) and fails loudly if a
// consumer ever spawns it without the config env.
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG ?? '', 'utf8'));
const argv = process.argv.slice(2);
const args = argv.join(' ');
// Mirror real gh: '--body-file -' and '--input -' read their payload from stdin.
const bodyFileIdx = argv.indexOf('--body-file');
const inputIdx = argv.indexOf('--input');
const readsStdin =
  (bodyFileIdx !== -1 && argv[bodyFileIdx + 1] === '-') ||
  (inputIdx !== -1 && argv[inputIdx + 1] === '-');
function statePath() {
  return cfg.statePath || (cfg.logPath + '.state');
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

/** @param {string} stdinText */
function finish(stdinText) {
  const record = readsStdin ? { args, stdin: stdinText } : { args };
  fs.appendFileSync(cfg.logPath, JSON.stringify(record) + '\n');
  const ruleIndex = cfg.rules.findIndex(
    (/** @type {{ match: string }} */ r) => new RegExp(r.match).test(args)
  );
  const rule = cfg.rules[ruleIndex];
  if (!rule) {
    process.stderr.write('fake gh: no rule matched: ' + args);
    process.exit(1);
  }
  let stdout = rule.stdout;
  // #330 seam: label-create POSTs answer with the created label object,
  // echoing the name exactly as requested (the adapter verifies it).
  if (rule.labelEcho === true && stdout === undefined) {
    const m = /[ ]name=([^ ]+)/.exec(args);
    stdout = JSON.stringify({ name: m ? decodeURIComponent(m[1]) : '' });
  }
  // #330 seam: issue-label applies read their slugs from stdin JSON and
  // answer with the resulting label list (union semantics need no merge
  // here beyond what the request itself already carries).
  if (rule.issueLabelEcho === true && stdout === undefined) {
    var requested = [];
    try {
      var parsed = JSON.parse(stdinText || '{}');
      if (Array.isArray(parsed.labels)) requested = parsed.labels;
    } catch (e) {
      requested = [];
    }
    stdout = JSON.stringify(
      requested.map(function (/** @type {string} */ n) { return { name: n }; })
    );
  }
  if (rule.seq && stdout !== undefined) {
    const state = loadState();
    const n = state[String(ruleIndex)] || 0;
    state[String(ruleIndex)] = n + 1;
    fs.writeFileSync(statePath(), JSON.stringify(state));
    stdout = stdout.split('%SEQ%').join(String(rule.seq.start + (rule.seq.step || 1) * n));
  }
  function respond() {
    const exitCode = typeof rule.exit === 'number' ? rule.exit : 0;
    // Exit only after every write is flushed to the OS: process.exit can
    // drop pipe-buffered output mid-write, and larger payloads (e.g. a
    // 100-entry check-run page, ~13 KB) lose their tail exactly when the
    // parent has not drained the pipe yet (#120 CI macos flake).
    /** @type {((done: () => void) => void)[]} */
    const writes = [];
    if (stdout) writes.push(function (done) { process.stdout.write(stdout, done); });
    if (rule.stderr) writes.push(function (done) { process.stderr.write(rule.stderr, done); });
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
