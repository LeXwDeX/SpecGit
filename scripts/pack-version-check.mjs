#!/usr/bin/env node
// Guard: Ensure the packed tarball's CLI `--version` matches package.json.
//
// Notes:
// - We intentionally use `npm pack` (not pnpm) because `npm pack --json` is
//   consistently supported and returns the tarball metadata we need. The
//   project uses pnpm for install/publish, but this guard only needs to pack
//   locally and verify the installed CLI output.
// - `npm pack` triggers the package's `prepare` script (build), and
//   `changeset publish` triggers `prepublishOnly` (also builds here). This
//   means an explicit build is not strictly necessary for the guard.

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { parseNpmPackFilename } from './npm-pack-output.mjs';

function log(msg) {
  if (process.env.CI) return; // keep CI logs quiet by default
  console.log(msg);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function npmPack() {
  return parseNpmPackFilename(run('npm', ['pack', '--json', '--silent']));
}

function main() {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  const expected = pkg.version;

  let work;
  let tgzPath;

  try {
    log(`Packing specgit@${expected}...`);
    const filename = npmPack();
    tgzPath = path.resolve(filename);
    log(`Created: ${tgzPath}`);

    work = mkdtempSync(path.join(tmpdir(), 'specgit-pack-check-'));
    log(`Temp dir: ${work}`);

    // Make a tiny project
    writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({ name: 'pack-check', private: true }, null, 2)
    );

    // Try to avoid noisy output and speed up
    const env = {
      ...process.env,
      npm_config_loglevel: 'silent',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_progress: 'false',
    };

    // Install the tarball
    run('npm', ['install', tgzPath, '--silent', '--no-audit', '--no-fund'], { cwd: work, env });

    // Run the installed CLI via Node to avoid bin resolution/platform issues
    const binRel = path.join('node_modules', 'specgit', 'bin', 'specgit.js');
    const actual = run(process.execPath, [binRel, '--version'], { cwd: work }).trim();

    if (actual !== expected) {
      throw new Error(
        `Packed CLI version mismatch: expected ${expected}, got ${actual}. ` +
          'Ensure the dist is built and the CLI reads version from package.json.'
      );
    }

    log('Version check passed.');
  } finally {
    // Always attempt cleanup
    if (work) {
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
    if (tgzPath) {
      try { rmSync(tgzPath, { force: true }); } catch {}
    }
  }
}

try {
  main();
  console.log('✅ pack-version-check: OK');
} catch (err) {
  console.error(`❌ pack-version-check: ${err.message}`);
  process.exit(1);
}
