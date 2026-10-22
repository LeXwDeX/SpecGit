import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubFiles, publishGithub, releaseNotes, verifySignature } from './publish.mjs';

const source = 'a'.repeat(40);
const changelog = '# Changelog\n\n# 2.0.0\n\n- Fixture change. (#1)\n\n# 1.9.0\n\n- Older change.\n';
function fixture(t, { draft, existing = [], corrupt, otherSource, interruptUpload } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'specgit-github-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packages = ['specgit-2.0.0-darwin-arm64.zip', 'specgit-2.0.0-linux-x64-gnu.zip', 'specgit-2.0.0-win32-x64.zip'];
  for (const name of [...packages, 'wrapper.tgz']) writeFileSync(path.join(directory, name), `qualified ${name}`);
  const release = { version: '2.0.0', source, archives: packages.map(filename => ({ filename, file: path.join(directory, filename), sha256: createHash('sha256').update(readFileSync(path.join(directory, filename))).digest('hex') })) };
  writeFileSync(path.join(directory, 'SHA256SUMS'), release.archives.map(a => `${a.sha256}  ${a.filename}\n`).join(''));
  writeFileSync(path.join(directory, 'SHA256SUMS.sigstore.json'), 'signature fixture');
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
    if (args.includes('--notes-file')) (remote.notes ??= []).push(readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'));
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
  return { directory, release, names, remote, calls, io: { request, cli, verify: () => {}, buildRun: '123', notesSource: { changelog } } };
}
test('new release is created as draft and only published after all byte readbacks', t => {
  const f = fixture(t);
  const result = publishGithub(f.release, f.directory, f.io);
  assert.deepEqual(result.assets_verified, f.names);
  assert.equal(f.names.length, 5);
  assert(!f.names.includes('wrapper.tgz'));
  assert(f.names.includes('SHA256SUMS.sigstore.json'));
  assert(f.names.filter(name => name.endsWith('.zip')).length === 3);
  const notes = releaseNotes(f.release, '123', { changelog });
  assert.deepEqual(f.remote.notes, [notes, notes]);
  for (const binary of f.release.archives) assert(notes.includes(`| \`${binary.filename}\` | \`${binary.sha256}\` |`));
  assert(notes.startsWith('# SpecGit 2.0.0\n'));
  assert(notes.includes('## Changes\n\n- Fixture change. (#1)\n\n## Install'));
  assert(!notes.includes('Older change'));
  assert(!notes.includes('<!--') && !/\{\{\w+\}\}/.test(notes));
  assert(notes.includes(`/commit/${source})`));
  assert(notes.includes(`/blob/${source}/LICENSE`));
  assert(notes.includes('/actions/runs/123)'));
  assert(notes.includes('/compare/v1.9.0...v2.0.0)'));
  for (const doc of ['agent-install.md', 'agent-project-refresh.md', 'migration-v2.md']) {
    assert(notes.includes(`/blob/v2.0.0/docs/${doc})`), doc);
    assert(readFileSync(new URL(`../../docs/${doc}`, import.meta.url), 'utf8').length > 0);
  }
  assert(!notes.includes('/blob/main/'));
  assert(!notes.includes('into a directory on PATH'));
  const guide = readFileSync(new URL('../../docs/agent-install.md', import.meta.url), 'utf8');
  assert(guide.includes('cosign verify-blob'));
  assert(/sha256|SHA-256/.test(guide));
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
  const f = fixture(t, { draft: true, existing: ['specgit-2.0.0-darwin-arm64.zip'] });
  publishGithub(f.release, f.directory, f.io);
  assert.equal(f.calls.some(call => call[1] === 'create'), false);
  assert.equal(f.calls.filter(call => call[1] === 'upload').length, f.names.length - 1);
  const conflict = fixture(t, { draft: true, existing: ['specgit-2.0.0-win32-x64.zip'], corrupt: 'specgit-2.0.0-win32-x64.zip' });
  assert.throws(() => publishGithub(conflict.release, conflict.directory, conflict.io), /differs/);
  assert.equal(conflict.calls.some(call => ['upload', 'edit', 'create'].includes(call[1])), false);
  const extra = fixture(t, { draft: true, existing: ['wrapper.tgz'] });
  assert.throws(() => publishGithub(extra.release, extra.directory, extra.io), /Unexpected Release asset/);
  assert.equal(extra.calls.some(call => ['upload', 'edit', 'create'].includes(call[1])), false);
});
test('published releases are read back without duplicate uploads; foreign source tags are never changed', t => {
  const f = fixture(t, { draft: false, existing: ['specgit-2.0.0-darwin-arm64.zip', 'specgit-2.0.0-linux-x64-gnu.zip', 'specgit-2.0.0-win32-x64.zip', 'SHA256SUMS', 'SHA256SUMS.sigstore.json'] });
  publishGithub(f.release, f.directory, f.io);
  assert.equal(f.calls.some(call => ['upload', 'create'].includes(call[1])), false);
  const foreign = fixture(t, { draft: true, otherSource: 'b'.repeat(40) });
  assert.throws(() => publishGithub(foreign.release, foreign.directory, foreign.io), /another commit/);
  assert.equal(foreign.calls.some(call => ['upload', 'create', 'edit'].includes(call[1])), false);
});

test('missing or incomplete release notes stop publication before the tag write', t => {
  const f = fixture(t);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, notesSource: { changelog: '# 1.9.0\n\n- Older change.\n' } }), /no "# 2.0.0" section/);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, notesSource: { changelog: '# 2.0.0\n\n# 1.9.0\n\n- Older.\n' } }), /section 2.0.0 is empty/);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, notesSource: { changelog: '# 2.0.0\n\n- Only.\n' } }), /no version section before/);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, notesSource: { changelog, template: '{{version}} {{unknown}}' } }), /Unknown release template placeholder/);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, notesSource: { changelog, template: '{{ version }}' } }), /written as \{\{name\}\}/);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, buildRun: undefined }), /build run ID/);
  assert.equal(f.calls.length, 0);
});
test('the repository template renders every placeholder for the current CHANGELOG version', () => {
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const archives = ['darwin-arm64', 'linux-x64-gnu', 'win32-x64'].map(platform => ({ filename: `specgit-${version}-${platform}.zip`, sha256: 'c'.repeat(64) }));
  const notes = releaseNotes({ version, source, archives }, '456');
  assert(notes.startsWith(`# SpecGit ${version}\n`));
  assert(!notes.includes('<!--') && !/\{\{\w+\}\}/.test(notes));
  // A Windows autocrlf checkout must render the same LF notes.
  const crlf = text => text.replace(/\r?\n/g, '\r\n');
  const template = readFileSync(new URL('../../.github/RELEASE_TEMPLATE.md', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(releaseNotes({ version, source, archives }, '456', { template: crlf(template), changelog: crlf(changelog) }), notes);
  assert(!notes.includes('\r'));
});
test('the release version check renders the notes before any build', () => {
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-version.mjs', import.meta.url)), '--version', version], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).release_notes, 'renderable');
});
test('a rejected signature stops publication before any forge operation', t => {
  const f = fixture(t);
  assert.throws(() => publishGithub(f.release, f.directory, { ...f.io, verify: () => { throw new Error('Signature rejected'); } }), /Signature rejected/);
  assert.equal(f.calls.length, 0);
  verifySignature(f.directory, (program, args) => {
    assert.equal(program, 'cosign');
    assert.deepEqual(args, ['verify-blob', '--bundle', path.join(f.directory, 'SHA256SUMS.sigstore.json'),
      '--certificate-identity', 'https://github.com/LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main',
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', path.join(f.directory, 'SHA256SUMS')]);
  });
});
