import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { ForgeProvider } from '../github/port.js';
import type { CheckRunInfo, OpenIssueFact } from '../github/port.js';
import type { Policy } from '../record/policy.js';
import type { RepoRef } from '../gitfacts/origin.js';

export const REPAIR_LOG_PREFIX = '<!-- specgit:repair:v1 -->';
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IntentSchema = z.object({
  request: positive,
  headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  cause: z.object({ code: z.string().min(1).max(128), target: z.string().min(1).max(512).optional() }).strict(),
  title: z.string().min(1).max(512),
  body: z.string().min(1).max(9_000),
  labels: z.array(z.string().min(1).max(100)).max(30),
}).strict();
const KeySchema = z.string().regex(/^[a-f0-9]{32}$/u);
const EventSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), project: z.string(), kind: z.literal('intent'), key: KeySchema, intent: IntentSchema }).strict(),
  z.object({ version: z.literal(1), project: z.string(), kind: z.literal('created'), request: positive, key: KeySchema, issue: positive }).strict(),
]);
type RepairEvent = z.infer<typeof EventSchema>;
export type RepairIntent = z.infer<typeof IntentSchema>;
export interface RepairOperation extends RepairIntent { key: string; issue?: number }
type LogPort = Pick<ForgeProvider, 'getRequestDeclarations' | 'appendRequestDeclaration'>;

export function repairPolicyHash(policy: Policy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

export function repairLogHash(operations: readonly RepairOperation[]): string {
  return createHash('sha256').update(JSON.stringify([...operations].sort((a, b) => a.key.localeCompare(b.key)))).digest('hex');
}

export function repairCheckTarget(platform: RepoRef['platform'], check: CheckRunInfo): string {
  const name = check.name.replace(/^downstream:(\d+)\/\d+:/, 'downstream:$1:');
  return `${platform}:${check.source ?? 'pipeline'}:${name}`;
}

function projectIdentity(repo: RepoRef): string {
  const path = `${repo.owner}/${repo.repo}`;
  return `${repo.platform}:${repo.platform === 'github' ? path.toLowerCase() : path}`;
}
function operationKey(repo: RepoRef, intent: RepairIntent): string {
  return createHash('sha256').update(JSON.stringify([
    projectIdentity(repo), intent.request, intent.headSha, intent.policyHash, intent.cause.code, intent.cause.target ?? '',
  ])).digest('hex').slice(0, 32);
}
function render(event: RepairEvent): string {
  const data = Buffer.from(JSON.stringify(event)).toString('base64');
  const prose = event.kind === 'intent'
    ? `SpecGit recorded repair work for ${event.intent.cause.code} at ${event.intent.headSha}.`
    : `SpecGit linked repair issue #${event.issue} to this delivery.`;
  return `${REPAIR_LOG_PREFIX}\n<!-- ${data} -->\n${prose}`;
}

/** Read-only reconstruction of the expected operations, including intents without receipts. */
export async function readRepairLog(repo: RepoRef, request: number, forge: Pick<LogPort, 'getRequestDeclarations'>): Promise<Evidence<RepairOperation[]>> {
  const declarations = await forge.getRequestDeclarations(repo, request, REPAIR_LOG_PREFIX);
  if (!declarations.ok) return declarations;
  const events: RepairEvent[] = [];
  for (const declaration of declarations.value) {
    try {
      const [prefix, payload] = declaration.body.split('\n');
      const encoded = payload?.match(/^<!-- ([A-Za-z0-9+/]+={0,2}) -->$/u)?.[1];
      if (prefix !== REPAIR_LOG_PREFIX || !encoded || declaration.body.length > 16_000) throw new Error('invalid payload');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error('invalid encoding');
      const event = EventSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (event.project !== projectIdentity(repo) || (event.kind === 'intent' ? event.intent.request : event.request) !== request ||
          (event.kind === 'intent' && operationKey(repo, event.intent) !== event.key)) throw new Error('identity mismatch');
      events.push(event);
    } catch {
      return fail('repair_log_invalid', 'A trusted repair declaration is invalid or belongs to another delivery.');
    }
  }
  const operations = new Map<string, RepairOperation>();
  for (const event of events) {
    if (event.kind !== 'intent') continue;
    const next = { key: event.key, ...event.intent };
    const existing = operations.get(event.key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(next)) {
      return fail('repair_log_conflict', 'The repair log contains conflicting intents for one operation.');
    }
    operations.set(event.key, next);
  }
  for (const event of events) {
    if (event.kind !== 'created') continue;
    const operation = operations.get(event.key);
    if (!operation || (operation.issue !== undefined && operation.issue !== event.issue)) {
      return fail('repair_log_conflict', 'A repair receipt has no unique matching intent and issue.');
    }
    operation.issue = event.issue;
  }
  return ok([...operations.values()]);
}

/** Confirm the expected operation before any create-issue side effect is allowed. */
export async function recordRepairIntent(repo: RepoRef, intent: RepairIntent, forge: LogPort): Promise<Evidence<RepairOperation>> {
  const parsed = IntentSchema.safeParse(intent);
  if (!parsed.success) return fail('repair_log_invalid', 'The prepared repair intent is invalid.');
  const key = operationKey(repo, parsed.data);
  const existing = await readRepairLog(repo, intent.request, forge);
  if (!existing.ok) return existing;
  const found = existing.value.find((item) => item.key === key);
  if (found) return ok(found);
  const written = await forge.appendRequestDeclaration(repo, intent.request, REPAIR_LOG_PREFIX,
    render({ version: 1, project: projectIdentity(repo), kind: 'intent', key, intent: parsed.data }));
  if (!written.ok) return written;
  const confirmed = await readRepairLog(repo, intent.request, forge);
  if (!confirmed.ok) return confirmed;
  const operation = confirmed.value.find((item) => item.key === key);
  return operation ? ok(operation) : fail('repair_log_unconfirmed', 'The repair intent is not visible after append.');
}

export async function recordRepairCreation(repo: RepoRef, request: number, key: string, issue: number, forge: LogPort): Promise<Evidence<{ id: string }>> {
  const event = EventSchema.safeParse({ version: 1, project: projectIdentity(repo), kind: 'created', request, key, issue });
  if (!event.success) return fail('repair_log_invalid', 'The repair receipt is invalid.');
  const existing = await readRepairLog(repo, request, forge);
  if (!existing.ok) return existing;
  const operation = existing.value.find((item) => item.key === key);
  if (!operation || (operation.issue !== undefined && operation.issue !== issue)) {
    return fail('repair_log_conflict', 'The repair receipt must preserve the confirmed intent and issue identity.');
  }
  const written = await forge.appendRequestDeclaration(repo, request, REPAIR_LOG_PREFIX, render(event.data));
  if (!written.ok) return written;
  const confirmed = await readRepairLog(repo, request, forge);
  if (!confirmed.ok) return confirmed;
  return confirmed.value.some((item) => item.key === key && item.issue === issue)
    ? written : fail('repair_log_unconfirmed', 'The repair creation receipt is not visible after append.');
}


/** Markers locate candidates; provider-verified writer authority permits adoption. */
export async function trustedRepairCandidates<T extends { number: number }>(
  repo: RepoRef, candidates: readonly T[], forge: Pick<ForgeProvider, 'getIssueWriterAuthority'>,
): Promise<Evidence<T[]>> {
  const trusted: T[] = [];
  for (const candidate of candidates) {
    const authority = await forge.getIssueWriterAuthority(repo, candidate.number);
    if (!authority.ok) return authority;
    if (authority.value) trusted.push(candidate);
  }
  return ok(trusted);
}


export function repairCauseKey(cause: RepairIntent['cause']): string {
  return createHash('sha256').update(cause.target ? `${cause.code}\0${cause.target}` : cause.code).digest('hex').slice(0, 20);
}

/** One adoption decision for first execution and recovery, including earlier heads of the same cause. */
export async function findRepairCandidate(
  repo: RepoRef, operation: RepairOperation,
  forge: Pick<ForgeProvider, 'getOpenIssues' | 'searchIssueHistory' | 'getIssueWriterAuthority'>,
  openIssues?: OpenIssueFact[],
): Promise<Evidence<number | undefined>> {
  if (operation.issue !== undefined) return ok(operation.issue);
  const pool = openIssues === undefined ? await forge.getOpenIssues(repo) : ok(openIssues);
  if (!pool.ok) return pool;
  const marker = `<!-- specgit:failure:${operation.request}:${repairCauseKey(operation.cause)} -->`;
  const sameCause = await trustedRepairCandidates(repo,
    pool.value.filter((issue) => issue.body?.split('\n').some((line) => line.trim() === marker)), forge);
  if (!sameCause.ok) return sameCause;
  if (sameCause.value.length > 1) return fail('repair_issue_ambiguous', 'Several trusted open issues track the same failure cause.');
  if (sameCause.value.length === 1) return ok(sameCause.value[0].number);
  const history = await forge.searchIssueHistory(repo, operation.key);
  if (!history.ok) return history;
  const exact = await trustedRepairCandidates(repo,
    history.value.filter((issue) => issue.body.split('\n').includes(`<!-- specgit:repair-operation:${operation.key} -->`)), forge);
  if (!exact.ok) return exact;
  if (exact.value.length > 1) return fail('repair_issue_ambiguous', 'Several trusted issues carry the same repair operation identity.');
  return ok(exact.value[0]?.number);
}
