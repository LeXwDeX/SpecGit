/**
 * #300: the single source of the "Wait for sibling checks" step. Both
 * workflow templates (self = harness-content.ts, external =
 * external-harness.ts) and — through the byte-exactness pin — this
 * repository's own live workflow render from this generator. Before it,
 * three diverged copies disagreed on transport (fetch+Bearer vs gh api),
 * transient-failure detection, and the #119 truth-run rule, and none of
 * them paginated past the first 100 check-runs.
 *
 * The generated script waits until every name in spec_git/policy.yaml
 * is present with a terminal conclusion (#119 truth-run semantics: the
 * latest same-name run, never response position), pages through the
 * check-runs listing to exhaustion (per_page=100 until a short page),
 * retries transient API failures with bounded exponential backoff, and
 * diagnoses an absent policy instead of crashing (#297).
 *
 * #315: terminality alone is not enough — acceptance evidence must be
 * FRESH. The script anchors at the latest ready_for_review transition
 * on the pull request's issue timeline (same transport seam, paged to
 * exhaustion, re-read every polling cycle) and keeps waiting while a
 * required check's truth run started BEFORE that anchor: the green may
 * belong to the pre-reviewable delivery. A run with no pull-request
 * context (push, workflow_dispatch) has no anchor and no freshness
 * bound — the legacy terminality rule decides alone. `gh pr checks`
 * human text is never parsed.
 */

export type WaitTransport = 'rest' | 'gh';

export const ACCEPTANCE_POLL_MINUTES = 25;
/** Allow preparation and the verdict to finish outside the sibling wait. */
export const ACCEPTANCE_JOB_MINUTES = ACCEPTANCE_POLL_MINUTES + 5;

/** The step YAML, from `- name: Wait for sibling checks` through `EOF`. */
export function waitStepYaml(
  transport: WaitTransport,
  cliDirectory = '${{ runner.temp }}/specgit-cli'
): string {
  const ghComment =
    transport === 'gh' ? '\n        # All GitHub access goes through the authenticated gh CLI.' : '';
  const isolatedCliEnv = transport === 'gh'
    ? `          SPECGIT_CLI_DIR: ${cliDirectory}\n`
    : '';
  const header = `      - name: Wait for sibling checks
        # The verdict must see the OTHER required checks in a terminal
        # state. Sibling jobs start in parallel AND may not have registered
        # their check-runs yet, so an empty poll is not "done": wait until
        # every name in spec_git/policy.yaml is present with a terminal
        # conclusion. This job is not in the policy, so no self-deadlock.
        # #315: a terminal run only counts when it started at/after the
        # delivery's ready-for-review transition — a stale green keeps
        # waiting for the fresh run the transition triggers.${ghComment}
        env:
          GH_TOKEN: \${{ github.token }}
          WAIT_REPO: \${{ github.repository }}
          WAIT_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
          WAIT_PR: \${{ github.event.pull_request.number || '' }}
          WAIT_POLICY: \${{ runner.temp }}/specgit-policy.yaml
${isolatedCliEnv}        run: |
`;
  return `${header}${waitStepScript(transport)}\n`;
}

/** The inline node script body (heredoc lines, 10-space indent). */
export function waitStepScript(transport: WaitTransport): string {
  const lines: string[] = [
    `          node --input-type=module <<'EOF'`,
    ...(transport === 'gh'
      ? [
          `          import { existsSync, readFileSync } from 'node:fs';`,
          `          import { execFileSync } from 'node:child_process';`,
          `          import { createRequire } from 'node:module';`,
        ]
      : [`          import { existsSync, readFileSync } from 'node:fs';`]),
    ...(transport === 'gh'
      ? [
          `          const { parse } = process.env.SPECGIT_CLI_DIR`,
          `            ? createRequire(process.env.SPECGIT_CLI_DIR + '/node_modules/specgit/package.json')('yaml')`,
          `            : await import('yaml');`,
        ]
      : [`          import { parse } from 'yaml';`]),
    `          const policyPath = process.env.WAIT_POLICY || 'spec_git/policy.yaml';`,
    `          if (!existsSync(policyPath)) {`,
    `            console.error('spec_git/policy.yaml is absent at this head — an adoption PR carries no binding commit yet (expected once; merge it before enabling branch protection), and a delivery PR must carry it via specgit issue.');`,
    `            process.exit(1);`,
    `          }`,
    `          const policy = parse(readFileSync(policyPath, 'utf8'));`,
    `          const required = policy.required_checks ?? [];`,
    ...transportBlock(transport),
    ...workflowOwnershipBlock(transport),
    `          const terminal = new Set(['completed']);`,
    `          const PER_PAGE = 100;`,
    `          // #300: page the listing to exhaustion — a head with more than
`,
    `          // PER_PAGE check-runs must still expose every required name.
`,
    `          const fetchAllCheckRuns = async () => {`,
    `            const runs = [];`,
    `            for (let page = 1; ; page += 1) {`,
    `              const payload = await listChecksWithRetry(page);`,
    `              runs.push(...(payload.check_runs ?? []));`,
    `              if (!payload.check_runs || payload.check_runs.length < PER_PAGE) break;`,
    `            }`,
    `            return runs;`,
    `          };`,
    `          // #315: the evidence anchor — created_at of the latest
`,
    `          // ready_for_review event on the pull request's issue timeline,
`,
    `          // paged to exhaustion through the same transport seam. Empty
`,
    `          // WAIT_PR (a push or workflow_dispatch event) means no anchor
`,
    `          // and no freshness bound; a fetch failure fails the step
`,
    `          // loudly instead of silently unbounding freshness.
`,
    `          const fetchAnchor = async () => {`,
    `            if (!process.env.WAIT_PR) return null;`,
    `            let anchor = null;`,
    `            let anchorTime = null;`,
    `            for (let page = 1; ; page += 1) {`,
    `              const events = await fetchTimelineWithRetry(page);`,
    `              if (!Array.isArray(events)) throw new Error('GitHub returned a non-array timeline payload.');`,
    `              for (const event of events) {`,
    `                if (event && event.event === 'ready_for_review') {`,
    `                  if (typeof event.created_at !== 'string' || event.created_at === ''`,
    `                    || Number.isNaN(Date.parse(event.created_at))) {`,
    `                    throw new Error('GitHub returned a ready-for-review event without a valid timestamp.');`,
    `                  }`,
    `                  const eventTime = Date.parse(event.created_at);`,
    `                  if (anchor === null || anchorTime === null || eventTime > anchorTime) {`,
    `                    anchor = event.created_at;`,
    `                    anchorTime = eventTime;`,
    `                  }`,
    `                }`,
    `              }`,
    `              if (!Array.isArray(events) || events.length < PER_PAGE) return anchor;`,
    `            }`,
    `          };`,
    `          // Poll deadline sits BELOW the job's timeout-minutes (${ACCEPTANCE_JOB_MINUTES}) on
`,
    `          // purpose: when the deadline loses the race against a slow
`,
    `          // sibling, the script exits with its own diagnosis instead of
`,
    `          // being killed by the job timeout mid-line.
`,
    `          const deadline = Date.now() + ${ACCEPTANCE_POLL_MINUTES} * 60 * 1000;`,
    `          while (Date.now() < deadline) {`,
    `            // #315: re-read the anchor every cycle — the transition
`,
    `            // event landing after this job started, or the fresh runs
`,
    `            // registering late, self-heal on the next poll.
`,
    `            let anchor;`,
    `            try {`,
    `              anchor = await fetchAnchor();`,
    `            } catch (error) {`,
    `              console.error('Could not read the ready-for-review anchor: '`,
    `                + (error && error.message ? error.message : String(error)));`,
    `              process.exit(1);`,
    `            }`,
    `            const runs = await currentExecutionChecks(await fetchAllCheckRuns());`,
    `            // #119: re-runs keep every same-name run; terminality is`,
    `            // decided on the truth run — latest started_at, ties broken`,
    `            // by the higher check-run id (docs/reference.md) — never on`,
    `            // response position.`,
    `            const truth = new Map();`,
    `            const startedTime = (run) => {`,
    `              if (typeof run.started_at !== 'string') return Number.NEGATIVE_INFINITY;`,
    `              const parsed = Date.parse(run.started_at);`,
    `              return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;`,
    `            };`,
    `            for (const r of runs) {`,
    `              const cur = truth.get(r.name);`,
    `              const runTime = startedTime(r);`,
    `              const currentTime = cur === undefined ? Number.NEGATIVE_INFINITY : startedTime(cur);`,
    `              const later = cur === undefined`,
    `                || runTime > currentTime`,
    `                || (runTime === currentTime && (r.id || 0) > (cur.id || 0));`,
    `              if (later) truth.set(r.name, r);`,
    `            }`,
    `            const truthRunFor = (name) => {`,
    `              if (truth.has(name)) return truth.get(name);`,
    `              const retried = [...truth.keys()].find((k) => k.startsWith(name + ' ('));`,
    `              return retried === undefined ? undefined : truth.get(retried);`,
    `            };`,
    `            // #315: a required check settles only when its truth run is`,
    `            // terminal AND (when an anchor exists) started at/after the`,
    `            // ready-for-review transition — a stale green keeps waiting.`,
    `            const missing = [];`,
    `            const stale = [];`,
    `            const anchorTime = anchor === null ? null : Date.parse(anchor);`,
    `            for (const name of required) {`,
    `              const run = truthRunFor(name);`,
    `              if (run === undefined || !terminal.has(run.status)) {`,
    `                missing.push(name);`,
    `              } else if (anchorTime !== null && (Number.isNaN(anchorTime) || startedTime(run) < anchorTime)) {`,
    `                stale.push(name);`,
    `              }`,
    `            }`,
    `            if (missing.length === 0 && stale.length === 0) {`,
    `              console.log('All required checks are in a terminal state.');`,
    `              process.exit(0);`,
    `            }`,
    `            if (missing.length > 0) {`,
    `              console.log('Waiting for: ' + missing.join(', '));`,
    `            }`,
    `            if (stale.length > 0) {`,
    `              console.log('Waiting for a fresh run after ready for review: ' + stale.join(', '));`,
    `            }`,
    `            await new Promise((r) => setTimeout(r, 10000));`,
    `          }`,
    `          console.error('Timed out waiting for sibling checks.');`,
    `          process.exit(1);`,
    `          EOF`,
    ];
  return lines.join('\n');
}

/** Join Actions checks to their current workflow execution before truth-run selection. */
function workflowOwnershipBlock(transport: WaitTransport): string[] {
  const request = transport === 'gh'
    ? String.raw`return JSON.parse(execFileSync('gh', [
          'api', 'repos/' + process.env.WAIT_REPO + '/actions/runs', '--method', 'GET',
          '--field', 'head_sha=' + process.env.WAIT_SHA, '--field', 'per_page=' + PER_PAGE, '--field', 'page=' + page,
        ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }));`
    : String.raw`const response = await fetch('https://api.github.com/repos/' + process.env.WAIT_REPO
          + '/actions/runs?head_sha=' + process.env.WAIT_SHA + '&per_page=' + PER_PAGE + '&page=' + page, { headers });
        if (!response.ok) throw new Error('workflow-runs API HTTP ' + response.status);
        return await response.json();`;
  return String.raw`const isActions = (check) => check.app?.slug === 'github-actions' || check.app?.id === 15368;
const listWorkflowsWithRetry = async (page) => {
  for (let attempt = 1; ; attempt++) {
    try {
      ${request}
    } catch (error) {
      const text = String(error) + ' ' + String(error && error.stderr ? error.stderr : '');
      if (attempt >= 5 || !/HTTP 5\d\d|HTTP 429|ETIMEDOUT|ECONNRESET|ENOTFOUND|timed out/i.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 2000 * 2 ** (attempt - 1))));
    }
  }
};
const currentExecutionChecks = async (checks) => {
  if (!checks.some(isActions)) return checks;
  const bySuite = new Map();
  const ids = new Set();
  const latest = new Map();
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const key = (run) => JSON.stringify([run.workflow_id, run.event]);
  let total;
  for (let page = 1; page <= 10; page++) {
    const payload = await listWorkflowsWithRetry(page);
    if (!Array.isArray(payload?.workflow_runs) || payload.workflow_runs.length > PER_PAGE
      || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0) throw new Error('GitHub Actions workflow evidence is malformed.');
    if (payload.total_count > 1000) throw new Error('GitHub Actions workflow evidence exceeds the 1000-run API limit.');
    if (total !== undefined && total !== payload.total_count) throw new Error('GitHub Actions workflow evidence changed during pagination.');
    total = payload.total_count;
    for (const run of payload.workflow_runs) {
      if (!positive(run?.id) || !positive(run.check_suite_id) || !positive(run.workflow_id) || !positive(run.run_attempt)
        || run.head_sha !== process.env.WAIT_SHA || typeof run.event !== 'string' || run.event.length === 0
        || typeof run.run_started_at !== 'string' || !Number.isFinite(Date.parse(run.run_started_at))
        || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(run.status)
        || ids.has(run.id) || bySuite.has(run.check_suite_id)) throw new Error('GitHub Actions workflow ownership is missing, invalid, or ambiguous.');
      ids.add(run.id);
      bySuite.set(run.check_suite_id, run);
      const previous = latest.get(key(run));
      const time = Date.parse(run.run_started_at);
      if (!previous || time > Date.parse(previous.run_started_at)
        || (time === Date.parse(previous.run_started_at) && run.id > previous.id)) latest.set(key(run), run);
    }
    if (payload.workflow_runs.length < PER_PAGE) break;
    if (page === 10) throw new Error('GitHub Actions workflow evidence reached the pagination limit.');
  }
  if (ids.size !== total) throw new Error('GitHub Actions workflow evidence is incomplete.');
  return checks.flatMap((check) => {
    if (!isActions(check)) return [check];
    const suite = check.check_suite?.id;
    if (!positive(suite) || !bySuite.has(suite)) throw new Error('A GitHub Actions check has no verified workflow owner.');
    const owner = bySuite.get(suite);
    if (latest.get(key(owner)).id !== owner.id) return [];
    // A rerun can retain completed jobs from its prior attempt until new jobs register.
    return [owner.status === 'completed' ? check : { ...check, status: 'in_progress', conclusion: null }];
  });
};`.split('\n').map((line) => `          ${line}`);
}

/**
 * The transport seam: how one page of the check-runs listing is fetched
 * with bounded retry. REST (self template) reads the status codes; the
 * gh CLI (both current templates) surfaces HTTP failures as stderr text, so
 * transients are matched there.
 */
function transportBlock(transport: WaitTransport): string[] {
  if (transport === 'rest') {
    return [
      `          const headers = {`,
      `            authorization: 'Bearer ' + process.env.GH_TOKEN,`,
      `            accept: 'application/vnd.github+json',`,
      `          };`,
      `          // Transient API failures (5xx, 429, network) retry with bounded
`,
      `          // exponential backoff — a platform blip must not fail the gate.
`,
      `          const MAX_ATTEMPTS = 5;`,
      `          const listChecksWithRetry = async (page) => {`,
      `            const url = 'https://api.github.com/repos/' + process.env.WAIT_REPO
`,
      `              + '/commits/' + process.env.WAIT_SHA + '/check-runs?per_page=' + PER_PAGE + '&page=' + page;`,
      `            for (let attempt = 1; ; attempt += 1) {`,
      `              try {`,
      `                const res = await fetch(url, { headers });`,
      `                if (res.ok) return await res.json();`,
      `                if (res.status >= 500 || res.status === 429) {`,
      `                  if (attempt >= MAX_ATTEMPTS) throw new Error('check-runs API ' + res.status + ' after ' + attempt + ' attempts');`,
      `                } else {`,
      `                  throw new Error('check-runs API ' + res.status);`,
      `                }`,
      `              } catch (error) {`,
      `                if (attempt >= MAX_ATTEMPTS) throw error;`,
      `              }`,
      `              const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));`,
      `              console.log('Transient failure; retry ' + attempt + '/' + MAX_ATTEMPTS + ' in ' + backoff + 'ms');`,
      `              await new Promise((r) => setTimeout(r, backoff));`,
      `            }`,
      `          };`,
      `          // #315: the ready-for-review anchor rides the issue-timeline`,
      `          // endpoint with the same bounded-retry discipline.`,
      `          const fetchTimelineWithRetry = async (page) => {`,
      `            const url = 'https://api.github.com/repos/' + process.env.WAIT_REPO`,
      `              + '/issues/' + process.env.WAIT_PR + '/timeline?per_page=' + PER_PAGE + '&page=' + page;`,
      `            for (let attempt = 1; ; attempt += 1) {`,
      `              try {`,
      `                const res = await fetch(url, { headers });`,
      `                if (res.ok) {`,
      `                  const payload = await res.json();`,
      `                  if (!Array.isArray(payload)) throw new Error('GitHub returned a non-array timeline payload.');`,
      `                  return payload;`,
      `                }`,
      `                if (res.status >= 500 || res.status === 429) {`,
      `                  if (attempt >= MAX_ATTEMPTS) throw new Error('timeline API ' + res.status + ' after ' + attempt + ' attempts');`,
      `                } else {`,
      `                  throw new Error('timeline API ' + res.status);`,
      `                }`,
      `              } catch (error) {`,
      `                if (error && error.message === 'GitHub returned a non-array timeline payload.') throw error;`,
      `                if (attempt >= MAX_ATTEMPTS) throw error;`,
      `              }`,
      `              const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));`,
      `              console.log('Transient failure; retry ' + attempt + '/' + MAX_ATTEMPTS + ' in ' + backoff + 'ms');`,
      `              await new Promise((r) => setTimeout(r, backoff));`,
      `            }`,
      `          };`,
    ];
  }
  return [
    `          // gh.cmd needs a shell on Windows; POSIX execs the binary
`,
    `          // directly (shell stays off where it is not needed). The
`,
    `          // query rides --field args (never a raw "?" URL): cmd.exe
`,
    `          // treats a bare "&" as a command separator, so a URL query
`,
    `          // would be split mid-parameter on Windows.
`,
    `          const listChecks = (page) =>`,
    `            JSON.parse(`,
    `              execFileSync(`,
    `                'gh',`,
    `                [`,
    `                  'api',`,
    `                  'repos/' + process.env.WAIT_REPO + '/commits/' + process.env.WAIT_SHA + '/check-runs',`,
    `                  '--method', 'GET',`,
    `                  '--field', 'per_page=' + PER_PAGE,`,
    `                  '--field', 'page=' + page,`,
    `                ],`,
    `                { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }`,
    `              )`,
    `            );`,
    `          // Transient API failures (5xx, 429, network) retry with bounded
`,
    `          // exponential backoff — a platform blip must not fail the gate.
`,
    `          const MAX_ATTEMPTS = 5;`,
    `          const listChecksWithRetry = async (page) => {`,
    `            for (let attempt = 1; ; attempt += 1) {`,
    `              try {`,
    `                return listChecks(page);`,
    `              } catch (error) {`,
    `                const text = String(error) + ' ' + String(error && error.stderr ? error.stderr : '');`,
    `                const transient = /HTTP 5\\d\\d|HTTP 429|ETIMEDOUT|ECONNRESET|ENOTFOUND|timed out/i.test(text);`,
    `                if (attempt >= MAX_ATTEMPTS || !transient) throw error;`,
    `                const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));`,
    `                console.log('Transient failure; retry ' + attempt + '/' + MAX_ATTEMPTS + ' in ' + backoff + 'ms');`,
    `                await new Promise((r) => setTimeout(r, backoff));`,
    `              }`,
    `            }`,
    `          };`,
    `          // #315: the ready-for-review anchor rides the issue-timeline`,
    `          // endpoint through gh api --field args (GET, like the listing).`,
    `          const fetchTimelinePage = (page) =>`,
    `            JSON.parse(`,
    `              execFileSync(`,
    `                'gh',`,
    `                [`,
    `                  'api',`,
    `                  'repos/' + process.env.WAIT_REPO + '/issues/' + process.env.WAIT_PR + '/timeline',`,
    `                  '--method', 'GET',`,
    `                  '--field', 'per_page=' + PER_PAGE,`,
    `                  '--field', 'page=' + page,`,
    `                ],`,
    `                { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }`,
    `              )`,
    `            );`,
    `          const fetchTimelineWithRetry = async (page) => {`,
    `            for (let attempt = 1; ; attempt += 1) {`,
    `              try {`,
      `                const payload = fetchTimelinePage(page);`,
      `                if (!Array.isArray(payload)) throw new Error('GitHub returned a non-array timeline payload.');`,
      `                return payload;`,
      `              } catch (error) {`,
      `                if (error && error.message === 'GitHub returned a non-array timeline payload.') throw error;`,
    `                const text = String(error) + ' ' + String(error && error.stderr ? error.stderr : '');`,
    `                const transient = /HTTP 5\\d\\d|HTTP 429|ETIMEDOUT|ECONNRESET|ENOTFOUND|timed out/i.test(text);`,
    `                if (attempt >= MAX_ATTEMPTS || !transient) throw error;`,
    `                const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));`,
    `                console.log('Transient failure; retry ' + attempt + '/' + MAX_ATTEMPTS + ' in ' + backoff + 'ms');`,
    `                await new Promise((r) => setTimeout(r, backoff));`,
    `              }`,
    `            }`,
    `          };`,
  ];
}
