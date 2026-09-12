import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { githubFiles, publishGithub, releaseNotes } from './publish.mjs';

const source = 'a'.repeat(40);
function fixture(t, { draft, existing = [], corrupt, otherSource, interruptUpload } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'specgit-github-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packages = ['specgit-darwin-arm64', 'specgit-linux-x64-gnu', 'specgit-win32-x64.exe'];
  for (const name of [...packages, 'wrapper.tgz']) writeFileSync(path.join(directory, name), `qualified ${name}`);
  const release = { version: '2.0.0', source, binaries: packages.map(filename => ({ filename, file: path.join(directory, filename), sha256: createHash('sha256').update(readFileSync(path.join(directory, filename))).digest('hex') })) };
  const names = githubFiles(release, directory).map(file => path.basename(file));
  const remote = { exists: draft !== undefined, draft: draft ?? true, latest: false, tag: true, assets: new Map(existing.map(name => [name, name === corrupt ? Buffer.from('different') : readFileSync(path.join(directory, name))])) };
  const calls = [];
  let interrupted = false;
  const request = (route, args = []) => {
    calls.push(['api', route, ...args]);
    if (route.includes('matching-refs')) return [{ ref: 'refs/tags/v2.0.0' }];
    if (route.includes('/commits/')) return { sha: otherSource ?? source };
    if (route.endsWith('/releases/latest')) return { tag_name: remote.latest ? 'v2.0.0' : 'old' };
    if (route.includes('/releases?')) return [remote.exists ? [{ tag_name: 'v2.0.0', draft: remote.draft }] : []];
    throw new Error(`Unexpected API ${route}`);
  };
  const cli = args => {
    calls.push(args);
    if (args[1] === 'create') { assert(args.includes('--draft')); remote.exists = true; remote.draft = true; return ''; }
    if (args[1] === 'view') return JSON.stringify({ tagName: 'v2.0.0', isDraft: remote.draft, isPrerelease: false, assets: [...remote.assets.keys()].map(name => ({ name })), url: 'https://example.invalid/release' });
    if (args[1] === 'download') { const name = args[args.indexOf('--pattern') + 1]; writeFileSync(args[args.indexOf('--output') + 1], remote.assets.get(name)); return ''; }
    if (args[1] === 'upload') {
      const file = args.at(-1); remote.assets.set(path.basename(file), readFileSync(file));
      if (interruptUpload && !interrupted) { interrupted = true; throw new Error('interrupted after asset upload'); }
      return '';
    }
    if (args[1] === 'edit') {
      assert(names.every(name => remote.assets.has(name)), 'publishing requires every verified asset');
      remote.draft = false; remote.latest = true; return '';
    }
    throw new Error(`Unexpected CLI ${args}`);
  };
  return { directory, release, names, remote, calls, io: { request, cli } };
}
test('new release is created as draft and only published after all byte readbacks', t => {
  const f = fixture(t);
  const result = publishGithub(f.release, f.directory, f.io);
  assert.deepEqual(result.assets_verified, f.names);
  assert.equal(f.names.length, 3);
  assert(!f.names.includes('wrapper.tgz'));
  assert(!f.names.some(name => /\.tgz$|\.json$|\.txt$/.test(name)));
  const notes = releaseNotes(f.release, '123');
  for (const binary of f.release.binaries) assert(notes.includes(binary.sha256));
  assert(notes.includes(source));
  assert(notes.includes('/actions/runs/123'));
  assert.equal(f.remote.draft, false);
  assert.equal(f.calls.filter(call => call[1] === 'create').length, 1);
  const edit = f.calls.findIndex(call => call[1] === 'edit');
  assert.equal(f.calls.slice(0, edit).filter(call => call[1] === 'download').length, f.names.length);
});
test('an interrupted upload leaves a matching draft that resumes without duplicate assets', t => {
  const f = fixture(t, { interruptUpload: true });
  assert.throws(() => publishGithub(f.release, f.directory, f.io), /interrupted/);
  assert.equal(f.remote.draft, true);
  publishGithub(f.release, f.directory, f.io);
  assert.equal(f.remote.draft, false);
  assert.equal(f.calls.filter(call => call[1] === 'create').length, 1);
  assert.equal(f.calls.filter(call => call[1] === 'upload').length, f.names.length);
});
test('a matching pre-existing draft can be completed; a conflicting asset causes zero upload or publish writes', t => {
  const f = fixture(t, { draft: true, existing: ['specgit-darwin-arm64'] });
  publishGithub(f.release, f.directory, f.io);
  assert.equal(f.calls.some(call => call[1] === 'create'), false);
  assert.equal(f.calls.filter(call => call[1] === 'upload').length, f.names.length - 1);
  const conflict = fixture(t, { draft: true, existing: ['specgit-win32-x64.exe'], corrupt: 'specgit-win32-x64.exe' });
  assert.throws(() => publishGithub(conflict.release, conflict.directory, conflict.io), /differs/);
  assert.equal(conflict.calls.some(call => ['upload', 'edit', 'create'].includes(call[1])), false);
  const extra = fixture(t, { draft: true, existing: ['wrapper.tgz'] });
  assert.throws(() => publishGithub(extra.release, extra.directory, extra.io), /Unexpected Release asset/);
  assert.equal(extra.calls.some(call => ['upload', 'edit', 'create'].includes(call[1])), false);
});
test('published releases are read back without duplicate uploads; foreign source tags are never changed', t => {
  const f = fixture(t, { draft: false, existing: ['specgit-darwin-arm64', 'specgit-linux-x64-gnu', 'specgit-win32-x64.exe'] });
  publishGithub(f.release, f.directory, f.io);
  assert.equal(f.calls.some(call => ['upload', 'create'].includes(call[1])), false);
  const foreign = fixture(t, { draft: true, otherSource: 'b'.repeat(40) });
  assert.throws(() => publishGithub(foreign.release, foreign.directory, foreign.io), /another commit/);
  assert.equal(foreign.calls.some(call => ['upload', 'create', 'edit'].includes(call[1])), false);
});
