import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const version = readFileSync(path.join(runtime, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const quotePs = value => `'${value.replaceAll("'", "''")}'`;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platform = windows ? 'win32-x64' : process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64-gnu';
  const binaryName = windows ? 'specgit.exe' : 'specgit';
  const compiled = process.env.SPECGIT_INSTALLER_TEST_BINARY ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(runtime, 'target'), 'debug', binaryName);
  assert(existsSync(compiled), `Installer integration tests require the compiled native CLI: ${compiled}`);
  const packageBin = path.join(root, 'package', 'bin');
  mkdirSync(packageBin, { recursive: true });
  copyFileSync(compiled, path.join(packageBin, binaryName));
  const archive = `specgit-${platform}-${version}.tgz`;
  const tar = spawnSync('tar', ['-czf', archive, 'package'], { cwd: root, encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const sums = path.join(root, 'SHASUMS256.txt');
  writeFileSync(sums, `${hash(path.join(root, archive))}  ${archive}\n`);
  const destination = path.join(root, 'installed with spaces');
  mkdirSync(destination);
  const installed = path.join(destination, binaryName);
  const shim = path.join(root, 'shim');
  mkdirSync(shim);
  const env = { ...process.env, SPECGIT_TEST_DOWNLOADS: root, PATH: `${shim}${path.delimiter}${process.env.PATH}` };
  if (!windows) {
    env.TMPDIR = path.join(root, 'scratch: with spaces');
    mkdirSync(env.TMPDIR);
  }
  // Replace only the transport in subprocess tests. The shipped installers have
  // fixed GitHub URLs and no configurable download origin or checksum bypass.
  if (!windows) {
    const downloader = path.join(shim, 'curl');
    writeFileSync(downloader, `#!${process.execPath}\nimport('node:fs').then(fs => {
      const args = process.argv.slice(2);
      const url = args.find(arg => arg.startsWith('https://'));
      if (!url?.startsWith('https://github.com/LeXwDeX/SpecGit/releases/')) process.exit(93);
      if (url.endsWith('/latest')) { process.stdout.write('https://github.com/LeXwDeX/SpecGit/releases/tag/v${version}'); return; }
      fs.copyFileSync(process.env.SPECGIT_TEST_DOWNLOADS + '/' + url.split('/').at(-1), args[args.indexOf('-o') + 1]);
    }).catch(() => process.exit(22));\n`);
    chmodSync(downloader, 0o755);
  }
  function run(selected = version) {
    if (!windows) return spawnSync('sh', [path.join(runtime, 'distribution', 'install.sh'), selected, destination], { env, encoding: 'utf8', timeout: 60_000 });
    const script = path.join(root, 'run.ps1');
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod { param($Uri, $TimeoutSec) return @{ tag_name='v${version}'; draft=$false; prerelease=$false } }
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
  if (-not $Uri.StartsWith('https://github.com/LeXwDeX/SpecGit/releases/')) { throw 'Unexpected download origin' }
  Copy-Item -LiteralPath (Join-Path $env:SPECGIT_TEST_DOWNLOADS ($Uri.Split('/')[-1])) -Destination $OutFile
}
& ${quotePs(path.join(runtime, 'distribution', 'install.ps1'))} -Version ${quotePs(selected)} -InstallDir ${quotePs(destination)}
`);
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { env, encoding: 'utf8', timeout: 60_000 });
  }
  return { root, archive, sums, installed, compiled, shim, env, run };
}

test('release installer installs the real binary, resolves latest and upgrades in a directory with spaces', t => {
  const f = fixture(t);
  for (const selected of [version, 'latest']) {
    const result = f.run(selected);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(hash(f.installed), hash(f.compiled));
    const probe = spawnSync(f.installed, ['--human', '--version'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), `specgit ${version}`);
  }
});

test('corrupt, missing and ambiguous downloads preserve an existing installation', t => {
  const f = fixture(t);
  writeFileSync(f.installed, 'previous installation');
  const original = readFileSync(f.sums, 'utf8');
  for (const contents of [`${'0'.repeat(64)}  ${f.archive}\n`, '', original + original]) {
    writeFileSync(f.sums, contents);
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(f.installed, 'utf8'), 'previous installation');
  }
  writeFileSync(f.sums, original);
  rmSync(path.join(f.root, f.archive));
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.installed, 'utf8'), 'previous installation');
});

test('invalid requested versions never replace an existing installation', t => {
  const f = fixture(t);
  writeFileSync(f.installed, 'previous installation');
  for (const selected of ['../main', '2.0.0-rc.1', '2.0.0/other']) {
    assert.notEqual(f.run(selected).status, 0);
    assert.equal(readFileSync(f.installed, 'utf8'), 'previous installation');
  }
});

test('unsupported host architecture is rejected before installation', t => {
  const f = fixture(t);
  if (windows) f.env.PROCESSOR_ARCHITECTURE = 'ARM64';
  else {
    const uname = path.join(f.shim, 'uname');
    writeFileSync(uname, '#!/bin/sh\nprintf "unsupported\\n"\n');
    chmodSync(uname, 0o755);
  }
  assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(f.installed), false);
});

test('a verified archive with the wrong native version cannot replace the existing command', t => {
  const f = fixture(t);
  writeFileSync(f.installed, 'previous installation');
  const wrongVersion = '999.0.0';
  const renamed = f.archive.replace(version, wrongVersion);
  copyFileSync(path.join(f.root, f.archive), path.join(f.root, renamed));
  writeFileSync(f.sums, `${hash(path.join(f.root, renamed))}  ${renamed}\n`);
  assert.notEqual(f.run(wrongVersion).status, 0);
  assert.equal(readFileSync(f.installed, 'utf8'), 'previous installation');
});
