import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runDistributionTests } from '../scripts/distribution-tests.mjs';

test('distribution failures retain raw output locally and identify the failed file without leaking it', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'specgit-distribution-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const run = (_executable, args) => {
    calls.push(args);
    return { status: args.at(-1).includes('bad') ? 1 : 0, stdout: 'private diagnostic', stderr: 'private path' };
  };
  assert.throws(() => runDistributionTests(['bad.test.mjs', 'good.test.mjs'], directory, { run }), error => {
    assert.match(error.message, /bad\.test\.mjs: exit 1/);
    assert(!error.message.includes('private'));
    assert(!error.message.includes('good.test.mjs'));
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(readFileSync(path.join(directory, 'bad.test.mjs.log'), 'utf8'), 'private diagnosticprivate path');
  assert.throws(() => runDistributionTests(['../foreign.test.mjs'], directory, { run }), /Unexpected/);
  assert.throws(() => runDistributionTests(['spawn.test.mjs'], directory, { run: () => ({ status: null, error: new Error('private spawn failure') }) }), /exit unknown/);
});
