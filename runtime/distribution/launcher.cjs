#!/usr/bin/env node
'use strict';

// The launcher owns platform selection and process forwarding only.
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
function fail(message) {
  process.stderr.write(`SpecGit installation: ${message}\n`);
  process.exitCode = 2;
}
function platformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (key === 'linux-x64' || key === 'linux-arm64') {
    if (!process.report?.getReport().header.glibcVersionRuntime) {
      throw new Error('Linux requires glibc; musl and unknown libc are unsupported.');
    }
    return `${key}-gnu`;
  }
  if (['darwin-x64', 'darwin-arm64', 'win32-x64'].includes(key)) return key;
  throw new Error(`Unsupported platform ${key}. Supported: Linux glibc x64/arm64, macOS x64/arm64, Windows x64.`);
}
function main() {
  const wrapper = require('../package.json');
  const name = `specgit-${platformKey()}`;
  let manifestPath;
  try { manifestPath = require.resolve(`${name}/package.json`); }
  catch { throw new Error(`Missing ${name}@${wrapper.version}. Reinstall specgit with optional dependencies enabled; no install scripts are required.`); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== name || manifest.version !== wrapper.version ||
      wrapper.optionalDependencies[name] !== manifest.version) {
    throw new Error('Platform package and launcher versions differ. Reinstall the same exact version.');
  }
  if (process.platform === 'linux') {
    const current = process.report.getReport().header.glibcVersionRuntime.split('.').map(Number);
    const minimum = manifest.specgitNative.minimumGlibc;
    if (!/^\d+\.\d+$/.test(minimum)) throw new Error('Platform package lacks its glibc compatibility requirement. Reinstall it.');
    const required = minimum.split('.').map(Number);
    if (current[0] < required[0] || (current[0] === required[0] && current[1] < required[1])) throw new Error(`This binary requires glibc >= ${minimum}; installed glibc is ${current.join('.')}.`);
  }
  const binary = path.join(path.dirname(manifestPath), 'bin', process.platform === 'win32' ? 'specgit.exe' : 'specgit');
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
  if (digest !== manifest.specgitNative.sha256) throw new Error('Native binary checksum mismatch. Reinstall the package.');
  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: false });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    // Console Ctrl-C reaches both attached Windows processes. Node's kill(SIGINT)
    // uses TerminateProcess there and would race the native cancellation handler.
    const handler = () => {
      if (process.platform === 'win32' && signal === 'SIGINT') return;
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.once('error', () => fail('Cannot start the installed native executable. Check executable permissions and operating-system compatibility.'));
  child.once('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal && process.platform !== 'win32') process.kill(process.pid, signal);
    else process.exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1);
  });
}
try { main(); } catch (error) { fail(error.message); }
