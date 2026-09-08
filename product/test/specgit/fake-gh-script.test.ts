import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeGh } from './helpers/fake-gh.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

// The fake-gh double is a real script file, not an inline string (#189):
// the committed source of truth lives next to the helper, and whatever the
// helper materializes into the temp bin dir must be exactly that file, so
// the script keeps syntax highlighting, typecheck (checkJs), and diffs.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(TEST_DIR, 'helpers', 'fake-gh-script.cjs');

describe('fake-gh script extraction (#189)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-fake-gh-script-');
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('the fake gh implementation is a committed script file with a POSIX node shebang', () => {
    expect(fs.existsSync(SCRIPT_PATH), 'fake-gh-script.cjs must exist').toBe(true);
    const source = fs.readFileSync(SCRIPT_PATH, 'utf-8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    // The file carries the full scripted-recorder behavior, not a stub.
    expect(source).toContain('FAKE_GH_CONFIG');
    expect(source).toContain('%SEQ%');
  });

  it('the helper materializes exactly the committed script file', () => {
    const fake = createFakeGh(tempDir, [{ match: '^--version$', stdout: 'gh version 2.60.0\n' }]);
    const materialized = fs.readFileSync(path.join(fake.binDir, 'fake-gh.cjs'), 'utf-8');
    expect(materialized).toBe(fs.readFileSync(SCRIPT_PATH, 'utf-8'));
  });
});
