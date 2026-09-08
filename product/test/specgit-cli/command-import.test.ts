import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { cliProjectRoot, ensureCliBuilt } from '../helpers/run-cli.js';

describe('native ESM command imports', () => {
  beforeAll(ensureCliBuilt);

  it.each(['commands/issue.js', 'index.js'])('imports %s in a fresh Node process', (entry) => {
    const moduleUrl = pathToFileURL(path.join(cliProjectRoot, 'dist', 'cli', entry)).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', 'await import(process.argv[1]);', moduleUrl],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true }
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
