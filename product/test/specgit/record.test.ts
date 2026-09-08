import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  RECORD_FILENAME,
  mergeIssueNumbers,
  parseNumericRef,
} from '../../src/record/schema.js';
import { deleteRecord, readRecord, writeRecord } from '../../src/record/io.js';
import { CODE_INFO } from '../../src/acceptance/codes.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

describe('record io', () => {
  let tempDir: string;
  let root: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-record-');
    root = path.join(tempDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  const recordPath = () => path.join(root, RECORD_FILENAME);

  const bindingInput = () => ({
    version: 1 as const,
    delivery: 'add-login-flow',
    context: { kind: 'branch' as const, branch: 'feat/123-login' },
    issues: [123, 124],
    pr: 42,
  });

  it('round-trips a full record', async () => {
    await writeRecord(root, bindingInput());
    const read = await readRecord(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.delivery).toBe('add-login-flow');
    expect(read.value.context).toEqual({ kind: 'branch', branch: 'feat/123-login' });
    expect(read.value.issues).toEqual([123, 124]);
    expect(read.value.pr).toBe(42);
  });

  it('round-trips a worktree context', async () => {
    await writeRecord(root, {
      ...bindingInput(),
      context: { kind: 'worktree', label: '123-login', branch: 'feat/123-login' },
    });
    const read = await readRecord(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.context).toEqual({
      kind: 'worktree',
      label: '123-login',
      branch: 'feat/123-login',
    });
  });

  it('preserves unknown keys on rewrite', async () => {
    fs.writeFileSync(
      recordPath(),
      [
        'version: 1',
        'delivery: add-login-flow',
        'context:',
        '  kind: branch',
        '  branch: feat/123-login',
        'issues: [123]',
        'custom: keep-me',
        'nested:',
        '  extra: true',
        '',
      ].join('\n')
    );

    const before = await readRecord(root);
    expect(before.ok).toBe(true);

    await writeRecord(root, { ...bindingInput(), issues: [123, 125] });

    const raw = YAML.parse(fs.readFileSync(recordPath(), 'utf-8')) as Record<string, unknown>;
    expect(raw.custom).toBe('keep-me');
    expect(raw.nested).toEqual({ extra: true });
    expect(raw.issues).toEqual([123, 125]);
    expect(raw.pr).toBe(42);
  });

  it('defaults issues to an empty list when absent', async () => {
    fs.writeFileSync(
      recordPath(),
      [
        'version: 1',
        'delivery: add-login-flow',
        'context:',
        '  kind: branch',
        '  branch: feat/123-login',
        '',
      ].join('\n')
    );
    const read = await readRecord(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.issues).toEqual([]);
    expect(read.value.pr).toBeUndefined();
  });

  it('fails closed with record_missing when the file is absent', async () => {
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_missing');
  });

  // #313: the repair leads with the product's human story — `specgit
  // issue` bootstraps issues, branch, and draft PR from a title alone.
  // `specgit bind` may appear only after that primary path, described as
  // the lower-level alias that writes or updates the record — it is not
  // an equivalent bootstrap, so the false equivalence may not return.
  it('carries the issue-first repair on record_missing (#313)', async () => {
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_missing');
    const fix = read.fix ?? '';
    expect(fix).toContain('specgit issue');
    const issueAt = fix.indexOf('specgit issue');
    const bindAt = fix.indexOf('specgit bind');
    expect(bindAt === -1 || issueAt < bindAt).toBe(true);
    // `bind` is described by what it does — record write/update from
    // explicit inputs — never as "the same bootstrap".
    expect(fix).not.toContain('same bootstrap');
    expect(fix).toContain('delivery binding record');
    expect(fix).toMatch(/writes or updates/i);
    // One shared product repair also drives the diagnostic registry —
    // the two sources cannot drift apart.
    expect(fix).toBe(CODE_INFO.record_missing.fix);
  });

  it('fails closed with record_invalid on corrupt YAML', async () => {
    fs.writeFileSync(recordPath(), '[unclosed flow sequence\n');
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_invalid');
  });

  it('fails closed with record_invalid when YAML is not an object', async () => {
    fs.writeFileSync(recordPath(), '- just\n- a list\n');
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_invalid');
  });

  it('rejects version 2', async () => {
    fs.writeFileSync(recordPath(), YAML.stringify({ ...bindingInput(), version: 2 }));
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_invalid');
  });

  it('rejects an unknown context kind', async () => {
    fs.writeFileSync(
      recordPath(),
      YAML.stringify({ ...bindingInput(), context: { kind: 'detached', branch: 'x' } })
    );
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_invalid');
  });

  it('rejects an absolute-path worktree label', async () => {
    fs.writeFileSync(
      recordPath(),
      YAML.stringify({
        ...bindingInput(),
        context: { kind: 'worktree', label: '/abs/path', branch: 'feat/123-login' },
      })
    );
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_invalid');
  });

  it('rejects a non-kebab delivery id', async () => {
    fs.writeFileSync(
      recordPath(),
      YAML.stringify({ ...bindingInput(), delivery: 'Add Login Flow' })
    );
    const read = await readRecord(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('record_invalid');
  });

  it('rejects non-integer or non-positive issue numbers', async () => {
    fs.writeFileSync(recordPath(), YAML.stringify({ ...bindingInput(), issues: [1.5] }));
    expect((await readRecord(root)).ok).toBe(false);
    fs.writeFileSync(recordPath(), YAML.stringify({ ...bindingInput(), issues: [0] }));
    const second = await readRecord(root);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('record_invalid');
  });

  it('deleteRecord removes the file and is idempotent', async () => {
    await writeRecord(root, bindingInput());
    await deleteRecord(root);
    expect(fs.existsSync(recordPath())).toBe(false);
    await expect(deleteRecord(root)).resolves.toBeUndefined();
  });

  it('writeRecord drops pr when the new binding omits it', async () => {
    await writeRecord(root, bindingInput());
    const { pr: _pr, ...rest } = bindingInput();
    await writeRecord(root, { ...rest, pr: undefined });
    const raw = YAML.parse(fs.readFileSync(recordPath(), 'utf-8')) as Record<string, unknown>;
    expect('pr' in raw).toBe(false);
  });
});

describe('issue merge helpers', () => {
  it('mergeIssueNumbers dedupes preserving first-seen order', () => {
    expect(mergeIssueNumbers([3, 1], [1, 2, 3])).toEqual([3, 1, 2]);
    expect(mergeIssueNumbers([], [])).toEqual([]);
  });

  it('parseNumericRef coerces pure-digit refs only', () => {
    expect(parseNumericRef('42')).toBe(42);
    expect(parseNumericRef(' 7 ')).toBe(7);
    expect(parseNumericRef('JIRA-1')).toBeNull();
    expect(parseNumericRef('https://github.com/o/r/issues/5')).toBeNull();
    expect(parseNumericRef('')).toBeNull();
    expect(parseNumericRef('0')).toBeNull();
  });
});
