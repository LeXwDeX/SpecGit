import { expect, vi } from 'vitest';
import type { Evidence } from '../../src/kernel/evidence.js';
import type { Verdict, VerdictEvidence } from '../../src/acceptance/evaluate.js';
import type { DeliveryBinding } from '../../src/record/schema.js';
import type { Policy as SpecGitPolicy } from '../../src/record/policy.js';
import type {
  BranchProtectionFact,
  CheckRunInfo,
  IssueCommentCreation,
  IssueCreation,
  IssueFact,
  OpenIssueFact,
  PrCreation,
  PrFact,
  PrSummary,
  RepoAutomergeFact,
} from '../../src/github/port.js';
import type { BranchCheckout } from '../../src/gitfacts/port.js';
import type {
  CommandContext,
  ForgeProvider,
  GitFacts,
  GitPort,
  RecordPort,
  RepoRef,
} from '../../src/cli/types.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';

export interface CapturedIO {
  stdout: string[];
  stderr: string[];
}

export function makeIO(): CapturedIO & { writeOut: CommandContext['io'] } {
  const captured: CapturedIO = { stdout: [], stderr: [] };
  return {
    ...captured,
    writeOut: {
      stdout: (line: string) => captured.stdout.push(line),
      stderr: (line: string) => captured.stderr.push(line),
    },
  };
}

export function stdoutText(io: CapturedIO): string {
  return io.stdout.join('\n');
}

export function parseStdoutJson(io: CapturedIO): Record<string, any> {
  expectSingleJsonDocument(io.stdout);
  return JSON.parse(io.stdout.join(''));
}

export function expectSingleJsonDocument(lines: string[]): void {
  const joined = lines.join('');
  expect(joined.trim().length).toBeGreaterThan(0);
  expect(() => JSON.parse(joined)).not.toThrow();
}

export function makeGitFacts(overrides: Partial<GitFacts> = {}): GitFacts {
  return {
    repo: true,
    toplevel: '/repo',
    branch: 'feat/123-login',
    headSha: 'abc123',
    dirty: false,
    isLinkedWorktree: false,
    worktreeLabel: null,
    worktrees: [],
    originUrl: 'https://github.com/LeXwDeX/SpecGit.git',
    upstreamDrift: null,
    gitAvailable: true,
    ...overrides,
  };
}

export interface MemoryRecordState {
  record?: DeliveryBinding | 'invalid';
  policy?: SpecGitPolicy | 'invalid';
}

export interface MemoryRecordPort extends RecordPort {
  recordWrites: Array<{ root: string; record: DeliveryBinding }>;
  policyWrites: Array<{ root: string; policy: SpecGitPolicy }>;
  deletes: string[];
}

export function makeRecordPort(state: MemoryRecordState = {}): MemoryRecordPort {
  const port: MemoryRecordPort = {
    recordWrites: [],
    policyWrites: [],
    deletes: [],
    readRecord: vi.fn(async (): Promise<Evidence<DeliveryBinding>> => {
      if (state.record === undefined) {
        return {
          ok: false,
          code: 'record_missing',
          message: 'No delivery binding found at .specgit.yaml.',
        };
      }
      if (state.record === 'invalid') {
        return { ok: false, code: 'record_invalid', message: '.specgit.yaml failed schema validation.' };
      }
      return { ok: true, value: state.record };
    }),
    writeRecord: vi.fn(async (root: string, record: DeliveryBinding): Promise<void> => {
      port.recordWrites.push({ root, record });
      state.record = record;
    }),
    deleteRecord: vi.fn(async (root: string): Promise<void> => {
      port.deletes.push(root);
      state.record = undefined;
    }),
    readPolicy: vi.fn(async (): Promise<Evidence<SpecGitPolicy>> => {
      if (state.policy === undefined) {
        return { ok: false, code: 'policy_missing', message: 'No policy found at spec_git/policy.yaml.' };
      }
      if (state.policy === 'invalid') {
        return { ok: false, code: 'policy_invalid', message: 'spec_git/policy.yaml failed schema validation.' };
      }
      return { ok: true, value: state.policy };
    }),
    writePolicy: vi.fn(async (root: string, policy: SpecGitPolicy): Promise<void> => {
      port.policyWrites.push({ root, policy });
      state.policy = policy;
    }),
  };
  return port;
}

export interface RecordingForgeProvider extends ForgeProvider {
  calls: string[];
}

export interface GhScript {
  getPr?: (repo: RepoRef, ref: number | string) => Evidence<PrFact>;
  getOpenIssueNumbers?: (repo: RepoRef) => Evidence<number[]>;
  getOpenIssues?: (repo: RepoRef) => Evidence<OpenIssueFact[]>;
  createIssue?: (repo: RepoRef, title: string, body: string) => Evidence<IssueCreation>;
  createDraftPr?: (
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string
  ) => Evidence<PrCreation>;
  listOpenPrsByHead?: (repo: RepoRef, head: string) => Evidence<PrSummary[]>;
  addIssueComment?: (repo: RepoRef, issue: number, body: string) => Evidence<IssueCommentCreation>;
  branchProtection?: Evidence<BranchProtectionFact>;
  enableBranchProtection?: Evidence<BranchProtectionFact>;
  repoAutomerge?: Evidence<RepoAutomergeFact>;
  enableRepoAutomerge?: Evidence<RepoAutomergeFact>;
}

export function makeGhProvider(
  behavior: {
    preflight?: Evidence<{ authenticated: boolean }>;
  } & GhScript = {}
): RecordingForgeProvider {
  const calls: string[] = [];
  const preflight = behavior.preflight ?? { ok: true, value: { authenticated: true } };
  // Every method carries the port's real signature (parameters and return
  // type alike), so drift between this double and `ForgeProvider` fails
  // typecheck instead of hiding behind casts (#178).
  return {
    calls,
    preflight: vi.fn(async () => {
      calls.push('preflight');
      return preflight;
    }),
    getIssue: vi.fn(async (_repo: RepoRef, _n: number): Promise<Evidence<IssueFact>> => {
      calls.push('getIssue');
      return { ok: false, code: 'gh_transport', message: 'not configured in fake' };
    }),
    getOpenIssueNumbers: vi.fn(async (repo: RepoRef): Promise<Evidence<number[]>> => {
      calls.push(`getOpenIssueNumbers:${repo.owner}/${repo.repo}`);
      return (
        behavior.getOpenIssueNumbers?.(repo) ??
        // Empty remote by default: no open issues to adopt.
        { ok: true, value: [] }
      );
    }),
    getOpenIssues: vi.fn(async (repo: RepoRef): Promise<Evidence<OpenIssueFact[]>> => {
      calls.push(`getOpenIssues:${repo.owner}/${repo.repo}`);
      return (
        behavior.getOpenIssues?.(repo) ??
        // Empty remote by default: no open issues to adopt.
        { ok: true, value: [] }
      );
    }),
    getPr: vi.fn(async (repo: RepoRef, ref: number | string): Promise<Evidence<PrFact>> => {
      calls.push(`getPr:${String(ref)}`);
      return (
        behavior.getPr?.(repo, ref) ??
        { ok: false, code: 'gh_transport', message: 'not configured in fake' }
      );
    }),
    getCheckRuns: vi.fn(async (_repo: RepoRef, _sha: string): Promise<Evidence<CheckRunInfo[]>> => {
      calls.push('getCheckRuns');
      return { ok: false, code: 'gh_transport', message: 'not configured in fake' };
    }),
    createIssue: vi.fn(async (repo: RepoRef, title: string, body: string): Promise<Evidence<IssueCreation>> => {
      calls.push(`createIssue:${title}`);
      return (
        behavior.createIssue?.(repo, title, body) ??
        { ok: false, code: 'gh_transport', message: 'not configured in fake' }
      );
    }),
    createDraftPr: vi.fn(
      async (repo: RepoRef, head: string, base: string, title: string, body: string): Promise<Evidence<PrCreation>> => {
        calls.push(`createDraftPr:${head}`);
        return (
          behavior.createDraftPr?.(repo, head, base, title, body) ??
          { ok: false, code: 'gh_transport', message: 'not configured in fake' }
        );
      }
    ),
    listOpenPrsByHead: vi.fn(async (repo: RepoRef, head: string): Promise<Evidence<PrSummary[]>> => {
      calls.push(`listOpenPrsByHead:${head}`);
      return (
        behavior.listOpenPrsByHead?.(repo, head) ??
        { ok: false, code: 'gh_transport', message: 'not configured in fake' }
      );
    }),
    addIssueComment: vi.fn(async (repo: RepoRef, issue: number, body: string): Promise<Evidence<IssueCommentCreation>> => {
      calls.push(`addIssueComment:${issue}`);
      return (
        behavior.addIssueComment?.(repo, issue, body) ??
        { ok: true, value: { url: `https://github.com/fake/issues/${issue}#comment` } }
      );
    }),
    getBranchProtection: vi.fn(async (repo: RepoRef, branch: string): Promise<Evidence<BranchProtectionFact>> => {
      calls.push(`getBranchProtection:${repo.owner}/${repo.repo}:${branch}`);
      return (
        behavior.branchProtection ??
        { ok: true, value: { protected: false, requiredChecks: [] } }
      );
    }),
    enableBranchProtection: vi.fn(async (repo: RepoRef, branch: string, requiredCheck: string): Promise<Evidence<BranchProtectionFact>> => {
      calls.push(`enableBranchProtection:${repo.owner}/${repo.repo}:${branch}:${requiredCheck}`);
      return (
        behavior.enableBranchProtection ??
        { ok: true, value: { protected: true, requiredChecks: [requiredCheck] } }
      );
    }),
    getRepoAutomerge: vi.fn(async (repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> => {
      calls.push(`getRepoAutomerge:${repo.owner}/${repo.repo}`);
      return (
        behavior.repoAutomerge ??
        { ok: true, value: { enabled: false } }
      );
    }),
    enableRepoAutomerge: vi.fn(async (repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> => {
      calls.push(`enableRepoAutomerge:${repo.owner}/${repo.repo}`);
      return (
        behavior.enableRepoAutomerge ??
        { ok: true, value: { enabled: true } }
      );
    }),
  };
}

export interface GitWriteScript {
  checkoutOrCreateBranch?: (branch: string) => Evidence<BranchCheckout>;
  commitFile?: (
    relativePaths: string[],
    message: string
  ) => Evidence<{ committed: boolean }>;
  pushBranch?: (branch: string) => Evidence<{ pushed: boolean }>;
  remoteDefaultBranch?: () => Evidence<string>;
  hooksPath?: () => Evidence<string>;
}

export interface RecordingGitPort extends GitPort {
  factsCalls: string[];
  checkoutCalls: string[];
  commitCalls: Array<{ paths: string[]; message: string }>;
  pushCalls: string[];
  defaultBranchCalls: string[];
}

export function makeGitPort(facts: GitFacts, writes: GitWriteScript = {}): RecordingGitPort {
  const port: RecordingGitPort = {
    factsCalls: [],
    checkoutCalls: [],
    commitCalls: [],
    pushCalls: [],
    defaultBranchCalls: [],
    facts: vi.fn(async (root: string) => {
      port.factsCalls.push(root);
      return facts;
    }),
    checkoutOrCreateBranch: vi.fn(async (_root: string, branch: string): Promise<Evidence<BranchCheckout>> => {
      port.checkoutCalls.push(branch);
      return writes.checkoutOrCreateBranch?.(branch) ?? { ok: true, value: { branch, created: true } };
    }),
    commitFile: vi.fn(async (_root: string, relativePaths: string[], message: string): Promise<Evidence<{ committed: boolean }>> => {
      port.commitCalls.push({ paths: relativePaths, message });
      return writes.commitFile?.(relativePaths, message) ?? { ok: true, value: { committed: true } };
    }),
    pushBranch: vi.fn(async (_root: string, branch: string): Promise<Evidence<{ pushed: boolean }>> => {
      port.pushCalls.push(branch);
      return writes.pushBranch?.(branch) ?? { ok: true, value: { pushed: true } };
    }),
    remoteDefaultBranch: vi.fn(async (_root: string): Promise<Evidence<string>> => {
      port.defaultBranchCalls.push(_root);
      return writes.remoteDefaultBranch?.() ?? { ok: true, value: 'main' };
    }),
    headContains: vi.fn(async (): Promise<Evidence<{ contained: boolean }>> =>
      // Fail-closed default: the fake answers no lineage question unless
      // a test explicitly scripts one.
      ({ ok: false, code: 'merged_lineage_unavailable', message: 'headContains not configured in fake' })
    ),
    hooksPath: vi.fn(async (_root: string): Promise<Evidence<string>> => {
      return (
        writes.hooksPath?.() ??
        { ok: false, code: 'git_unavailable', message: 'hooks path not configured in fake' }
      );
    }),
  };
  return port;
}

export function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  const evidence: VerdictEvidence = {
    root: '/repo',
    repo: 'LeXwDeX/SpecGit',
    delivery: 'add-login-flow',
    branch: 'feat/123-login',
    headSha: 'abc123',
    dirty: false,
    upstreamDrift: null,
    context: { kind: 'branch' },
    issues: [123],
    pr: 42,
    prHead: 'abc123',
  };
  return {
    accepted: true,
    state: 'accepted',
    classification: 'accepted',
    exitCode: 0,
    complete: true,
    gates: [],
    evidence,
    warnings: [],
    ...overrides,
  };
}

export interface EvaluateCall {
  root: Evidence<string>;
  record: Evidence<DeliveryBinding>;
  policy: Evidence<SpecGitPolicy>;
  git: GitPort;
  gh?: ForgeProvider;
}

export function makeEvaluate(verdict?: Verdict): ((input: EvaluateCall) => Promise<Verdict>) & {
  calls: EvaluateCall[];
} {
  const calls: EvaluateCall[] = [];
  const fn = (async (input: EvaluateCall) => {
    calls.push(input);
    if (!verdict) {
      throw new Error('evaluate called but no verdict configured');
    }
    return verdict;
  }) as ((input: EvaluateCall) => Promise<Verdict>) & { calls: EvaluateCall[] };
  fn.calls = calls;
  return fn;
}

export interface CtxOptions {
  record?: DeliveryBinding | 'invalid';
  policy?: SpecGitPolicy | 'invalid' | 'none';
  facts?: GitFacts;
  evaluate?: (input: EvaluateCall) => Promise<Verdict>;
  root?: Evidence<string>;
  cwd?: string;
  stdinIsTTY?: boolean;
  gh?: ForgeProvider;
  gitWrites?: GitWriteScript;
  /** Overrides the production parseRepoRef (e.g. with a GitLab declaration). */
  parseRepoRef?: CommandContext['parseRepoRef'];
}

export interface TestCtx {
  ctx: CommandContext;
  io: CapturedIO & { writeOut: CommandContext['io'] };
  recordPort: MemoryRecordPort;
  gitPort: ReturnType<typeof makeGitPort>;
  ghProvider: RecordingForgeProvider;
}

export function makeCtx(options: CtxOptions = {}): TestCtx {
  const io = makeIO();
  const recordPort = makeRecordPort({
    ...(options.record !== undefined ? { record: options.record } : {}),
    ...(options.policy === undefined || options.policy === 'none'
      ? {}
      : { policy: options.policy }),
  });
  const gitPort = makeGitPort(options.facts ?? makeGitFacts(), options.gitWrites);
  const ghProvider = makeGhProvider();

  const ctx: CommandContext = {
    io: io.writeOut,
    version: '0.0.0-test',
    cwd: options.cwd ?? '/repo',
    stdinIsTTY: options.stdinIsTTY ?? false,
    discoverRoot: vi.fn(async (): Promise<Evidence<string>> => options.root ?? { ok: true, value: '/repo' }),
    probeGitBinary: vi.fn(async (): Promise<Evidence<string>> => ({ ok: true, value: 'git version 2.39.0' })),
    git: gitPort,
    gh: options.gh ?? ghProvider,
    record: recordPort,
    evaluate: (options.evaluate ?? makeEvaluate()) as CommandContext['evaluate'],
    parseRepoRef: options.parseRepoRef ?? parseRepoRef,
  };

  return { ctx, io, recordPort, gitPort, ghProvider };
}

export function sampleBinding(overrides: Partial<DeliveryBinding> = {}): DeliveryBinding {
  return {
    version: 1,
    delivery: 'add-login-flow',
    context: { kind: 'branch', branch: 'feat/123-login' },
    issues: [123],
    pr: 42,
    ...overrides,
  };
}

export function samplePolicy(overrides: Partial<SpecGitPolicy> = {}): SpecGitPolicy {
  return {
    version: 1,
    required_checks: ['All checks passed'],
    ...overrides,
  };
}
