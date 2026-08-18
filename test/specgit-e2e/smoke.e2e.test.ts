/**
 * CLI package smoke tests: the shipped artifact (`bin/specgit.js` →
 * `dist/cli/index.js`) starts, reports the package identity, exposes exactly
 * the SpecGit command surface, and honors the single-JSON envelope contract.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { parseEnvelope, specgit } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('specgit CLI package smoke', () => {
  it('--version prints the package version and exits 0', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    const result = await specgit(['--version'], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(pkg.name).toBe('specgit');
    expect(pkg.bin).toEqual({ specgit: './bin/specgit.js' });
  });

  it('--help lists exactly the nine SpecGit commands', async () => {
    const result = await specgit(['--help'], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    const commandLines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /^(init|issue|pr|finish|bind|unbind|status|accept|doctor)\b/.test(line)
      );
    expect(commandLines.length).toBeGreaterThanOrEqual(9);
    for (const retired of ['archive', 'propose', 'validate', 'continue', 'completion', 'show']) {
      const hasRetired = result.stdout
        .split(/\r?\n/)
        .some((line) => new RegExp(`^\\s+${retired}\\b`).test(line));
      expect(hasRetired, `help must not list retired command ${retired}`).toBe(false);
    }
  });

  it('an unknown command is a usage error (exit 2)', async () => {
    const result = await specgit(['definitely-not-a-command'], { cwd: projectRoot });
    expect(result.exitCode).toBe(2);
  });

  it('outside git: exactly one JSON document on stdout, exit 3 (--json keeps stderr clean)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-e2e-nogit-'));
    cleanupDirs.push(dir);

    const result = await specgit(['status', '--json'], { cwd: dir });

    expect(result.exitCode).toBe(3);
    const envelope = parseEnvelope(result);
    expect(envelope.tool).toBe('specgit');
    expect(envelope.command).toBe('status');
    expect(envelope.status).toBe('unknown');
    expect((envelope.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'not_a_git_repo'
    );
    expect(result.stderr.trim()).toBe('');

    const human = await specgit(['status'], { cwd: dir });
    expect(human.exitCode).toBe(3);
    expect(human.stdout.trim()).toBe('');
    expect(human.stderr).toContain('Error: Not inside a git repository.');
    expect(human.stderr).toContain('Fix:');
  });

  it('the library entry (dist/index.js) exports the SpecGit public API', () => {
    const entryUrl = pathToFileURL(path.join(projectRoot, 'dist', 'index.js')).href;
    const script = `
      import(${JSON.stringify(entryUrl)}).then((mod) => {
        const required = ['runCli', 'evaluate', 'parseClosingRefs', 'discoverRepoRoot', 'LocalGitAdapter', 'GhCliGitHubProvider', 'CODE_INFO'];
        const missing = required.filter((name) => typeof mod[name] === 'undefined');
        if (missing.length > 0) {
          console.error('missing exports: ' + missing.join(', '));
          process.exit(1);
        }
        const refs = mod.parseClosingRefs('Closes #1 and fixes #2');
        if ([...refs].sort((a, b) => a - b).join(',') !== '1,2') {
          console.error('parseClosingRefs produced unexpected result');
          process.exit(1);
        }
        console.log('exports-ok');
      });
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
    });
    expect(stdout.trim()).toBe('exports-ok');
  });

  it('bin/specgit.js is executable and wired to the dist entry', () => {
    const binSource = fs.readFileSync(path.join(projectRoot, 'bin', 'specgit.js'), 'utf-8');
    expect(binSource).toContain("dist/cli/index.js");
    expect(fs.existsSync(path.join(projectRoot, 'bin', 'openspec.js'))).toBe(false);
  });
});
