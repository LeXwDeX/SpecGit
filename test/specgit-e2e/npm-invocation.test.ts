/**
 * Issue #88 finding 4 (88-4) — harden the external-repo fixture's npm
 * invocation quoting for Windows.
 *
 * The legacy runner spawned `npm.cmd` through a shell on win32 and
 * hand-quoted arguments containing whitespace. That quoting is cmd.exe
 * dialect (it survives only because the CI leg wraps everything in
 * pwsh, which defers to cmd for .cmd spawnables): copied by hand into
 * any other Windows shell it breaks on embedded quotes, cmd
 * metacharacters, or trailing-backslash paths.
 *
 * The hardened runner never spawns a shell at all: it execs the running
 * Node against npm's `npm-cli.js`, so arguments travel as argv and no
 * shell ever re-parses them. These tests pin that contract on every
 * platform, plus the verbatim survival of the legacy fallback.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  npmInvocation,
  quoteForWindowsShell,
  resolveNpmCli,
  runNpm,
} from './external-repo-fixture.js';

describe('resolveNpmCli (#88 finding 4)', () => {
  it('resolves an existing npm-cli.js on this host', () => {
    const cli = resolveNpmCli();
    expect(cli).toBeDefined();
    expect(path.basename(cli as string)).toBe('npm-cli.js');
    expect(fs.existsSync(cli as string)).toBe(true);
  });
});

describe('npmInvocation (#88 finding 4)', () => {
  it('is shell-free with the running Node as the command when npm-cli.js resolves', () => {
    const plan = npmInvocation(['install', '--no-save']);
    expect(plan.resolved).toBe(true);
    expect(plan.shell).toBe(false);
    expect(plan.command).toBe(process.execPath);
    const cli = resolveNpmCli() as string;
    expect(plan.args[0]).toBe(cli);
    expect(plan.args.slice(1)).toEqual(['install', '--no-save']);
  });

  it('passes argv verbatim — no quoting even for spaces, quotes, or cmd metacharacters', () => {
    const hostile = '--pack-destination=C:\\Users\\a b&c "^&|<>%" x\\';
    const plan = npmInvocation([hostile]);
    expect(plan.args[1]).toBe(hostile);
  });

  it('keeps the legacy npm spawn (no shell on POSIX) when npm-cli.js cannot be resolved', () => {
    const plan = npmInvocation(['a b'], null);
    expect(plan.resolved).toBe(false);
    if (process.platform !== 'win32') {
      expect(plan.command).toBe('npm');
      expect(plan.shell).toBe(false);
      expect(plan.args).toEqual(['a b']);
    }
  });
});

describe('quoteForWindowsShell — legacy fallback pinned verbatim (#88 finding 4)', () => {
  it('quotes only arguments containing whitespace', () => {
    expect(quoteForWindowsShell('install')).toBe('install');
    expect(quoteForWindowsShell('a b')).toBe('"a b"');
  });
});

describe('runNpm behavioral contract (#88 finding 4)', () => {
  it(
    'executes npm through the shell-free plan and returns stdout',
    { timeout: 60_000 },
    async () => {
      const out = await runNpm(['--version'], fs.mkdtempSync(path.join(os.tmpdir(), 'npm-inv-')));
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }
  );
});
