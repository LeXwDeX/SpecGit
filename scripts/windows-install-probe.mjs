import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const output = path.join(root, 'public');
mkdirSync(output, { recursive: true });
function sanitize() {
  const raw = path.join(root, 'npm-raw');
  const timings = [];
  if (existsSync(raw)) for (const file of readdirSync(raw)) {
    if (!file.endsWith('-timing.json')) continue;
    const value = JSON.parse(readFileSync(path.join(raw, file), 'utf8'));
    const timers = Object.fromEntries(Object.entries(value.timers ?? {})
      .filter(([key, ms]) => /^(npm|command:(pack|install)|idealTree(:[A-Za-z]+)?|reify(:[A-Za-z]+)?|arborist:[A-Za-z]+|load:[A-Za-z]+)$/.test(key) && typeof ms === 'number'));
    timings.push({ file, timers });
  }
  writeFileSync(path.join(output, 'npm-timers.json'), JSON.stringify(timings, null, 2));
}
if (process.argv.includes('--sanitize-only')) {
  sanitize();
} else {
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npm)) throw new Error('Node installation does not contain npm-cli.js');
  const records = [];
  async function run(label, args, cwd, cache) {
    const started = Date.now();
    const child = spawn(process.execPath, [npm, ...args], {
      cwd, env: { ...process.env, npm_config_cache: cache }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    // Keep raw stderr out of logs and artifacts.
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.resume();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else child.kill('SIGKILL');
    }, 120000);
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally { clearTimeout(timeout); }
    records.push({ label, pid: child.pid, parentPid: process.pid, started,
      milliseconds: Date.now() - started, exit, timedOut });
    writeFileSync(path.join(output, 'controls.json'), JSON.stringify(records, null, 2));
    return { exit, stdout };
  }
  const staging = path.join(root, 'package');
  mkdirSync(staging, { recursive: true });
  const { scripts, ...manifest } = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify(manifest));
  for (const item of ['dist', 'bin', 'schemas', 'README.md', 'LICENSE']) {
    cpSync(item, path.join(staging, item), { recursive: true });
  }
  const packed = await run('pack', ['pack', '--json', '--silent', '--ignore-scripts'],
    staging, path.join(root, 'pack-cache'));
  if (packed.exit !== 0) throw new Error('Control pack failed');
  const tarball = path.join(staging, JSON.parse(packed.stdout)[0].filename);
  for (const [label, cacheName, offline] of [
    ['cold-online', 'cache-a', false], ['warm-offline', 'cache-a', true],
    ['cold-offline', 'cache-b', true],
  ]) {
    const prefix = path.join(root, label);
    mkdirSync(prefix, { recursive: true });
    writeFileSync(path.join(prefix, 'package.json'), '{"name":"diagnostic-control","private":true}');
    const result = await run(label, ['install', tarball, '--no-save', '--no-audit', '--no-fund',
      '--loglevel=error', ...(offline ? ['--offline'] : [])], prefix, path.join(root, cacheName));
    if (label !== 'cold-offline' && result.exit !== 0) throw new Error(`${label} failed`);
  }
  sanitize();
}
