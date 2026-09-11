#!/usr/bin/env node
// Run every Cargo test executable and retain exact test accounting and timings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { assertProfileInventory } from '../distribution/release-artifacts.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, compare: { type: 'string' } } });
if (!values.output) throw new Error('Use --output <new profile directory> [--compare <baseline profile.json>].');
assert(process.env.SPECGIT_TEST_BINARY && process.env.SPECGIT_TEST_LAUNCHER && process.env.SPECGIT_TEST_NODE,
  'Performance qualification requires a separately installed npm entrypoint.');
const output = path.resolve(values.output);
assert(!existsSync(output), 'Select a fresh evidence directory.');
mkdirSync(output, { recursive: true });
const started = performance.now();
// The existing CI test step budget is unchanged, including discovery/build.
const deadline = started + 15 * 60 * 1000;
function run(executable, args) {
  const start = performance.now();
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: Math.max(1, Math.floor(deadline - start)), maxBuffer: 32 * 1024 * 1024 });
  return { ...result, milliseconds: performance.now() - start };
}
const installedNode = run(process.env.SPECGIT_TEST_NODE, ['--version']);
assert.equal(installedNode.status, 0, 'The selected installed Node must be executable.');
assert(/^v\d+\.\d+\.\d+\s*$/.test(installedNode.stdout), 'Unrecognized installed Node version.');
const build = run('cargo', ['test', '--locked', '--all-targets', '--features', 'test-fixtures', '--no-run', '--message-format=json']);
writeFileSync(path.join(output, 'build.log'), (build.stdout ?? '') + (build.stderr ?? ''));
assert.equal(build.status, 0, 'Cargo test discovery/build must succeed.');
const artifacts = build.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.reason === 'compiler-artifact' && row.profile.test && row.executable);
assert(artifacts.length > 0, 'Cargo must enumerate test executables.');
assert.equal(new Set(artifacts.map(row => row.executable)).size, artifacts.length, 'Duplicate test executable.');
const suites = [];
for (const artifact of artifacts.sort((a, b) => a.target.src_path.localeCompare(b.target.src_path))) {
  const source = path.relative(process.cwd(), artifact.target.src_path).split(path.sep).join('/');
  assert(!source.startsWith('../'), 'A test source must belong to this crate.');
  const list = run(artifact.executable, ['--list']);
  assert.equal(list.status, 0, 'Test enumeration failed: ' + source);
  const names = list.stdout.split(/\r?\n/).filter(line => line.endsWith(': test')).map(line => line.slice(0, -6)).sort();
  assert.equal(new Set(names).size, names.length, 'Duplicate test name in ' + source);
  const result = run(artifact.executable, ['--color', 'never']);
  const text = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(path.join(output, `${suites.length}.log`), text);
  const outcomes = [...(result.stdout ?? '').matchAll(/^test (.+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$/gm)].map(match => ({ name: match[1], outcome: match[2] })).sort((a, b) => a.name.localeCompare(b.name));
  const summary = [...(result.stdout ?? '').matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/g)];
  const counts = summary.length === 1 ? summary[0].slice(2).map(Number) : null;
  const accounted = JSON.stringify(outcomes.map(row => row.name).sort()) === JSON.stringify(names)
    && counts && counts[0] + counts[1] + counts[2] === names.length && counts[3] === 0 && counts[4] === 0;
  const passed = result.status === 0 && !result.error && accounted && counts[1] === 0;
  suites.push({ source, name: artifact.target.name, milliseconds: result.milliseconds, enumeration_milliseconds: list.milliseconds, exit: result.status, error: result.error?.code ?? null, passed: Boolean(passed), counts, tests: outcomes });
  process.stdout.write(`${source}: ${result.milliseconds.toFixed(0)} ms, ${passed ? 'passed' : 'FAILED'}, ${names.length} enumerated\n`);
}
const profile = {
  schema_version: 1, platform: process.platform, arch: process.arch,
  artifact_sha256: createHash('sha256').update(readFileSync(process.env.SPECGIT_TEST_BINARY)).digest('hex'),
  launcher_sha256: createHash('sha256').update(readFileSync(process.env.SPECGIT_TEST_LAUNCHER)).digest('hex'),
  node_version: process.version, installed_node_version: installedNode.stdout.trim(), build_milliseconds: build.milliseconds,
  total_milliseconds: performance.now() - started,
  test_processes: suites.length, suites, passed: suites.every(suite => suite.passed),
  timing_scope: 'Each complete test executable, including its real CLI/Git/fixture subprocess work; child timings are not separately attributed.',
};
try {
  assertProfileInventory(profile);
} catch (error) {
  profile.passed = false;
  profile.inventory_error = error.message;
  process.stderr.write(error.message + '\n');
}
if (values.compare) {
  const baseline = JSON.parse(readFileSync(values.compare, 'utf8'));
  const workload = value => value.suites.map(suite => ({ source: suite.source, tests: suite.tests }));
  const equivalent = baseline.passed === true && profile.passed && baseline.platform === profile.platform
    && baseline.arch === profile.arch && baseline.node_version === profile.node_version
    && baseline.installed_node_version === profile.installed_node_version
    && JSON.stringify(workload(baseline)) === JSON.stringify(workload(profile));
  profile.comparison = { equivalent, baseline_milliseconds: baseline.total_milliseconds, candidate_milliseconds: profile.total_milliseconds,
    ratio: equivalent ? profile.total_milliseconds / baseline.total_milliseconds : null };
  if (!equivalent) profile.passed = false;
}
writeFileSync(path.join(output, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
if (!profile.passed) process.exitCode = 1;
