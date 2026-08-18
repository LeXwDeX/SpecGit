import { describe, expect, it } from 'vitest';

import { parseClosingRefs } from '../../src/github/closing-refs.js';

const KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

describe('parseClosingRefs', () => {
  it('parses every keyword with a bare #N ref', () => {
    for (const keyword of KEYWORDS) {
      expect(parseClosingRefs(`${keyword} #5`)).toEqual(new Set([5]));
      expect(parseClosingRefs(`${keyword.charAt(0).toUpperCase()}${keyword.slice(1)} #5`)).toEqual(
        new Set([5])
      );
    }
  });

  it('parses owner/repo#N refs', () => {
    expect(parseClosingRefs('closes owner/repo#9')).toEqual(new Set([9]));
    expect(parseClosingRefs('Fixes LeXwDeX/SpecGit#12')).toEqual(new Set([12]));
  });

  it('parses full github.com issue URLs', () => {
    expect(parseClosingRefs('resolved https://github.com/o/r/issues/33')).toEqual(new Set([33]));
    expect(parseClosingRefs('closes https://github.com/o/r/issues/3. closes #4')).toEqual(
      new Set([3, 4])
    );
  });

  it('collects multiple refs from one body and dedupes', () => {
    const body = 'Closes #5, fixes owner/repo#6.\nResolves #5.\nPlain #7 mentioned.';
    expect(parseClosingRefs(body)).toEqual(new Set([5, 6]));
  });

  it('ignores closing keywords inside fenced code blocks', () => {
    const body = [
      'Intro.',
      '',
      '```',
      'closes #5',
      'fixes #6',
      '```',
      '',
      'Resolves #7.',
    ].join('\n');
    expect(parseClosingRefs(body)).toEqual(new Set([7]));
  });

  it('ignores keywords in fences with info strings and tilde fences', () => {
    const body = '```rust\nfixes #7\n```\nresolves #8\n~~~\nclose #9\n~~~\nclosed #10';
    expect(parseClosingRefs(body)).toEqual(new Set([8, 10]));
  });

  it('treats the rest of an unclosed fence as code', () => {
    expect(parseClosingRefs('fixes #2\n```\ncloses #3')).toEqual(new Set([2]));
  });

  it('does not treat non-closing mentions as closing refs', () => {
    expect(parseClosingRefs('Related to #5')).toEqual(new Set());
    expect(parseClosingRefs('Mentions #5 and references owner/repo#6')).toEqual(new Set());
    expect(parseClosingRefs('#5 alone')).toEqual(new Set());
    expect(parseClosingRefs('fix deadbeef')).toEqual(new Set());
    expect(parseClosingRefs('unclosed #5')).toEqual(new Set());
    expect(parseClosingRefs('')).toEqual(new Set());
  });
});
