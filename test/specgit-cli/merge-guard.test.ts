import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GUARD_SCRIPT } from '../../src/cli/harness-content.js';
import { git, initRepo } from '../specgit/helpers/temp-repo.js';

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
let guardRepo: ReturnType<typeof initRepo>;

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
            cwd: guardRepo.root,
            env: { ...process.env, ...guardRepo.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(GUARD, {
            cwd: guardRepo.root,
            env: { ...process.env, ...guardRepo.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
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
    guardRepo = initRepo(binDir);
    git(guardRepo.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], guardRepo.env);
    git(guardRepo.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], guardRepo.env);
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

  it('keeps the checked-in runtime guard byte-identical to the generator', () => {
    expect(fs.readFileSync(GUARD, 'utf8').replace(/\r\n/g, '\n')).toBe(GUARD_SCRIPT);
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
    expect(result.stderr).toContain('errors[].fix');
    expect(result.stderr).toMatch(/doctor.*only for git, repository, origin, configured provider CLI\/auth, or policy/i);
  });

  itOrSkip('uses the slower forge timeout and reports budget expiry as no verdict', async () => {
    // gh is 1s and glab is 1.999s; an override of 1s must be rounded up and
    // clamped to 2s for the slower provider. This catches both a GitHub-only
    // calculation and a millisecond-to-second floor. The shim outlives the
    // budget, so the guard must cut it off.
    const result = await runGuard('gh pr merge 82 --squash', {
      FAKE_SPECGIT_EXIT: '0',
      FAKE_SPECGIT_SLEEP_S: '6',
      SPECGIT_GH_TIMEOUT_MS: '1000',
      SPECGIT_GLAB_TIMEOUT_MS: '1999',
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

  itOrSkip('routes a glab merge through the same verdict (#369)', async () => {
    const result = await runGuard('glab mr merge 82 --squash', {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('rejected-glab', REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/rejected/i);
    expect(result.stderr).toMatch(/pending \(transient/);
  });

  itOrSkip.each([
    ['github', 'gh -R owner/repo pr merge 82 --squash'],
    ['gitlab', 'glab -R owner/repo mr merge 82 --squash'],
  ])('routes a %s merge with a leading repository selector through the verdict', async (provider, command) => {
    const result = await runGuard(command, {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope(`rejected-${provider}-repo`, REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/rejected/i);
  });

  itOrSkip.each([
    ['github', 'env GH_HOST=github.example.test gh pr merge 82 --squash'],
    ['gitlab', 'env GITLAB_HOST=gitlab.example.test glab mr merge 82 --squash'],
  ])('routes a %s merge with an environment wrapper through the verdict', async (provider, command) => {
    const result = await runGuard(command, {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope(`rejected-${provider}-env`, REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/rejected/i);
  });

  itOrSkip.each([
    ['github', 'cd /tmp/repo && gh pr merge 82 --squash'],
    ['gitlab', 'cd /tmp/repo && glab mr merge 82 --squash'],
  ])('routes a %s merge after a directory change through the verdict', async (provider, command) => {
    const result = await runGuard(command, {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope(`rejected-${provider}-cd`, REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/rejected/i);
  });

  itOrSkip.each([
    ['quoted GitHub prose', 'echo "gh pr merge 82"'],
    ['quoted GitLab prose', "printf '%s\\n' 'glab mr merge 82'"],
  ])('does not treat %s as a forge merge command', async (_description, command) => {
    const result = await runGuard(command, {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('quoted-prose', REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  itOrSkip('fails closed when the merge-command classifier cannot parse the shell input', async () => {
    const result = await runGuard("gh pr merge 82 '");
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/could not safely classify/i);
  });

  itOrSkip('blocks every push form that targets main (#369)', async () => {
    for (const command of [
      'git push origin main',
      'git push origin +main',
      'git push origin HEAD:main',
    ]) {
      const result = await runGuard(command);
      expect(result.code, command).toBe(2);
      expect(result.stderr, command).toMatch(/not the delivery path/);
    }
  });

  itOrSkip('lets a push to a delivery branch through untouched (#369)', async () => {
    // Negative control: the rejected envelope would exit 2 if the guard
    // wrongly verdict-routed this command, so exit 0 with empty stderr
    // proves the passthrough.
    const result = await runGuard('git push origin fix/368-align-generated-agent', {
      FAKE_SPECGIT_EXIT: '1',
      FAKE_SPECGIT_STDOUT_FILE: writeEnvelope('rejected-push', REJECTED_ENVELOPE),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});

// ---- start gate (#335): file-mutation tools require a delivery binding ----

/** Runs the guard with a raw hook payload, optionally inside another cwd. */
function runGuardPayload(payload: unknown, cwd?: string): Promise<GuardResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child =
      launchMode === 'sh'
        ? spawn('sh', [GUARD], { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(GUARD, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('guard did not exit within 15000ms'));
    }, 15_000);
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
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('start gate (#335): edits require a delivery binding', () => {
  let gateRepo: string;

  const git = (args: string[]): void => {
    const probe = spawnSync('git', args, { cwd: gateRepo });
    if (probe.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${probe.stderr.toString()}`);
    }
  };

  beforeAll(() => {
    if (!launchMode) return;
    gateRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-start-gate-'));
    git(['init']);
    git(['checkout', '-b', 'gate-main']);
    git(['config', 'user.email', 'gate@example.com']);
    git(['config', 'user.name', 'Gate']);
    fs.writeFileSync(path.join(gateRepo, 'seed.txt'), 'seed\n');
    git(['add', '.']);
    git(['commit', '-m', 'seed']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  });

  afterAll(() => {
    try {
      fs.rmSync(gateRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp dir; the OS reclaims it */
    }
  });

  const editPayload = (tool: string): unknown => ({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { file_path: path.join(gateRepo, 'seed.txt') },
  });

  itOrSkip('blocks an edit with no binding record, naming the way forward', async () => {
    const result = await runGuardPayload(editPayload('edit'), gateRepo);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/specgit issue/);
  });

  itOrSkip('blocks a write with no binding record', async () => {
    const result = await runGuardPayload(editPayload('write'), gateRepo);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/specgit issue/);
  });

  itOrSkip('passes an edit whose record binds this branch', async () => {
    fs.writeFileSync(
      path.join(gateRepo, '.specgit.yaml'),
      'version: 1\ndelivery: gate\ncontext:\n  kind: branch\n  branch: gate-main\nissues:\n  - 1\n'
    );
    const result = await runGuardPayload(editPayload('edit'), gateRepo);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  itOrSkip('blocks an edit whose record binds a different branch', async () => {
    fs.writeFileSync(
      path.join(gateRepo, '.specgit.yaml'),
      'version: 1\ndelivery: gate\ncontext:\n  kind: branch\n  branch: feat/other\nissues:\n  - 1\n'
    );
    const result = await runGuardPayload(editPayload('edit'), gateRepo);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/specgit issue/);
  });

  itOrSkip('a prefix of the recorded branch never satisfies the gate', async () => {
    // On gate-main with a record for gate-main-extra: a substring match
    // would let the edit through — the whole-line anchor must not.
    fs.writeFileSync(
      path.join(gateRepo, '.specgit.yaml'),
      'version: 1\ndelivery: gate\ncontext:\n  kind: branch\n  branch: gate-main-extra\nissues:\n  - 1\n'
    );
    const result = await runGuardPayload(editPayload('edit'), gateRepo);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/specgit issue/);
  });

  itOrSkip('a tool outside the guard matcher falls through untouched', async () => {
    fs.writeFileSync(
      path.join(gateRepo, '.specgit.yaml'),
      'version: 1\ndelivery: gate\ncontext:\n  kind: branch\n  branch: gate-main\nissues:\n  - 1\n'
    );
    const result = await runGuardPayload(
      { hook_event_name: 'PreToolUse', tool_name: 'grep', tool_input: {} },
      gateRepo
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  itOrSkip('blocks an edit on a detached HEAD even with a record', async () => {
    fs.writeFileSync(
      path.join(gateRepo, '.specgit.yaml'),
      'version: 1\ndelivery: gate\ncontext:\n  kind: branch\n  branch: gate-main\nissues:\n  - 1\n'
    );
    git(['checkout', '--detach']);
    const result = await runGuardPayload(editPayload('edit'), gateRepo);
    git(['checkout', 'gate-main']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/specgit issue/);
  });

  itOrSkip('lets non-mutation bash commands through unchanged', async () => {
    const result = await runGuardPayload(
      { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'git status' } },
      gateRepo
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  itOrSkip('bash merge behaviour is untouched by the start gate', async () => {
    const result = await runGuardPayload(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'bash',
        tool_input: { command: 'git push origin main' },
      },
      gateRepo
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not the delivery path/);
  });
});
