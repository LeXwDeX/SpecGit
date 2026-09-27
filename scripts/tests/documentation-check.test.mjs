import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDocumentation, headingIds } from '../documentation-check.mjs';

test('checks repository and extensionless Wiki targets and real anchors', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specgit-docs-'));
  try {
    mkdirSync(path.join(root, 'docs/wiki'), { recursive: true });
    writeFileSync(path.join(root, 'docs/wiki/Home.md'), '# 首页\n## A title\n## A title\n');
    writeFileSync(path.join(root, 'docs/wiki/_Sidebar.md'), '[Home](Home#首页)\n[Second](Home#a-title-1)\n');
    writeFileSync(path.join(root, 'README.md'), '[Wiki](https://github.com/LeXwDeX/SpecGit/wiki)\n[Source](https://github.com/LeXwDeX/SpecGit/blob/main/docs/wiki/Home.md#a-title)\n```md\n[Example](missing.md)\n```\n');
    const files = ['README.md', 'docs/wiki/_Sidebar.md', 'docs/wiki/Home.md'];
    assert.equal(checkDocumentation(root, files), 3);
    writeFileSync(path.join(root, 'README.md'), '[Bad anchor](docs/wiki/Home.md#gone)');
    assert.throws(() => checkDocumentation(root, files), /missing anchor/);
    writeFileSync(path.join(root, 'README.md'), '[Missing](docs/gone.md)');
    assert.throws(() => checkDocumentation(root, files), /missing target/);
    writeFileSync(path.join(root, 'README.md'), '[Ref][ref]\n\n[ref]: missing.md');
    assert.throws(() => checkDocumentation(root, files), /missing target/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('heading anchors ignore fenced examples and preserve Unicode', () => {
  assert.deepEqual([...headingIds('# Real\n```md\n# Example\n```\n# 中文 `CLI`\n# Real\n')], ['real', '中文-cli', 'real-1']);
});


test('code headings retain generic type names and IDs cannot contain HTML delimiters', () => {
  const ids = [...headingIds('# `Option<T>`\n# <scr<script>ipt>\n')];
  assert.deepEqual(ids, ['optiont', 'scrscriptipt']);
  assert(ids.every(id => !/[<>]/.test(id)));
});
