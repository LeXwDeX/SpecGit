import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #68: the merge guard must surface the verdict it acts on. A blocked
 * merge prints a concise summary naming pending (transient) and failed
 * checks, the guard's own wait is bounded by a budget derived from the
 * configured gh timeout, and a budget expiry is reported as "no verdict",
 * never as a rejection. Verified against the checked-in guard script by
 * spawning it with a fake `specgit` shim on PATH.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUARD = path.join(ROOT, '.opencode', 'hooks', 'specgit-merge-guard.sh');

const SHIM = `#!/bin/sh
# Fake specgit: behavior is driven by FAKE_SPECGIT_* env vars.
[ -n "$FAKE_SPECGIT_SLEEP_S" ] && sleep "$FAKE_SPECGIT_SLEEP_S"
[ -n "$FAKE_SPECGIT_STDOUT_FILE" ] && cat "$FAKE_SPECGIT_STDOUT_FILE"
[ -n "$FAKE_SPECGIT_STDERR_FILE" ] && cat "$FAKE_SPECGIT_STDERR_FILE" >&2
exit "\${FAKE_SPECGIT_EXIT:-0}"
`;

const ACCEPTED_ENVELOPE = {
  tool: 'specgit',
  version: 1,
  command: 'finish',
  status: 'ok',
  state: 'accepted',
  verdict: { classification: 'accepted', exitCode: 0 },
  gates: [],
  errors: [],
};

const REJECTED_ENVELOPE = {
  tool: 'specgit',
  version: 1,
  command: 'finish',
  status: 'ok',
  state: 'rejected',
  verdict: { classification: 'rejected', exitCode: 1 },
  gates: [
    {
      id: 'checks',
      status: 'fail',
      failures: [
        {
          code: 'checks_pending',
          message: 'A required check has not completed at the PR head (transient).',
          detail: { name: 'Test (linux-bash)', status: 'in_progress' },
        },
        {
          code: 'checks_failed',
          message: 'A required check failed at the PR head.',
          detail: { name: 'Lint & Type Check', conclusion: 'action_required' },
        },
      ],
    },
  ],
  errors: [],
};

const UNKNOWN_ENVELOPE = {
  tool: 'specgit',
  version: 1,
  command: 'finish',
  status: 'ok',
  state: 'unknown',
  verdict: { classification: 'unknown', exitCode: 3 },
  gates: [],
  errors: [{ code: 'gh_transport', message: 'GitHub evidence could not be gathered.' }],
};

interface GuardResult {
  code: number | null;
  stderr: string;
  stdout: string;
  elapsedMs: number;
}

let binDir: string;

function writeEnvelope(name: string, value: unknown): string {
  const file = path.join(binDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf-8');
  return file;
}

function runGuard(
  command: string,
  env: Record<string, string> = {},
  timeoutMs = 30_000
): Promise<GuardResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child =
      launchMode === 'sh'
        ? spawn('sh', [GUARD], {
            env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(GUARD, {
            env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`guard did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout, elapsedMs: Date.now() - started });
    });
    child.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}

// POSIX runs the script directly (shebang + exec bit); Windows runs it
// through sh when git-bash is available, and skips otherwise — the guard
// is a POSIX-shell artifact and cannot be exec'd natively there.
const launchMode: 'direct' | 'sh' | null = (() => {
  const shProbe = spawnSync('sh', ['-c', 'exit 0']);
  if (process.platform === 'win32') {
    return shProbe.status === 0 && !shProbe.error ? 'sh' : null;
  }
  if (shProbe.error) return null;
  try {
    fs.accessSync(GUARD, fs.constants.X_OK);
    return 'direct';
  } catch {
    return 'sh';
  }
})();

const itOrSkip = launchMode ? it : it.skip;

describe('merge guard diagnostics (#68)', () => {
  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-guard-'));
    fs.writeFileSync(path.join(binDir, 'specgit'), SHIM, { mode: 0o755 });
  });

  afterAll(() => {
    // The budget-expiry test leaves an orphaned `sleep` behind briefly;
    // on Windows that races directory deletion (ENOTEMPTY). Retries make
    // cleanup best-effort instead of a test failure.
    try {
      fs.rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp dir; the OS reclaims it */
    }
  });

  itOrSkip('lets an accepted verdict through', async () => {
    const result = await runGuard('gh pr merge 82 --squash', {
      FAKE_SPECGIT_EXIT: '0',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('accepted', ACCEPTED_ENVELOPE),
    });
    expect(result.code).toBe(0);
  });

  itOrSkip('blocks a rejected merge naming pending and failed checks', async () => {
    const result = await runGuard('gh pr merge 82 --squash', {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('rejected', REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(2);
    const err = result.stderr;
    expect(err).toMatch(/rejected/i);
    // The summary names the pending check as transient (wait-and-retry)...
    expect(err).toMatch(/pending \(transient[^\n]*Test \(linux-bash\)/);
    // ...and the failed check with its conclusion.
    expect(err).toMatch(/failed[^\n]*Lint & Type Check/);
    expect(err).toMatch(/action_required/);
    expect(err).toMatch(/specgit finish/);
  });

  itOrSkip('blocks an unknown verdict without calling it a rejection', async () => {
    const result = await runGuard('gh pr merge 82 --squash', {
      FAKE_SPECGIT_EXIT: '3',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('unknown', UNKNOWN_ENVELOPE),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no verdict/i);
    expect(result.stderr).toMatch(/not a rejection/i);
  });

  itOrSkip('reports budget expiry as no verdict, bounded and honest', async () => {
    // gh budget 2s; an override of 1s must be clamped up to the gh budget
    // (#68: the guard budget is never shorter than the configured gh
    // timeout). The shim outlives the budget, so the guard must cut it off.
    const result = await runGuard('gh pr merge 82 --squash', {
      FAKE_SPECGIT_EXIT: '0',
      FAKE_SPECGIT_SLEEP_S: '6',
      SPECGIT_GH_TIMEOUT_MS: '2000',
      SPECGIT_GUARD_BUDGET_S: '1',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/budget 2s/);
    expect(result.stderr).toMatch(/says nothing about the delivery/);
    expect(result.elapsedMs).toBeLessThan(5500);
  }, 20_000);

  itOrSkip('ignores non-merge commands without a verdict', async () => {
    const result = await runGuard('git status', {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('rejected', REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  itOrSkip('still blocks direct pushes to main', async () => {
    const result = await runGuard('git push origin main');
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not the delivery path/);
  });
});
