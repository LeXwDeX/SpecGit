import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const script = path.resolve('scripts/windows-install-probe.mjs');
const marker = 'FAKE-SENSITIVE-DIAGNOSTIC-MARKER';

describe('Windows diagnostic output boundary', () => {
  it('bootstraps cached pwsh using the built-in Windows shell', () => {
    const workflow = parse(readFileSync('.github/workflows/rc-verify.yml', 'utf8'));
    const job = workflow.jobs['windows-diagnostics'];
    expect(job.defaults.run.shell).toBe('pwsh');
    expect(job.steps[0].shell).toBe('powershell');
    expect(job.steps[0].run).toContain("'PowerShell\\7.6.6\\x64'");
    expect(job.steps[0].run).toContain('$env:GITHUB_PATH');
    expect(job.steps[0].run).not.toContain('Invoke-WebRequest');
  });
  it('withholds npm metadata and Vitest failures, stacks, names, and console output', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'specgit-diag-redaction-'));
    try {
      mkdirSync(path.join(root, 'raw'));
      mkdirSync(path.join(root, 'npm-raw'));
      writeFileSync(path.join(root, 'raw', 'vitest-console.log'), marker);
      writeFileSync(path.join(root, 'raw', 'vitest.json'), JSON.stringify({
        numTotalTests: 1, numPassedTests: 0, numFailedTests: 1,
        console: marker, failureMessage: marker,
        testResults: [{ name: marker, message: marker, startTime: 10, endTime: 30,
          assertionResults: [{ fullName: marker, status: 'failed', duration: 20,
            failureMessages: [marker], stack: marker, console: marker }],
        }],
      }));
      writeFileSync(path.join(root, 'npm-raw', 'sample-timing.json'), JSON.stringify({
        metadata: { argv: [marker] }, timers: { npm: 42, 'reify:unpack': 21, [marker]: 1 },
      }));
      const stdout = execFileSync(process.execPath, [script, root, '--sanitize-only'], { encoding: 'utf8' });
      const files = readdirSync(path.join(root, 'public'));
      expect(files.sort()).toEqual(['npm-timers.json', 'vitest-summary.json']);
      expect(stdout).not.toContain(marker);
      for (const file of files) expect(readFileSync(path.join(root, 'public', file), 'utf8')).not.toContain(marker);
      const summary = JSON.parse(readFileSync(path.join(root, 'public', 'vitest-summary.json'), 'utf8'));
      expect(summary.counts.numFailedTests).toBe(1);
      expect(summary.suites[0].tests).toEqual([{ id: 0, duration: 20, status: 'failed' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not echo malformed raw JSON in a parse error', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'specgit-diag-malformed-'));
    try {
      mkdirSync(path.join(root, 'raw'));
      writeFileSync(path.join(root, 'raw', 'vitest.json'), marker);
      const result = spawnSync(process.execPath, [script, root, '--sanitize-only'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(marker);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('routes the complete Vitest report and all native output outside uploaded files', () => {
    const driver = readFileSync('scripts/windows-install-diagnose.ps1', 'utf8');
    expect(driver).not.toContain('--reporter=default');
    expect(driver).toContain('--outputFile.json="$testRaw/vitest.json" *> "$testRaw/vitest-console.log"');
    expect(driver).toContain('$diagnosticRoot *> "$testRaw/control-console.log"');
    expect(driver).toContain('--sanitize-only *> "$testRaw/sanitize-console.log"');
  });
});
