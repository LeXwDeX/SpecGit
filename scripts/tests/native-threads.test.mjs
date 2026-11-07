import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { libtestThreads } from '../../runtime/scripts/libtest-threads.mjs';

test('windows native qualification uses one libtest contract for source and profile phases', () => {
  assert.equal(libtestThreads('win32', 'tests/hooks.rs'), '1');
  assert.equal(libtestThreads('win32', 'tests/hook_boundaries.rs'), '2');
  assert.equal(libtestThreads('win32', 'src/lib.rs'), '2');
  assert.equal(libtestThreads('linux', 'tests/hooks.rs'), undefined);
  assert.equal(libtestThreads('darwin', 'tests/hooks.rs'), undefined);
  for (const script of ['native-resume.mjs', 'profile-tests.mjs']) {
    const text = readFileSync(new URL(`../../runtime/scripts/${script}`, import.meta.url), 'utf8');
    assert.match(
      text,
      /libtestThreads\(process\.platform, (?:sourcePath|source)\)/,
      `${script} must apply the shared Windows libtest concurrency contract`,
    );
  }
});
