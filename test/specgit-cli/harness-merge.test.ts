import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ACCEPTANCE_CHECK_NAME,
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  HOOKS_JSON_PATH,
  managedPromptBlock,
  mergeGitPrePush,
  mergeHooksJson,
} from '../../src/cli/harness-content.js';
import {
  GUARD_SCRIPT_PATH,
  HARNESS_WORKFLOW_PATH,
  writeHarnessAssets,
} from '../../src/cli/harness-placement.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const WORKFLOW_ABS = (root: string) => path.join(root, ...HARNESS_WORKFLOW_PATH.split('/'));
const AGENTS_ABS = (root: string) => path.join(root, 'AGENTS.md');
const HOOKS_JSON_ABS = (root: string) => path.join(root, ...HOOKS_JSON_PATH.split('/'));
const GUARD_SCRIPT_ABS = (root: string) => path.join(root, ...GUARD_SCRIPT_PATH.split('/'));

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

const USER_HOOKS_JSON = `{
  "SessionStart": [
    {
      "matcher": "",
      "hooks": [{ "type": "command", "command": "greet.sh" }]
    }
  ],
  "custom-top-level": { "kept": true }
}
`;

const USER_PRE_PUSH = `#!/bin/sh
# Team policy: never push broken builds.
./scripts/verify.sh || exit 1
`;

// The managed layout as #62 first shipped it: the start marker on line
// 1 and the shebang buried on line 2. POSIX shells fall back to sh on
// ENOEXEC so it worked there, but git on Windows execs the hook
// directly and cannot spawn it ("Exec format error") — installs from
// that era must be upgraded by re-running init.
const OLD_LAYOUT_PRE_PUSH = `# >>> specgit:start >>>
#!/bin/sh
# SpecGit pre-push guard (managed by specgit init).
while read -r local_ref local_sha remote_ref remote_sha; do
  case "\$remote_ref" in
    refs/heads/main)
      echo "specgit: direct push to main is not the delivery path." >&2
      echo "Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
      exit 1
      ;;
  esac
done
exit 0
# <<< specgit:end <<<
`;

describe('mergeHooksJson', () => {
  it('returns the canonical hooks.json for a fresh install', () => {
    const result = mergeHooksJson(null);
    expect(result.warning).toBeUndefined();
    const parsed = JSON.parse(result.json) as Record<string, unknown>;
    expect(parsed).toHaveProperty('PreToolUse');
    expect(result.json.endsWith('\n')).toBe(true);
  });

  it('preserves user entries and top-level keys, adding the specgit guard once', () => {
    const first = mergeHooksJson(USER_HOOKS_JSON);
    expect(first.warning).toBeUndefined();
    const parsed = JSON.parse(first.json) as {
      SessionStart: unknown[];
      'custom-top-level': unknown;
      PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    };
    expect(parsed.SessionStart).toHaveLength(1);
    expect(parsed['custom-top-level']).toEqual({ kept: true });
    // The guard is located by its command (ownership), and its matcher
    // covers the file-mutation tools too (#335).
    const guards = parsed.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command === '.opencode/hooks/specgit-merge-guard.sh')
    );
    expect(guards).toHaveLength(1);
    expect(guards[0]?.matcher).toBe('Bash|Edit|Write');
    expect(guards[0]?.hooks).toHaveLength(1);
    expect(guards[0]?.hooks[0]?.command).toBe('.opencode/hooks/specgit-merge-guard.sh');
  });

  it('is byte-stable across repeated merges of its own output', () => {
    const first = mergeHooksJson(USER_HOOKS_JSON);
    const second = mergeHooksJson(first.json);
    expect(second.json).toBe(first.json);
    expect(second.warning).toBeUndefined();
  });

  it('leaves invalid JSON untouched and reports a warning', () => {
    const broken = '{ "PreToolUse": [ oops';
    const result = mergeHooksJson(broken);
    expect(result.json).toBe(broken);
    expect(result.warning).toBeDefined();
  });

  it('refuses to merge a non-object top level and preserves the bytes', () => {
    const arrayTop = '[1, 2, 3]\n';
    const result = mergeHooksJson(arrayTop);
    expect(result.json).toBe(arrayTop);
    expect(result.warning).toBeDefined();
  });
});

describe('mergeGitPrePush', () => {
  // ---- accepted-tip mirror sync (#343): the guard must allow pushing a
  // ---- commit that is already merged into origin/main, while an
  // ---- unmerged tip stays blocked. Verified by spawning the generated
  // ---- body inside a real temp repo with a fake origin ref.
  describe('accepted-tip mirror sync (#343)', () => {
    let repo: string;
    let acceptedSha: string;
    let unmergedSha: string;

    const git = (args: string[]): string => {
      const probe = spawnSync('git', args, { cwd: repo });
      if (probe.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${probe.stderr.toString()}`);
      }
      return probe.stdout.toString();
    };

    const runHook = (sha: string): number => {
      const hook = path.join(repo, 'pre-push-guard.sh');
      fs.writeFileSync(hook, mergeGitPrePush(null), { mode: 0o755 });
      const probe = spawnSync(
        'sh',
        [hook],
        {
          cwd: repo,
          input: `refs/heads/main ${sha} refs/heads/main ${sha}\n`,
        }
      );
      return probe.status ?? -1;
    };

    beforeEach(() => {
      repo = makeTempDir('specgit-mirror-sync-');
      git(['init']);
      git(['config', 'user.email', 'gate@example.com']);
      git(['config', 'user.name', 'Gate']);
      fs.writeFileSync(path.join(repo, 'accepted.txt'), 'accepted\n');
      git(['add', '.']);
      git(['commit', '-m', 'accepted']);
      acceptedSha = git(['rev-parse', 'HEAD']).trim();
      // A fake origin/main that already contains the accepted commit.
      git(['update-ref', 'refs/remotes/origin/main', acceptedSha]);
      git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      // An unmerged commit (the delivery-branch tip a bypass would push).
      fs.writeFileSync(path.join(repo, 'unmerged.txt'), 'unmerged\n');
      git(['add', '.']);
      git(['commit', '-m', 'unmerged']);
      unmergedSha = git(['rev-parse', 'HEAD']).trim();
    });

    afterEach(() => {
      rmDir(repo);
    });

    it('allows pushing a commit origin/main already contains', () => {
      expect(runHook(acceptedSha)).toBe(0);
    });

    it('still blocks pushing an unmerged tip', () => {
      const status = runHook(unmergedSha);
      expect(status).not.toBe(0);
    });

    it('still blocks a zero sha (ref deletion)', () => {
      expect(runHook('0000000000000000000000000000000000000000')).not.toBe(0);
    });
  });

  it('fresh install is the guard wrapped in managed markers', () => {
    const managed = mergeGitPrePush(null);
    expect(managed).toContain('# >>> specgit:start >>>');
    expect(managed).toContain('# <<< specgit:end <<<');
    expect(managed).toContain('SpecGit pre-push guard');
    expect(managed.endsWith('\n')).toBe(true);
  });

  it('preserves an existing user script after the managed preflight', () => {
    const managed = mergeGitPrePush(USER_PRE_PUSH);
    expect(managed.endsWith(USER_PRE_PUSH.slice('#!/bin/sh\n'.length))).toBe(true);
    expect(managed).toContain('verify.sh');
    expect(managed).toContain('# >>> specgit:start >>>');
    expect(managed.indexOf('verify.sh')).toBeGreaterThan(managed.indexOf('# <<< specgit:end <<<'));
  });

  it('replaces only the managed region on re-merge (byte-stable)', () => {
    const first = mergeGitPrePush(USER_PRE_PUSH);
    const second = mergeGitPrePush(first);
    expect(second).toBe(first);
  });

  it('upgrades a legacy unmarked specgit pre-push to the marked form', () => {
    const legacy = `#!/bin/sh
# SpecGit pre-push guard (managed by specgit init).
while read -r local_ref local_sha remote_ref remote_sha; do
  case "\$remote_ref" in
    refs/heads/main)
      echo "specgit: direct push to main is not the delivery path." >&2
      echo "Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
      exit 1
      ;;
  esac
done
exit 0
`;
    const managed = mergeGitPrePush(legacy);
    expect(managed).toBe(mergeGitPrePush(null));
    expect(countOccurrences(managed, 'while read')).toBe(1);
  });

  it('fresh install keeps the shebang on line 1 so Windows git can spawn the hook', () => {
    const managed = mergeGitPrePush(null);
    expect(managed.startsWith('#!/bin/sh\n')).toBe(true);
    expect(managed.split('\n')[1]).toBe('# >>> specgit:start >>>');
    // Re-merge stays in the spawnable layout, byte for byte.
    expect(mergeGitPrePush(managed)).toBe(managed);
  });

  it('upgrades the marker-first layout (shebang buried on line 2) to the spawnable layout', () => {
    expect(mergeGitPrePush(OLD_LAYOUT_PRE_PUSH)).toBe(mergeGitPrePush(null));
  });

  // #88-3: a marker-first install that later gained user content below the
  // managed region must upgrade without destroying that trailing content.
  // The wholesale replacement used to delete everything after the end
  // marker (adversarially reproduced on main, W0′ 2026-08-20).
  it('upgrades the marker-first layout while preserving trailing user content (#88-3)', () => {
    const existing = `${OLD_LAYOUT_PRE_PUSH}\n# user-added trailing hook lines\necho "user trailer" >&2\n`;
    const merged = mergeGitPrePush(existing);

    expect(merged.startsWith('#!/bin/sh\n')).toBe(true);
    expect(merged).toContain('# user-added trailing hook lines');
    expect(merged).toContain('echo "user trailer" >&2');
    expect(merged.indexOf('# <<< specgit:end <<<')).toBeLessThan(
      merged.indexOf('# user-added trailing hook lines')
    );
    // The repair stays byte-stable on re-merge.
    expect(mergeGitPrePush(merged)).toBe(merged);
  });

  it('an appended region after a user hook keeps the byte-stable spawnable head', () => {
    const merged = mergeGitPrePush(USER_PRE_PUSH);
    expect(merged.startsWith('#!/bin/sh\n')).toBe(true);
    expect(mergeGitPrePush(merged)).toBe(merged);
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('writeHarnessAssets', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-harness-merge-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('merges instead of overwriting user hooks.json and user git pre-push', async () => {
    write(HOOKS_JSON_ABS(root), USER_HOOKS_JSON);
    const gitHooks = path.join(root, 'shared-hooks');
    write(path.join(gitHooks, 'pre-push'), USER_PRE_PUSH);

    const result = await writeHarnessAssets(root, {
      resolveHooksDir: async () => gitHooks,
    });

    // hooks.json: user content preserved, specgit entry added exactly once.
    const merged = JSON.parse(read(HOOKS_JSON_ABS(root))) as {
      SessionStart: unknown[];
      'custom-top-level': unknown;
      PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    };
    expect(merged.SessionStart).toHaveLength(1);
    expect(merged['custom-top-level']).toEqual({ kept: true });
    // Located by ownership (the guard command), not by matcher (#335).
    const guardEntries = merged.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command === '.opencode/hooks/specgit-merge-guard.sh')
    );
    expect(guardEntries).toHaveLength(1);
    expect(guardEntries[0]?.matcher).toBe('Bash|Edit|Write');
    expect(guardEntries[0]?.hooks).toHaveLength(1);

    // pre-push: user script still first, managed region appended, executable.
    const prePush = read(path.join(gitHooks, 'pre-push'));
    expect(prePush.endsWith(USER_PRE_PUSH.slice('#!/bin/sh\n'.length))).toBe(true);
    expect(prePush).toContain('# >>> specgit:start >>>');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(gitHooks, 'pre-push')).mode & 0o111).not.toBe(0);
    }
    expect(result.gitHook).toBe(path.relative(root, path.join(gitHooks, 'pre-push')).split(path.sep).join('/'));
    expect(result.warnings).toHaveLength(0);
  });

  it('re-running is byte-stable for merged hooks', async () => {
    write(HOOKS_JSON_ABS(root), USER_HOOKS_JSON);
    const gitHooks = path.join(root, 'shared-hooks');
    write(path.join(gitHooks, 'pre-push'), USER_PRE_PUSH);
    const options = { resolveHooksDir: async () => gitHooks };

    await writeHarnessAssets(root, options);
    const hooksJsonAfterFirst = read(HOOKS_JSON_ABS(root));
    const prePushAfterFirst = read(path.join(gitHooks, 'pre-push'));

    await writeHarnessAssets(root, options);
    expect(read(HOOKS_JSON_ABS(root))).toBe(hooksJsonAfterFirst);
    expect(read(path.join(gitHooks, 'pre-push'))).toBe(prePushAfterFirst);
    // The workflow and managed block stay canonical too.
    expect(read(WORKFLOW_ABS(root))).toContain(ACCEPTANCE_CHECK_NAME);
    expect(read(AGENTS_ABS(root))).toBe(`${managedPromptBlock()}\n`);
  });

  it('skips an unmergeable hooks.json with a warning, leaving the bytes untouched', async () => {
    const broken = '{ not json';
    write(HOOKS_JSON_ABS(root), broken);

    const result = await writeHarnessAssets(root, { resolveHooksDir: async () => null });

    expect(read(HOOKS_JSON_ABS(root))).toBe(broken);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.code).toBe('hooks_json_unmerged');
    // The guard script itself is still installed.
    expect(fs.existsSync(GUARD_SCRIPT_ABS(root))).toBe(true);
    expect(result.hooks).not.toContain(HOOKS_JSON_PATH);
  });

  it('installs the git hook into the legacy .git/hooks when no resolver is given', async () => {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const result = await writeHarnessAssets(root);
    expect(result.gitHook).toBe('.git/hooks/pre-push');
    expect(read(path.join(root, '.git', 'hooks', 'pre-push'))).toContain(
      '# >>> specgit:start >>>'
    );
  });

  it('skips the git hook when the resolver returns null', async () => {
    const result = await writeHarnessAssets(root, { resolveHooksDir: async () => null });
    expect(result.gitHook).toBeNull();
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  describe('failure atomicity', () => {
    it('rolls every harness write back when a mid-sequence write fails', async () => {
      // Pre-existing files that must be restored byte-for-byte.
      write(AGENTS_ABS(root), '# existing notes\n');
      write(path.join(root, 'CLAUDE.md'), '# existing claude\n');
      // `.opencode` as a regular file: mkdir('.opencode') fails after the
      // workflow/prompt writes already happened.
      fs.writeFileSync(path.join(root, '.opencode'), 'not a directory');

      await expect(
        writeHarnessAssets(root, { resolveHooksDir: async () => null })
      ).rejects.toThrow();

      expect(read(AGENTS_ABS(root))).toBe('# existing notes\n');
      expect(read(path.join(root, 'CLAUDE.md'))).toBe('# existing claude\n');
      expect(fs.existsSync(WORKFLOW_ABS(root))).toBe(false);
      expect(fs.existsSync(path.join(root, '.github'))).toBe(false);
      expect(fs.readFileSync(path.join(root, '.opencode'), 'utf-8')).toBe('not a directory');
    });

    it('restores pre-existing file modes on rollback', async () => {
      // AGENTS.md seeded read-only is no longer a failure injection — #314
      // makes the harness repair a write-protected managed target instead
      // of crashing on it. The mid-sequence failure is injected by
      // `.opencode` as a regular file (the hooks.json write cannot land)
      // after the workflow and the repaired AGENTS.md writes already did.
      const workflowDir = path.join(root, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(WORKFLOW_ABS(root), '# canonical v1\n');
      write(AGENTS_ABS(root), '# frozen\n');
      fs.chmodSync(AGENTS_ABS(root), 0o444);
      fs.writeFileSync(path.join(root, '.opencode'), 'not a directory');

      let modeAfter: number;
      try {
        await expect(
          writeHarnessAssets(root, { resolveHooksDir: async () => null })
        ).rejects.toThrow();
        // Capture before the finally clears the protection for cleanup.
        modeAfter = fs.statSync(AGENTS_ABS(root)).mode & 0o777;
      } finally {
        fs.chmodSync(AGENTS_ABS(root), 0o644);
      }

      expect(read(AGENTS_ABS(root))).toBe('# frozen\n');
      // The pre-run protection round-trips: 0o444 is enforceable on every
      // platform (the read-only attribute is all it means on Windows).
      expect(modeAfter).toBe(0o444);
      expect(read(WORKFLOW_ABS(root))).toBe('# canonical v1\n');
      expect(fs.existsSync(HOOKS_JSON_ABS(root))).toBe(false);
      expect(fs.readFileSync(path.join(root, '.opencode'), 'utf-8')).toBe('not a directory');
    });
  });
});

describe('managed prompt block markers', () => {
  it('the block still round-trips through injectManagedBlock unchanged', async () => {
    const { injectManagedBlock } = await import('../../src/cli/harness-content.js');
    const block = managedPromptBlock();
    expect(block.startsWith(BLOCK_START_MARKER)).toBe(true);
    expect(block.endsWith(BLOCK_END_MARKER)).toBe(true);
    const injected = injectManagedBlock(`# header\n\n${block}\ntail\n`, block);
    expect(injected).toBe(`# header\n\n${block}\ntail\n`);
  });
});
