import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaths, classifyEntries, inspectChanges } from '../ci-change-scope.mjs';
test('ordinary documentation uses metadata while shipped references and unknown files need native tests', () => {
  assert.equal(classifyPaths(['README.md', 'docs/ci-scope.md']).metadata, true);
  for (const file of ['runtime/REFERENCE.md', 'runtime/src/main.rs', 'runtime/tests/watch.rs', '.github/workflows/ci.yml', 'scripts/tests/scope.test.mjs', 'unknown.txt', 'docs/../runtime/src/main.rs']) assert.equal(classifyPaths([file]).build, true, file);
});
test('native and private dependency changes request security checks', () => {
  for (const file of ['runtime/Cargo.toml', 'runtime/Cargo.lock', 'package.json', 'pnpm-lock.yaml']) assert.equal(classifyPaths([file]).dependencies, true, file);
});
test('moving source into docs cannot hide the source deletion', () => {
  assert.equal(classifyEntries([{ status: 'D', path: 'runtime/src/main.rs' }, { status: 'A', path: 'docs/main.md' }]).build, true);
});
test('local output cannot be introduced as tracked evidence, removal is allowed', () => {
  assert.throws(() => classifyEntries([{ status: 'A', path: '.local/evidence.json' }]));
  assert.equal(classifyEntries([{ status: 'D', path: '.local/evidence.json' }]).metadata, true);
});
test('missing committed range evidence fails closed', () => {
  assert.throws(() => inspectChanges({ base: 'HEAD' }), /both/);
});
