import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PhaseCache } from '../scripts/native-cache.mjs';

test('post-build failure retries without compilation; successful upload retry reuses qualification', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-phase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new PhaseCache(path.join(root, 'receipts'), { source: 'a', toolchain: 'rust' }, root);
  let compilations = 0, executions = 0;
  const build = () => cache.run('compile-tests', [], async () => {
    compilations++;
    const file = path.join(root, 'binary'); writeFileSync(file, 'compiled');
    return { value: file, files: [file] };
  });
  const check = () => cache.run('source-tests', ['compile-tests'], async () => {
    if (++executions === 1) throw new Error('post-build failure');
    const file = path.join(root, 'result'); writeFileSync(file, 'passed');
    return { value: file, files: [file] };
  });
  await build(); await assert.rejects(check, /post-build failure/);
  assert.equal(cache.get('source-tests'), null);
  await build(); await check();
  await build(); await check();
  assert.equal(compilations, 1); assert.equal(executions, 2);
  writeFileSync(path.join(root, 'binary'), 'changed');
  assert.equal(cache.get('compile-tests'), null); assert.equal(cache.get('source-tests'), null);
  await build();
  rmSync(path.join(root, 'binary'));
  assert.equal(cache.get('compile-tests'), null);
});

test('source and toolchain changes invalidate receipts', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = path.join(root, 'receipts'), file = path.join(root, 'binary');
  writeFileSync(file, 'compiled');
  const original = new PhaseCache(receipt, { source: 'a', toolchain: 'one' }, root);
  await original.run('compile-tests', [], async () => ({ value: file, files: [file] }));
  assert(new PhaseCache(receipt, { source: 'a', toolchain: 'one' }, root).get('compile-tests'));
  assert.equal(new PhaseCache(receipt, { source: 'b', toolchain: 'one' }, root).get('compile-tests'), null);
  assert.equal(new PhaseCache(receipt, { source: 'a', toolchain: 'two' }, root).get('compile-tests'), null);
});
