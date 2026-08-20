/**
 * Generated harness assets for `specgit init`.
 *
 * Artifacts, all deterministic so repeated harness writes are byte-stable:
 *
 * - `.github/workflows/specgit-accept.yml` — the CI acceptance gate that
 *   runs `specgit finish --json` on every pull request targeting the
 *   default branch.
 * - the managed prompt block — injected into AGENTS.md (created when
 *   missing) and CLAUDE.md (only when the file already exists), delimited
 *   by exact markers; a rewrite replaces only the region between them.
 * - the OpenCode guard hook (`.opencode/hooks.json` merged, never
 *   overwritten; `.opencode/hooks/specgit-merge-guard.sh` is specgit-owned)
 *   and the git `pre-push` guard (merged with any existing user hook via
 *   markers, installed into the directory `git rev-parse --git-path hooks`
 *   resolves — worktree and `core.hooksPath` aware).
 *
 * The whole write sequence is error-atomic (#62): every target is read and
 * transformed first; if any write fails, prior targets are restored to
 * their pre-write bytes and newly created files/directories are removed.
 * Crash-atomicity is out of scope; remote mutations happen later in init
 * and are never attempted when the local harness could not be written.
 *
 * Paths surfaced in output are repo-relative with forward slashes; file
 * contents use LF line endings only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const HARNESS_WORKFLOW_SEGMENTS = ['.github', 'workflows', 'specgit-accept.yml'];

export const HARNESS_WORKFLOW_PATH = HARNESS_WORKFLOW_SEGMENTS.join('/');
/** The CI check name the harness workflow contributes; also the check init guards behind branch protection. */
export const ACCEPTANCE_CHECK_NAME = 'SpecGit Acceptance';
export const AGENTS_FILENAME = 'AGENTS.md';
export const CLAUDE_FILENAME = 'CLAUDE.md';
export const BLOCK_START_MARKER = '<!-- specgit:block:start -->';
export const BLOCK_END_MARKER = '<!-- specgit:block:end -->';

export function harnessWorkflowYaml(): string {
  return `name: SpecGit Acceptance

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  specgit-acceptance:
    name: SpecGit Acceptance
    # Hosted pool on purpose: a required check must not hinge on one
    # self-hosted container. A shadow self-hosted job in ci.yml
    # proves the docker runner before any migration.
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout code
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # Check out the PR head branch by name so HEAD is on the branch
          # (not the detached merge ref): the execution context gate reads
          # live git. Falls back to the default ref on non-PR events.
          ref: \${{ github.head_ref || github.ref }}
          fetch-depth: 0
          persist-credentials: false

      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6

      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '20.19.0'
          # No dependency cache here, by design (#66): this job checks out
          # and executes untrusted PR code (install scripts, build, the CLI
          # under verdict), so it must never write to or restore from the
          # repository cache (CodeQL alerts 7-9). ci.yml keeps the warm,
          # branch-scoped cache.

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build CLI
        run: pnpm run build

      - name: Wait for sibling checks
        # The verdict must see the OTHER required checks in a terminal
        # state. Sibling jobs start in parallel AND may not have registered
        # their check-runs yet, so an empty poll is not "done": wait until
        # every name in spec_git/policy.yaml is present with a terminal
        # conclusion. This job is not in the policy, so no self-deadlock.
        env:
          GH_TOKEN: \${{ github.token }}
          WAIT_REPO: \${{ github.repository }}
          WAIT_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
        run: |
          node --input-type=module <<'EOF'
          import { readFileSync } from 'node:fs';
          import { parse } from 'yaml';
          const policy = parse(readFileSync('spec_git/policy.yaml', 'utf8'));
          const required = policy.required_checks ?? [];
          const headers = {
            authorization: 'Bearer ' + process.env.GH_TOKEN,
            accept: 'application/vnd.github+json',
          };
          const url = 'https://api.github.com/repos/' + process.env.WAIT_REPO
            + '/commits/' + process.env.WAIT_SHA + '/check-runs?per_page=100';
          const terminal = new Set(['completed']);
          const terminalHas = (byName, name) => {
            if (byName.has(name)) return terminal.has(byName.get(name));
            const retried = [...byName.keys()].find((k) => k.startsWith(name + ' ('));
            return retried !== undefined && terminal.has(byName.get(retried));
          };
          // Transient API failures (5xx, 429, network) retry with bounded
          // exponential backoff — a platform blip must not fail the gate.
          const MAX_ATTEMPTS = 5;
          const fetchJsonWithRetry = async () => {
            for (let attempt = 1; ; attempt += 1) {
              try {
                const res = await fetch(url, { headers });
                if (res.ok) return await res.json();
                if (res.status >= 500 || res.status === 429) {
                  if (attempt >= MAX_ATTEMPTS) throw new Error('check-runs API ' + res.status + ' after ' + attempt + ' attempts');
                } else {
                  throw new Error('check-runs API ' + res.status);
                }
              } catch (error) {
                if (attempt >= MAX_ATTEMPTS) throw error;
              }
              const retryAfterHeader = 0; // fetch hides headers on throw; fixed ladder below
              const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));
              const retryAfter = retryAfterHeader || backoff;
              console.log('Transient failure; retry ' + attempt + '/' + MAX_ATTEMPTS + ' in ' + retryAfter + 'ms');
              await new Promise((r) => setTimeout(r, retryAfter));
            }
          };
          const deadline = Date.now() + 15 * 60 * 1000;
          while (Date.now() < deadline) {
            const payload = await fetchJsonWithRetry();
            const byName = new Map(payload.check_runs.map((r) => [r.name, r.status]));
            const missing = required.filter((n) => !terminalHas(byName, n));
            if (missing.length === 0) {
              console.log('All required checks are in a terminal state.');
              process.exit(0);
            }
            console.log('Waiting for: ' + missing.join(', '));
            await new Promise((r) => setTimeout(r, 10000));
          }
          console.error('Timed out waiting for sibling checks.');
          process.exit(1);
          EOF

      - name: specgit finish
        run: node bin/specgit.js finish --json
        env:
          GH_TOKEN: \${{ github.token }}
`;
}

export function managedPromptBlock(): string {
  return `${BLOCK_START_MARKER}
## SpecGit delivery harness

Managed by \`specgit init\`. Everything between the markers is regenerated
whenever init writes the harness (a fresh init, or \`--force\` when a policy
already exists); keep manual guidance outside them.

### The delivery story

- Start with \`specgit issue <title-or-number>...\`: it creates or reuses
  the issues, branches, opens the draft pull request pre-filled with a
  deterministic scaffold (the \`Closes #n\` line for every bound issue,
  then Why / What changed / Evidence / Checklist sections), and writes
  \`.specgit.yaml\`. Re-running resumes; it is idempotent.
- Fill in the scaffold sections as you deliver. Its placeholders are
  advisory — the closing references are the only body gate. The PR body
  is written once at creation; no SpecGit command edits an existing PR
  body, and the repository's own pull-request template is never read.
- Finish with \`specgit finish\`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Repair and diagnostics

- \`specgit pr\` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- \`specgit status\` shows local evidence only: record, state, drift,
  origin. \`specgit doctor\` probes git, repository, origin, gh, and
  policy.

### The command surface

- Ten commands: \`specgit init\`, \`specgit setup\`, \`specgit issue\`,
  \`specgit pr\`, \`specgit finish\`, \`specgit bind\`, \`specgit unbind\`,
  \`specgit status\`, \`specgit accept\`, \`specgit doctor\`.
- \`specgit setup\` installs the agent entry points (commands for opencode,
  portable skills for other tools); \`specgit bind\`, \`specgit unbind\`,
  and \`specgit accept\` are automation aliases for scripts and CI.

### Before creating an issue, check for duplicates

- Before running \`specgit issue\` with a new title, search the tracker for
  similar open work: \`gh issue list\` with keywords from the title
  (state, labels, and search terms via \`gh search issues\`).
- Open and read every plausible candidate (\`gh issue view <n>\`) — compare
  the WHY, not just the wording.
- If a candidate covers the same WHY, continue that issue instead of
  creating a new one; if it is close but different, say how they differ.
- When unsure, ask the requester to decide between continuing the existing
  issue and creating a duplicate. The team ships one line of work per WHY,
  never two.

### Issue granularity

One issue = one independently verifiable WHY. If a deliverable cannot be
verified on its own evidence, split it before binding.

### Iron rules

- \`specgit finish\` exit code other than 0: never request merge. Fix the
  delivery, not the gate.
- Never weaken \`spec_git/policy.yaml\` to make a verdict pass.
- \`--json\` is the only parse surface: stdout is exactly one JSON
  document; never scrape human-readable output.
${BLOCK_END_MARKER}`;
}

/**
 * Pure transform: place `block` (which carries the markers) into existing
 * file content. When both markers are present, only the delimited region is
 * replaced; otherwise the block is appended after a blank line. Byte-stable
 * for repeated injection of the same block.
 */
export function injectManagedBlock(existing: string, block: string): string {
  const startIndex = existing.indexOf(BLOCK_START_MARKER);
  const endIndex = existing.indexOf(BLOCK_END_MARKER);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const afterEnd = endIndex + BLOCK_END_MARKER.length;
    return existing.slice(0, startIndex) + block + existing.slice(afterEnd);
  }
  if (existing.length === 0) {
    return `${block}\n`;
  }
  const separator = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${separator}\n${block}\n`;
}

export interface HarnessWriteResult {
  workflow: string;
  prompts: string[];
  hooks: string[];
  gitHook: string | null;
  /** Non-fatal merge refusals (e.g. an unmergeable hooks.json), surfaced by init as warnings. */
  warnings: Array<{ code: string; message: string }>;
}

const GUARD_COMMAND = '.opencode/hooks/specgit-merge-guard.sh';

const GUARD_HOOK_JSON = `{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "${GUARD_COMMAND}",
          "timeout": 600
        }
      ]
    }
  ]
}
`;

/** The specgit entry to merge into an existing hooks.json. */
const GUARD_HOOK_ENTRY = JSON.parse(GUARD_HOOK_JSON) as {
  PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
};

export const HOOKS_JSON_PATH = '.opencode/hooks.json';

export interface HooksJsonMergeResult {
  json: string;
  /** Present when the existing file could not be merged; `json` is then the unchanged input. */
  warning?: string;
}

/**
 * Merge the specgit guard into existing `.opencode/hooks.json` content
 * (#62: merge, never overwrite). User entries and unknown top-level keys
 * are preserved verbatim; the specgit `PreToolUse`/Bash entry is appended
 * exactly once. Byte-stable: merging the merge output again is a no-op.
 * Invalid or non-object JSON is returned untouched with a warning — the
 * user's broken file must not be destroyed by us.
 */
export function mergeHooksJson(existing: string | null): HooksJsonMergeResult {
  if (existing === null) {
    return { json: GUARD_HOOK_JSON };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      json: existing,
      warning: `existing ${HOOKS_JSON_PATH} is not valid JSON (${detail}); left untouched`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      json: existing,
      warning: `existing ${HOOKS_JSON_PATH} is not a JSON object; left untouched`,
    };
  }

  const config = structuredClone(parsed) as Record<string, unknown>;
  const specgitEntry = structuredClone(GUARD_HOOK_ENTRY.PreToolUse[0]);

  if (!Array.isArray(config.PreToolUse)) {
    config.PreToolUse = [];
  }
  const preToolUse = config.PreToolUse as unknown[];
  const bashEntry = preToolUse.find(
    (entry): entry is { matcher?: unknown; hooks?: unknown } =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { matcher?: unknown }).matcher === 'Bash' &&
      Array.isArray((entry as { hooks?: unknown }).hooks)
  );
  if (bashEntry && Array.isArray(bashEntry.hooks)) {
    const alreadyPresent = bashEntry.hooks.some(
      (hook) =>
        typeof hook === 'object' &&
        hook !== null &&
        (hook as { command?: unknown }).command === GUARD_COMMAND
    );
    if (!alreadyPresent) {
      bashEntry.hooks.push(specgitEntry.hooks[0]);
    }
  } else {
    preToolUse.push(specgitEntry);
  }

  return { json: `${JSON.stringify(config, null, 2)}\n` };
}

// Blocks merge/push-main attempts that bypass the evidence verdict. Matches
// only the command's leading verb pattern so prose containing the keywords
// (e.g. an issue body) never trips the guard. The merge branch is bounded
// (#68): the verdict runs under a budget derived from the configured gh
// timeout (SPECGIT_GH_TIMEOUT_MS) and never below it; budget expiry is
// reported as "no verdict", never as a rejection, and a blocked merge
// prints a concise summary naming pending (transient) and failed checks.
const GUARD_SCRIPT = `#!/bin/sh
# SpecGit merge guard (managed by specgit init). Exit 2 = block with reason.
GUARD_DIR=\$(cd "\$(dirname "\$0")" && pwd)
export GUARD_DIR
# Hook payloads arrive as the first argument or on stdin; accept both.
if [ -n "\$1" ]; then
  payload=\$1
else
  payload=\$(cat)
fi
command=\$(printf '%s' "\$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

case "\$command" in
  gh\\ pr\\ merge*)
    exec node -e '
      const { spawn } = require("child_process");
      const fs = require("fs");
      const path = require("path");
      const ghMsRaw = parseInt(process.env.SPECGIT_GH_TIMEOUT_MS || "", 10);
      const ghMs = Number.isFinite(ghMsRaw) && ghMsRaw > 0 ? ghMsRaw : 15000;
      const ghS = Math.max(1, Math.floor(ghMs / 1000));
      let budgetS = Math.max(60, ghS * 8);
      const overrideRaw = parseInt(process.env.SPECGIT_GUARD_BUDGET_S || "", 10);
      if (Number.isFinite(overrideRaw) && overrideRaw > 0) {
        budgetS = Math.max(overrideRaw, ghS);
      }
      // The hook runner kills long hooks; surface the mismatch instead of
      // being cut off mid-verdict.
      try {
        const hooks = JSON.parse(
          fs.readFileSync(path.join(process.env.GUARD_DIR || ".", "..", "hooks.json"), "utf8")
        );
        const runner = (hooks.PreToolUse || [])
          .flatMap((entry) => entry.hooks || [])
          .map((hook) => hook.timeout)
          .find((timeout) => typeof timeout === "number");
        if (runner !== undefined && runner - 10 < budgetS) {
          console.error(
            "specgit: guard budget " + budgetS + "s exceeds the hook runner timeout " +
              runner + "s in .opencode/hooks.json - raise the runner timeout or lower SPECGIT_GUARD_BUDGET_S."
          );
        }
      } catch {}
      const cp = require("child_process");
      const isWin = process.platform === "win32";
      // Windows: cmd.exe cannot exec an extensionless sh shim, so prefer
      // git-bash sh when present; only then fall back to shell mode.
      let child;
      if (isWin) {
        const probe = cp.spawnSync("sh", ["-c", "exit 0"]);
        if (probe.status === 0) {
          child = spawn("sh", ["-c", "specgit finish --json"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
        }
      }
      if (!child) {
        child = spawn("specgit", ["finish", "--json"], {
          shell: isWin,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      let out = "";
      let err = "";
      let expired = false;
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const timer = setTimeout(() => {
        expired = true;
        // Bound the wait strictly: descendants may inherit the pipes, so
        // destroy them and exit now — never lag behind orphaned children.
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGKILL");
        console.error(
          "specgit: merge blocked - guard budget " + budgetS + "s exhausted before a verdict. This says nothing about the delivery; run specgit finish directly for the full verdict."
        );
        process.exit(2);
      }, budgetS * 1000);
      child.on("error", (error) => {
        clearTimeout(timer);
        console.error(
          "specgit: merge blocked - the verdict could not run (" + error.message + "). Install specgit on PATH, then retry the merge."
        );
        process.exit(2);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (expired) {
          process.exit(2);
        }
        if (code === 0) {
          process.exit(0);
        }
        let envelope = null;
        try {
          envelope = JSON.parse(out);
        } catch {}
        const verdict = envelope && envelope.verdict;
        const gates = (envelope && (envelope.gates || (verdict && verdict.gates))) || [];
        const failures = [];
        for (const gate of gates) {
          for (const failure of (gate && gate.failures) || []) failures.push(failure);
        }
        const label = (failure, suffix) => {
          const detail = failure.detail || {};
          const name = detail.name || failure.code;
          const state = suffix || detail.status || detail.conclusion || "";
          return name + (state ? " [" + state + "]" : "");
        };
        const pending = failures.filter((f) => f.code === "checks_pending");
        const failed = failures.filter((f) => f.code === "checks_failed");
        const other = failures.filter(
          (f) => f.code !== "checks_pending" && f.code !== "checks_failed"
        );
        const lines = [];
        if (code === 1) {
          lines.push(
            "specgit: merge blocked - verdict rejected (exit 1). Fix what the failures name; never weaken spec_git/policy.yaml to pass."
          );
        } else {
          lines.push(
            "specgit: merge blocked - no verdict possible (evidence incomplete, exit " + code + "). This is not a rejection: fix evidence gathering (network, gh auth), then retry."
          );
        }
        if (pending.length > 0) {
          lines.push(
            "  pending (transient - wait, then re-run): " + pending.map((f) => label(f)).join(", ")
          );
        }
        if (failed.length > 0) {
          lines.push(
            "  failed (repair required): " +
              failed
                .map((f) =>
                  label(
                    f,
                    f.detail && f.detail.conclusion === "action_required"
                      ? "action_required - run awaits maintainer approval"
                      : undefined
                  )
                )
                .join(", ")
          );
        }
        if (other.length > 0) {
          lines.push("  other failures: " + other.map((f) => label(f)).join(", "));
        }
        lines.push("Full verdict: specgit finish");
        console.error(lines.join("\\n"));
        process.exit(2);
      });
    '
    ;;
  git\\ push\\ origin\\ main*|git\\ push\\ origin\\ +main*|git\\ push\\ origin\\ HEAD:main*)
    echo "specgit: direct push to main is not the delivery path. Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
    exit 2
    ;;
esac
exit 0
`;

export { GUARD_SCRIPT };

// Local git-layer guard: refuses direct pushes to main; deliveries must go
// through PR + CI + specgit finish. The managed file wraps this BODY in
// SPECGIT_PRE_PUSH_MARKERS so an existing user hook is merged, not
// replaced (#62) — and keeps the shebang on line 1, ahead of the start
// marker, because git on Windows execs the hook directly and cannot
// spawn a file whose first line is a plain comment (#67 matrix,
// windows-pwsh: "cannot spawn ... pre-push: Exec format error").
const GIT_PRE_PUSH_BODY = `# SpecGit pre-push guard (managed by specgit init).
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

// The pre-#62 unmarked install: shebang + body, no markers.
const GIT_PRE_PUSH = `#!/bin/sh
${GIT_PRE_PUSH_BODY}`;

const PRE_PUSH_START = '# >>> specgit:start >>>';
const PRE_PUSH_END = '# <<< specgit:end <<<';

/** The marker-delimited guard region (no shebang of its own). */
function managedPrePushRegion(): string {
  return `${PRE_PUSH_START}\n${GIT_PRE_PUSH_BODY}${PRE_PUSH_END}\n`;
}

/** A fresh managed file: shebang line 1, then the managed region. */
function managedPrePush(): string {
  return `#!/bin/sh\n${managedPrePushRegion()}`;
}

/**
 * Merge the specgit pre-push guard into existing hook content (#62:
 * merge, never overwrite). Cases, all byte-stable on re-merge:
 * - absent/empty: the spawnable managed file alone;
 * - the legacy unmarked specgit guard (pre-#62 installs): upgraded;
 * - the #62 marker-first layout (shebang on line 2, unspawnable on
 *   Windows): upgraded wholesale so the shebang becomes line 1;
 * - markers present: only the delimited region is replaced;
 * - anything else (a user hook, e.g. husky): preserved verbatim with
 *   the managed region appended after it.
 */
export function mergeGitPrePush(existing: string | null): string {
  if (existing === null || existing === '') {
    return managedPrePush();
  }
  if (existing === GIT_PRE_PUSH) {
    // Legacy specgit install without markers: upgrade in place.
    return managedPrePush();
  }
  const startIndex = existing.indexOf(PRE_PUSH_START);
  const endIndex = existing.indexOf(PRE_PUSH_END);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    if (startIndex === 0) {
      // Old managed layout: the marker was line 1 and the shebang sat
      // inside the region. Replace the whole file with the spawnable
      // layout (the region content is otherwise identical).
      return managedPrePush();
    }
    const afterEnd = endIndex + PRE_PUSH_END.length;
    return existing.slice(0, startIndex) + managedPrePushRegion().trimEnd() + existing.slice(afterEnd);
  }
  const separator = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${separator}${managedPrePushRegion()}`;
}

const HOOKS_SEGMENTS = ['.opencode', 'hooks'];
const GUARD_HOOK_PATH = [...HOOKS_SEGMENTS, 'specgit-merge-guard.sh'].join('/');
export const GUARD_SCRIPT_PATH = GUARD_HOOK_PATH;

/**
 * Legacy resolution used when no git-backed resolver is available: install
 * into `<root>/.git/hooks` only when `.git` is a real directory (a linked
 * worktree's `.git` is a file, so the git hook is skipped there).
 */
export async function legacyGitHooksDir(root: string): Promise<string | null> {
  const gitDir = path.join(root, '.git');
  const gitStat = await fs.stat(gitDir).catch(() => null);
  return gitStat?.isDirectory() ?? false ? path.join(gitDir, 'hooks') : null;
}

export interface HarnessWriteOptions {
  /**
   * Resolve the directory git actually runs hooks from (absolute), or
   * null to skip the git hook. Production wires this to
   * `git rev-parse --git-path hooks` via the git port so linked
   * worktrees and `core.hooksPath` (husky/lefthook) behave correctly.
   */
  resolveHooksDir?: (root: string) => Promise<string | null>;
  /**
   * Workflow bytes to write (#63 template selection). Defaults to the
   * self-hosted template (the SpecGit repository's own workflow);
   * `specgit init` passes the portable external template for adopting
   * repositories. Either way the write is planned and rolled back
   * atomically with the rest of the harness.
   */
  workflowYaml?: string;
}

async function readIfExists(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

interface Snapshot {
  target: string;
  existed: boolean;
  content: string | null;
  mode: number | null;
}

async function snapshot(target: string): Promise<Snapshot> {
  const [content, stat] = await Promise.all([
    readIfExists(target),
    fs.stat(target).catch(() => null),
  ]);
  return { target, existed: content !== null, content, mode: stat?.mode ?? null };
}

interface PlannedWrite {
  target: string;
  content: string;
  mode: number;
}

/**
 * Write the full harness (#62 non-destructive contract):
 *
 * 1. Plan — read every target and compute its final bytes up front
 *    (merging user hooks, injecting the managed block).
 * 2. Commit — create directories and write files in order.
 * 3. Rollback — if any commit step fails, restore every prior target to
 *    its snapshot (bytes and mode) and remove files/directories this run
 *    created, then rethrow so init reports exit 3 with a clean tree.
 */
export async function writeHarnessAssets(
  root: string,
  options: HarnessWriteOptions = {}
): Promise<HarnessWriteResult> {
  const warnings: Array<{ code: string; message: string }> = [];

  // ---- Plan phase (reads + pure transforms; no writes yet) ----
  const block = managedPromptBlock();
  const planned: PlannedWrite[] = [];
  const prompts: string[] = [];

  planned.push({
    target: path.join(root, ...HARNESS_WORKFLOW_SEGMENTS),
    content: options.workflowYaml ?? harnessWorkflowYaml(),
    mode: 0o644,
  });

  for (const filename of [AGENTS_FILENAME, CLAUDE_FILENAME]) {
    const target = path.join(root, filename);
    const existing = await readIfExists(target);
    if (existing === null && filename === CLAUDE_FILENAME) {
      continue;
    }
    planned.push({ target, content: injectManagedBlock(existing ?? '', block), mode: 0o644 });
    prompts.push(filename);
  }

  const hooksJsonTarget = path.join(root, ...HOOKS_JSON_PATH.split('/'));
  const hooksJsonExisting = await readIfExists(hooksJsonTarget);
  const hooksJsonMerge = mergeHooksJson(hooksJsonExisting);
  let hooksJsonWritten = true;
  if (hooksJsonMerge.warning !== undefined) {
    warnings.push({ code: 'hooks_json_unmerged', message: hooksJsonMerge.warning });
    hooksJsonWritten = false;
  } else {
    planned.push({ target: hooksJsonTarget, content: hooksJsonMerge.json, mode: 0o644 });
  }

  const guardTarget = path.join(root, ...HOOKS_SEGMENTS, 'specgit-merge-guard.sh');
  planned.push({ target: guardTarget, content: GUARD_SCRIPT, mode: 0o755 });

  const hooksDir = options.resolveHooksDir
    ? await options.resolveHooksDir(root)
    : await legacyGitHooksDir(root);
  let gitHook: string | null = null;
  let gitHookTarget: string | null = null;
  if (hooksDir !== null) {
    gitHookTarget = path.join(hooksDir, 'pre-push');
    const existing = await readIfExists(gitHookTarget);
    planned.push({ target: gitHookTarget, content: mergeGitPrePush(existing), mode: 0o755 });
    gitHook = path.relative(root, gitHookTarget).split(path.sep).join('/');
  }

  // ---- Commit phase (writes; rollback restores on failure) ----
  const snapshots: Snapshot[] = [];
  const createdDirs: string[] = [];
  try {
    for (const step of planned) {
      snapshots.push(await snapshot(step.target));
      await ensureDirTracked(path.dirname(step.target), createdDirs);
      await fs.writeFile(step.target, step.content, 'utf-8');
      await fs.chmod(step.target, step.mode);
    }
  } catch (error) {
    const rollbackNote = await rollback(snapshots, createdDirs);
    if (rollbackNote !== null) {
      throw new Error(`${(error as Error).message} (rollback incomplete: ${rollbackNote})`);
    }
    throw error;
  }

  const hooks = [...(hooksJsonWritten ? [HOOKS_JSON_PATH] : []), GUARD_HOOK_PATH];
  return { workflow: HARNESS_WORKFLOW_PATH, prompts, hooks, gitHook, warnings };
}

/** mkdir -p that records the directory chain it had to create. */
async function ensureDirTracked(dir: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cursor = dir;
  while (!(await fs.stat(cursor).then(() => true).catch(() => false))) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (missing.length > 0) {
    await fs.mkdir(dir, { recursive: true });
    created.push(...missing);
  }
}

/**
 * Best-effort restore to the pre-write state: rewritten files get their
 * original bytes and mode back, files this run created are removed, and
 * directories this run created are removed deepest-first (rmdir refuses
 * non-empty dirs, so user content can never be deleted here).
 */
async function rollback(snapshots: Snapshot[], createdDirs: string[]): Promise<string | null> {
  let failure: string | null = null;
  for (const snap of [...snapshots].reverse()) {
    try {
      if (snap.existed && snap.content !== null) {
        await fs.writeFile(snap.target, snap.content, 'utf-8');
        if (snap.mode !== null) await fs.chmod(snap.target, snap.mode);
      } else {
        await fs.unlink(snap.target).catch(() => undefined);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(dir);
    } catch {
      // Non-empty (or already gone) — nothing more we can safely do.
    }
  }
  return failure;
}
