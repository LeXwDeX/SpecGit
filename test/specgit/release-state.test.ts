import { describe, expect, it } from 'vitest';
import { readReleaseState, finalizeRelease } from '../../scripts/release-state.mjs';

const version = '1.2.3';
const publishedSha = 'a'.repeat(40);
const currentSha = 'b'.repeat(40);
const missing = () => Object.assign(new Error('Not published'), { stdout: JSON.stringify({ error: { code: 'E404' } }) });

function fixture(options: { published?: boolean; tag?: string; release?: boolean; npmError?: Error } = {}) {
  const { published = true, tag, release = false, npmError } = options;
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'npm') {
      if (npmError) throw npmError;
      if (!published) throw missing();
      return JSON.stringify({ version, gitHead: publishedSha });
    }
    if (command === 'git' && args[0] === 'rev-parse') return currentSha;
    if (command === 'git' && args[0] === 'ls-remote') return tag ? `${tag}\trefs/tags/v${version}\n` : '';
    if (command === 'git') return '';
    if (command === 'gh' && args[1] === 'view') {
      if (!release) throw new Error('release not found');
      return '';
    }
    if (command === 'gh' && args[1] === 'create') return '';
    throw new Error(`Unexpected command ${command} ${args.join(' ')}`);
  };
  return { run, calls };
}

describe('release state and partial publication recovery (#392)', () => {
  it('plans publication only for an explicit registry E404 with no existing tag', () => {
    const { run } = fixture({ published: false });
    expect(readReleaseState({ version, run })).toEqual({ needsPublish: true, releaseSha: currentSha, tagExists: false });
  });

  it('recovers the published source after main advanced, without republishing', () => {
    const { run, calls } = fixture();
    expect(readReleaseState({ version, run })).toEqual({ needsPublish: false, releaseSha: publishedSha, tagExists: false });
    finalizeRelease({ version, run });
    expect(calls).toContainEqual(['git', 'tag', `v${version}`, publishedSha]);
    expect(calls).toContainEqual(['git', 'push', 'origin', `refs/tags/v${version}`]);
    expect(calls.some((call) => call[0] === 'npm' && call[1] === 'publish')).toBe(false);
    expect(calls.find((call) => call[0] === 'gh' && call[1] === 'release' && call[2] === 'create')).toContain('--verify-tag');
  });

  it('recovers a missing release after tag push succeeded', () => {
    const { run, calls } = fixture({ tag: publishedSha });
    finalizeRelease({ version, run });
    expect(calls.some((call) => call[0] === 'git' && ['tag', 'push'].includes(call[1]))).toBe(false);
    expect(calls.some((call) => call[0] === 'gh' && call[2] === 'create')).toBe(true);
  });

  it('leaves a complete release untouched on repeated retries', () => {
    const { run, calls } = fixture({ tag: publishedSha, release: true });
    finalizeRelease({ version, run });
    expect(calls.some((call) => call[0] === 'git' && ['tag', 'push'].includes(call[1]))).toBe(false);
    expect(calls.some((call) => call[0] === 'gh' && call[2] === 'create')).toBe(false);
  });

  it('refuses to alter a tag pointing at a different source commit', () => {
    const { run, calls } = fixture({ tag: currentSha });
    expect(() => finalizeRelease({ version, run })).toThrow(/different.*commit/);
    expect(calls.some((call) => call[0] === 'git' && ['tag', 'push'].includes(call[1]))).toBe(false);
  });

  it('compares an annotated tag by its peeled commit, not the tag object', () => {
    const { run: baseRun } = fixture({ release: true });
    const run = (command: string, args: string[]) => command === 'git' && args[0] === 'ls-remote'
      ? `${currentSha}\trefs/tags/v${version}\n${publishedSha}\trefs/tags/v${version}^{}\n`
      : baseRun(command, args);
    expect(readReleaseState({ version, run })).toEqual({ needsPublish: false, releaseSha: publishedSha, tagExists: true });
  });

  it('refuses publication when a tag exists but registry publication is absent', () => {
    const { run } = fixture({ published: false, tag: publishedSha });
    expect(() => readReleaseState({ version, run })).toThrow(/tag.*publication/i);
  });

  it.each(['ENOTFOUND', 'E401', 'E500'])('does not interpret %s as an unpublished version', (code) => {
    const error = Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) });
    const { run } = fixture({ npmError: error });
    expect(() => readReleaseState({ version, run })).toThrow(code);
  });

  it('refuses finalization before npm confirms publication', () => {
    const { run, calls } = fixture({ published: false });
    expect(() => finalizeRelease({ version, run })).toThrow(/not published/);
    expect(calls.some((call) => call[0] === 'gh' || call[1] === 'tag')).toBe(false);
  });

  it('requires a trustworthy registry source commit before recovering a tag', () => {
    const { run: baseRun } = fixture();
    const run = (command: string, args: string[]) => command === 'npm' ? JSON.stringify({ version }) : baseRun(command, args);
    expect(() => readReleaseState({ version, run })).toThrow(/source commit/);
  });
});
