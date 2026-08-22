import { describe, expect, it } from 'vitest';

import { fail, ok } from '../../src/kernel/evidence.js';
import {
  classifySpawnError,
  decodeJsonResponse,
  paginateToExhaustion,
  type SpawnErrorSpec,
} from '../../src/providers/cli-evidence-transport.js';

/**
 * The shared CLI-evidence transport (#274) is the one implementation of
 * the I3b completeness loop and the I3a spawn taxonomy both adapters
 * consume; these cases pin its mechanics directly, independent of any
 * platform fake.
 */

const SPEC: SpawnErrorSpec = {
  platformWord: 'Forge',
  codes: { missing: 'forge_missing', transport: 'forge_transport', timeout: 'forge_timeout' },
  missingMessage: 'Forge CLI is not installed.',
  missingFix: 'Install the forge CLI.',
  timeoutFix: 'Raise the budget.',
  notFoundPattern: /HTTP 404|Not Found/i,
  timeoutMs: 15_000,
};

describe('paginateToExhaustion (I3b)', () => {
  it('collects pages until a short page proves exhaustion', async () => {
    const pages = [[1, 2], [3, 4], [5]];
    const result = await paginateToExhaustion(
      { pageSize: 2, maxPages: 10, what: 'test-list' },
      async (page) => ok(pages[page - 1] ?? [])
    );
    expect(result).toEqual({ ok: true, value: [1, 2, 3, 4, 5] });
  });

  it('an empty first page is exhaustion, not an error', async () => {
    const result = await paginateToExhaustion(
      { pageSize: 2, maxPages: 10, what: 'test-list' },
      async () => ok([])
    );
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('fails evidence_truncated when the cap is reached with a full page', async () => {
    const seen: number[] = [];
    const result = await paginateToExhaustion(
      { pageSize: 2, maxPages: 3, what: 'test-list' },
      async (page) => {
        seen.push(page);
        return ok([page * 10, page * 10 + 1]);
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('evidence_truncated');
    expect(result.message).toBe('test-list pagination hit its cap (6 items); the list may be truncated.');
    // The cap is maxPages full pages; the next page is never requested.
    expect(seen).toEqual([1, 2, 3]);
  });

  it('the cap diagnostic honours unit and capMessage overrides', async () => {
    const unitResult = await paginateToExhaustion(
      { pageSize: 1, maxPages: 2, what: 'Check-run', unit: 'runs' },
      async () => ok([1])
    );
    expect(unitResult).toEqual({
      ok: false,
      code: 'evidence_truncated',
      message: 'Check-run pagination hit its cap (2 runs); the list may be truncated.',
    });
    const overrideResult = await paginateToExhaustion(
      { pageSize: 1, maxPages: 2, what: 'ignored', capMessage: 'platform-shaped cap diagnostic' },
      async () => ok([1])
    );
    expect(overrideResult).toEqual({
      ok: false,
      code: 'evidence_truncated',
      message: 'platform-shaped cap diagnostic',
    });
  });

  it('a page failure short-circuits unchanged — the diagnostic is never laundered', async () => {
    const upstream = fail<unknown[]>('forge_transport', 'upstream page failed');
    const result = await paginateToExhaustion(
      { pageSize: 2, maxPages: 10, what: 'test-list' },
      async (page) => (page === 2 ? upstream : ok([page, page + 10]))
    );
    expect(result).toBe(upstream);
  });
});

describe('decodeJsonResponse', () => {
  it('decodes a JSON response', () => {
    expect(decodeJsonResponse('{"a":1}', 'forge_transport', 'Forge')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it('fails closed in the platform transport code on undecodable output', () => {
    const result = decodeJsonResponse('not json', 'forge_transport', 'Forge');
    expect(result).toEqual({
      ok: false,
      code: 'forge_transport',
      message: 'Forge returned a response that is not valid JSON.',
    });
  });
});

describe('classifySpawnError (I3a)', () => {
  it('an ENOENT spawn failure is a missing CLI', () => {
    const error = Object.assign(new Error('spawn forge ENOENT'), { code: 'ENOENT' });
    expect(classifySpawnError(error, SPEC)).toMatchObject({
      ok: false,
      code: 'forge_missing',
      message: 'Forge CLI is not installed.',
      fix: 'Install the forge CLI.',
    });
  });

  it('a killed child is a timeout in the dedicated code when the platform has one', () => {
    const error = { killed: true, signal: 'SIGTERM' };
    expect(classifySpawnError(error, SPEC)).toMatchObject({
      ok: false,
      code: 'forge_timeout',
      message: 'Forge CLI timed out after 15000 ms.',
      fix: 'Raise the budget.',
    });
  });

  it('without a timeout code the transport code carries the timeout', () => {
    const { timeout: _timeout, ...codes } = SPEC.codes;
    const result = classifySpawnError({ killed: true }, { ...SPEC, codes, timeoutFix: undefined });
    expect(result).toMatchObject({ ok: false, code: 'forge_transport' });
    expect(result.fix).toBeUndefined();
  });

  it('a maxBuffer overflow is a transport failure', () => {
    const result = classifySpawnError({ code: 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' }, SPEC);
    expect(result).toMatchObject({
      ok: false,
      code: 'forge_transport',
      message: 'Forge CLI returned more output than the response size cap allows.',
    });
  });

  it('a not-found stderr marker maps to the neutral not_found code with sanitized text', () => {
    const result = classifySpawnError({ code: 1, stderr: 'forge: Not Found (HTTP 404)\n' }, SPEC);
    expect(result).toMatchObject({
      ok: false,
      code: 'not_found',
      message: 'forge: Not Found (HTTP 404)',
      exitCode: 1,
    });
  });

  it('any other non-zero exit is a transport failure with attributed text', () => {
    const result = classifySpawnError({ code: 1, stderr: 'rate limit exceeded\n' }, SPEC);
    expect(result).toMatchObject({
      ok: false,
      code: 'forge_transport',
      message: 'Forge CLI failed: rate limit exceeded',
      exitCode: 1,
    });
  });

  it('an exit without stderr falls back to the error message', () => {
    const result = classifySpawnError({ code: 2, message: 'boom' }, SPEC);
    expect(result).toMatchObject({ ok: false, code: 'forge_transport', message: 'Forge CLI failed: boom' });
  });
});
