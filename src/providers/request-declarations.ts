import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { paginateToExhaustion } from './cli-evidence-transport.js';
import { isGithubActionsApp } from '../harness-runtime/actions-ownership.mjs';
import type { RequestDeclaration } from '../github/port.js';

export interface RequestDeclarationInput {
  platform: 'github' | 'gitlab';
  project: string;
  request: number;
  prefix: string;
  api(path: string): Promise<Evidence<unknown>>;
}

/** Current writer declarations, not immutable proof of an automation execution. */
export async function readRequestDeclarations(input: RequestDeclarationInput): Promise<Evidence<RequestDeclaration[]>> {
  const { platform, project, request, prefix, api } = input;
  if (!Number.isSafeInteger(request) || request <= 0 || !prefix || prefix.length > 128 || /[\r\n]/u.test(prefix)) {
    return fail('request_declaration_invalid', 'A request number and bounded single-line declaration prefix are required.');
  }
  const base = platform === 'github' ? `repos/${project}` : `projects/${encodeURIComponent(project)}`;
  const endpoint = platform === 'github' ? `${base}/issues/${request}/comments` : `${base}/merge_requests/${request}/notes`;
  const rows = await paginateToExhaustion<unknown>(
    { pageSize: 100, maxPages: 10, what: 'Request declaration' },
    async (page) => {
      const result = await api(`${endpoint}?per_page=100&page=${page}`);
      if (!result.ok) return result;
      return Array.isArray(result.value) ? ok(result.value) : fail('request_declaration_unknown', 'The request comment list is unavailable.');
    },
  );
  if (!rows.ok) return rows;
  const declarations: RequestDeclaration[] = [];
  const permissions = new Map<string, boolean>();
  const ids = new Set<string>();
  for (const item of rows.value) {
    if (typeof item !== 'object' || item === null || !('body' in item) || typeof item.body !== 'string') {
      return fail('request_declaration_unknown', 'The forge returned an incomplete request comment.');
    }
    if (!item.body.startsWith(`${prefix}\n`)) continue;
    const row = item as { id?: unknown; body: string; user?: unknown; author?: unknown; performed_via_github_app?: unknown };
    const author = (platform === 'github' ? row.user : row.author) as { id?: unknown; login?: unknown; username?: unknown; type?: unknown } | null;
    if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !author || !Number.isSafeInteger(author.id) || Number(author.id) <= 0) {
      return fail('request_declaration_unknown', 'A declaration has no provider-confirmed comment or author identity.');
    }
    const authorId = String(author.id);
    let permitted = permissions.get(authorId);
    if (permitted === undefined) {
      const authority = await writerAuthority(input, author, row.performed_via_github_app);
      if (!authority.ok) return authority;
      permitted = authority.value;
      permissions.set(authorId, permitted);
    }
    if (!permitted) continue;
    const id = String(row.id);
    if (ids.has(id)) return fail('request_declaration_unknown', 'The request comment list contains duplicate identities.');
    ids.add(id);
    declarations.push({ id, body: row.body });
  }
  return ok(declarations);
}

export async function appendRequestDeclaration(input: RequestDeclarationInput & {
  body: string;
  append(body: string): Promise<Evidence<unknown>>;
}): Promise<Evidence<{ id: string }>> {
  if (!input.body.startsWith(`${input.prefix}\n`) || input.body.length > 16_000) {
    return fail('request_declaration_invalid', 'A bounded declaration must retain its protocol prefix.');
  }
  const existing = await readRequestDeclarations(input);
  if (!existing.ok) return existing;
  const found = existing.value.find((item) => item.body === input.body);
  if (found) return ok({ id: found.id });
  const written = await input.append(input.body);
  if (!written.ok) return written;
  const confirmed = await readRequestDeclarations(input);
  if (!confirmed.ok) return confirmed;
  const receipt = confirmed.value.find((item) => item.body === input.body);
  return receipt ? ok({ id: receipt.id }) : fail('request_declaration_unconfirmed', 'The forge has not confirmed the declaration under a repository writer identity.');
}


/** Provider identity and current repository authority, never payload-declared authors. */
async function writerAuthority(
  input: Pick<RequestDeclarationInput, 'platform' | 'project' | 'api'>,
  rawAuthor: unknown, rawApp?: unknown,
): Promise<Evidence<boolean>> {
  const { platform, project, api } = input;
  const author = rawAuthor as { id?: unknown; login?: unknown; username?: unknown; type?: unknown } | null;
  if (!author || !Number.isSafeInteger(author.id) || Number(author.id) <= 0) {
    return fail('request_declaration_unknown', 'The forge did not identify the author.');
  }
  const app = rawApp as { permissions?: { issues?: unknown } } | null;
  if (platform === 'github' && author.type === 'Bot' && (isGithubActionsApp(app) || app?.permissions?.issues === 'write')) return ok(true);
  const login = platform === 'github' ? author.login : author.username;
  if (typeof login !== 'string' || !login) return fail('request_declaration_unknown', 'The author has no provider identity.');
  const base = platform === 'github' ? `repos/${project}` : `projects/${encodeURIComponent(project)}`;
  const permission = await api(platform === 'github'
    ? `${base}/collaborators/${encodeURIComponent(login)}/permission`
    : `${base}/members/all/${author.id}`);
  if (!permission.ok) return permission;
  if (permission.value === null) return ok(false);
  const value = permission.value as { user?: { id?: unknown }; id?: unknown; permission?: unknown; role_name?: unknown; access_level?: unknown };
  if (typeof value !== 'object' || String(platform === 'github' ? value.user?.id : value.id) !== String(author.id)) {
    return fail('request_declaration_unknown', 'The permission evidence does not identify the author.');
  }
  if (platform === 'github' ? !['read', 'none', 'write', 'maintain', 'admin'].includes(String(value.permission)) :
    !Number.isInteger(value.access_level) || Number(value.access_level) < 0) {
    return fail('request_declaration_unknown', 'The author permission is incomplete.');
  }
  return ok(platform === 'github'
    ? ['write', 'maintain', 'admin'].includes(String(value.permission)) || ['write', 'maintain', 'admin'].includes(String(value.role_name))
    : typeof value.access_level === 'number' && value.access_level >= 30);
}

export async function readIssueWriterAuthority(input: Pick<RequestDeclarationInput, 'platform' | 'project' | 'api'> & {
  issue: number;
}): Promise<Evidence<boolean>> {
  if (!Number.isSafeInteger(input.issue) || input.issue <= 0) return fail('repair_issue_mismatch', 'A valid issue identity is required.');
  const base = input.platform === 'github' ? `repos/${input.project}` : `projects/${encodeURIComponent(input.project)}`;
  const issue = await input.api(`${base}/issues/${input.issue}`);
  if (!issue.ok) return issue;
  const value = issue.value as { number?: unknown; iid?: unknown; user?: unknown; author?: unknown; pull_request?: unknown; performed_via_github_app?: unknown } | null;
  if (!value || typeof value !== 'object' || value.pull_request !== undefined ||
    (input.platform === 'github' ? value.number : value.iid) !== input.issue) return fail('repair_issue_mismatch', 'The candidate is not the expected issue.');
  return writerAuthority(input, input.platform === 'github' ? value.user : value.author, value.performed_via_github_app);
}
