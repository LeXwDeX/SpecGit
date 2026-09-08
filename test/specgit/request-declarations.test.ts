import { describe, expect, it, vi } from 'vitest';
import { appendRequestDeclaration, readRequestDeclarations } from '../../src/providers/request-declarations.js';
import { fail, ok, type Evidence } from '../../src/kernel/evidence.js';

const prefix = '<!-- specgit:repair:v1 -->';
const body = `${prefix}\n{"kind":"intent"}`;

describe('provider-backed request declarations', () => {
  it.each(['github', 'gitlab'] as const)('accepts %s declarations from verified repository writers and ignores copied outsider comments', async (platform) => {
    const authors = [{ id: 1, login: 'writer', username: 'writer' }, { id: 2, login: 'outsider', username: 'outsider' }];
    const api = vi.fn(async (path: string): Promise<Evidence<unknown>> => {
      if (path.includes('/permission')) return ok({ user: { id: 1 }, permission: 'write' });
      if (path.includes('/members/all/')) return ok(path.endsWith('/1') ? { id: 1, access_level: 30 } : null);
      return ok(authors.map((author, i) => ({ id: i + 1, body, user: author, author })));
    });
    if (platform === 'github') api.mockImplementation(async (path) => path.includes('/permission')
      ? ok(path.includes('/writer/') ? { user: { id: 1 }, permission: 'write' } : { user: { id: 2 }, permission: 'read' })
      : ok(authors.map((user, i) => ({ id: i + 1, body, user }))));
    expect(await readRequestDeclarations({ platform, project: 'owner/repo', request: 42, prefix, api }))
      .toEqual(ok([{ id: '1', body }]));
  });

  it('does not mistake a bot name or an organization association for write authority', async () => {
    const api = vi.fn(async (path: string) => path.includes('/permission') ? ok(null) : ok([
      { id: 1, body, author_association: 'MEMBER', user: { id: 2, login: 'github-actions[bot]', type: 'Bot' } },
    ]));
    expect(await readRequestDeclarations({ platform: 'github', project: 'owner/repo', request: 42, prefix, api })).toEqual(ok([]));
  });

  it('keeps unavailable permission evidence unknown and never substitutes an empty log', async () => {
    const api = vi.fn(async (path: string) => path.includes('/permission') ? fail('gh_transport', 'permission probe failed') : ok([
      { id: 1, body, user: { id: 2, login: 'writer' } },
    ]));
    expect(await readRequestDeclarations({ platform: 'github', project: 'owner/repo', request: 42, prefix, api }))
      .toMatchObject({ ok: false, code: 'gh_transport' });
  });

  it('rejects permission payloads that omit permission or identify another user', async () => {
    for (const permission of [{ user: { id: 2 } }, { user: { id: 3 }, permission: 'write' }]) {
      const api = async (path: string) => path.includes('/permission') ? ok(permission) : ok([
        { id: 1, body, user: { id: 2, login: 'writer' } },
      ]);
      expect(await readRequestDeclarations({ platform: 'github', project: 'owner/repo', request: 42, prefix, api }))
        .toMatchObject({ ok: false, code: 'request_declaration_unknown' });
    }
  });

  it('reads every page before authorizing the complete declaration set', async () => {
    const api = vi.fn(async (path: string) => path.includes('/permission') ? ok({ user: { id: 1 }, permission: 'write' }) : ok(
      path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'discussion' })) :
        [{ id: 101, body, user: { id: 1, login: 'writer' } }],
    ));
    expect(await readRequestDeclarations({ platform: 'github', project: 'owner/repo', request: 42, prefix, api }))
      .toEqual(ok([{ id: '101', body }]));
    expect(api.mock.calls.some(([path]) => path.endsWith('page=2'))).toBe(true);
  });

  it('reconciles a lost append response without posting a duplicate', async () => {
    const rows: unknown[] = [];
    const api = async (path: string) => path.includes('/permission') ? ok({ user: { id: 1 }, permission: 'write' }) : ok(rows);
    const append = vi.fn(async () => {
      rows.push({ id: 1, body, user: { id: 1, login: 'writer' } });
      return fail('gh_transport', 'response lost');
    });
    const input = { platform: 'github' as const, project: 'owner/repo', request: 42, prefix, body, api, append };
    expect(await appendRequestDeclaration(input)).toMatchObject({ ok: false });
    expect(await appendRequestDeclaration(input)).toEqual(ok({ id: '1' }));
    expect(append).toHaveBeenCalledOnce();
  });

  it('does not acknowledge a write response without visible writer-authored readback', async () => {
    const api = async () => ok([]);
    expect(await appendRequestDeclaration({ platform: 'gitlab', project: 'owner/repo', request: 42, prefix, body, api, append: async () => ok(undefined) }))
      .toMatchObject({ ok: false, code: 'request_declaration_unconfirmed' });
  });
});
