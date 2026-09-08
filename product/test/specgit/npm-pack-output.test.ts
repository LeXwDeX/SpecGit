import { describe, expect, it } from 'vitest';
import { parseNpmPackFilename } from '../../scripts/npm-pack-output.mjs';

const entry = { name: 'specgit', version: '1.2.3', filename: 'specgit-1.2.3.tgz' };

describe('npm pack JSON compatibility (#419)', () => {
  it.each([
    { name: 'npm <=11 array', output: [entry] },
    { name: 'npm 12 package map', output: { specgit: entry } },
    { name: 'npm 12 scoped package map', output: { '@team/specgit': entry } },
  ])('accepts a single tarball from $name', ({ output }) => {
    expect(parseNpmPackFilename(JSON.stringify(output))).toBe(entry.filename);
  });

  it.each([{ output: [entry] }, { output: { specgit: entry } }])('accepts lifecycle banners before the JSON document: %j', ({ output }) => {
    const banner = '> specgit@1.2.3 prepare\r\n> pnpm run build\r\nBuild complete.\r\n';
    expect(parseNpmPackFilename(banner + JSON.stringify(output, null, 2) + '\r\n')).toBe(entry.filename);
  });

  it.each([
    { name: 'empty array', value: [] },
    { name: 'empty map', value: {} },
    { name: 'multiple array entries', value: [entry, entry] },
    { name: 'multiple package keys', value: { specgit: entry, other: entry } },
    { name: 'missing filename', value: [{ name: 'specgit' }] },
    { name: 'null array entry', value: [null] },
    { name: 'null map entry', value: { specgit: null } },
    { name: 'nested array', value: [[entry]] },
    { name: 'string array entry', value: [entry.filename] },
    { name: 'string map entry', value: { specgit: entry.filename } },
    { name: 'number filename', value: [{ filename: 42 }] },
    { name: 'npm error', value: { error: { code: 'E404' } } },
    { name: 'bare filename record', value: { filename: entry.filename } },
    { name: 'null document', value: null },
    { name: 'number document', value: 1 },
    { name: 'string document', value: entry.filename },
  ])('rejects $name', ({ value }) => {
    expect(() => parseNpmPackFilename(JSON.stringify(value))).toThrow(/npm pack/);
  });

  it.each(['', 'Build complete.', '[invalid json', JSON.stringify([entry]) + '\nextra output',
    '[]\n' + JSON.stringify({ specgit: entry })])('rejects incomplete or extra JSON output: %j', (output) => {
    expect(() => parseNpmPackFilename(output)).toThrow(/npm pack/);
  });

  it.each(['', ' ', '../outside.tgz', '/tmp/outside.tgz', 'subdir/file.tgz',
    '..\\outside.tgz', 'C:\\outside.tgz', 'C:outside.tgz', 'name\n.tgz', 'name\0.tgz',
    ' specgit.tgz ', 'specgit.zip'])('rejects unsafe or invalid tarball filename: %j', (filename) => {
    expect(() => parseNpmPackFilename(JSON.stringify([{ filename }]))).toThrow(/npm pack/);
  });
});
