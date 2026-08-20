import { describe, expect, it } from 'vitest';

import { parseClosingRefs } from '../../src/github/closing-refs.js';

// The GitLab dialect of the closing-refs grammar (#115), pinned to GitLab's
// default closing pattern at v19.2 (docs/evidence/gitlab-19.2.md, ledger
// rows 12-14): 16 keyword forms in 4 families (initial-case or lowercase —
// all-caps never matches), optional colon, optional issue(s) word,
// comma/`and` multi-reference continuations, and the row-13 reference
// forms: local #<iid>, cross-project full-path refs (nested group paths
// anchored at docs level), and full /-/issues/ URLs. Work-item URLs,
// bracket refs, and external-tracker keys are excluded by the pin.

const gl = (body: string) => parseClosingRefs(body, 'gitlab');

const GITLAB_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'closing',
  'fix',
  'fixes',
  'fixed',
  'fixing',
  'resolve',
  'resolves',
  'resolved',
  'resolving',
  'implement',
  'implements',
  'implemented',
  'implementing',
];

describe('parseClosingRefs (gitlab dialect)', () => {
  it('parses all 16 keyword forms in 4 families, lower and initial-case', () => {
    for (const keyword of GITLAB_KEYWORDS) {
      expect(gl(`${keyword} #5`), keyword).toEqual(new Set([5]));
      expect(gl(`${keyword.charAt(0).toUpperCase()}${keyword.slice(1)} #5`), keyword).toEqual(
        new Set([5])
      );
    }
  });

  it('rejects all-caps keywords: the default pattern is initial-case-or-lowercase', () => {
    expect(gl('CLOSES #4')).toEqual(new Set());
    expect(gl('FIX #4')).toEqual(new Set());
    expect(gl('IMPLEMENT #4')).toEqual(new Set());
    // The GitHub dialect stays case-insensitive — parameterization switches.
    expect(parseClosingRefs('CLOSES #4', 'github')).toEqual(new Set([4]));
    // The implement family and gerunds are GitLab-only vocabulary.
    expect(parseClosingRefs('implementing #4', 'github')).toEqual(new Set());
    expect(parseClosingRefs('closes #5', 'github')).toEqual(new Set([5]));
  });

  it('accepts an optional colon after the keyword', () => {
    expect(gl('Closes: #4')).toEqual(new Set([4]));
    expect(gl('fixed: #7')).toEqual(new Set([7]));
  });

  it('requires whitespace between keyword and reference', () => {
    expect(gl('Closes#4')).toEqual(new Set());
    expect(gl('Closes:4')).toEqual(new Set());
  });

  it('accepts an optional issue(s) word between keyword and reference', () => {
    expect(gl('Closes issue #4')).toEqual(new Set([4]));
    expect(gl('fixes issues #5 and #6')).toEqual(new Set([5, 6]));
    expect(gl('Closes issue#4')).toEqual(new Set());
  });

  it('parses local #iid references', () => {
    expect(gl('Closes #123')).toEqual(new Set([123]));
  });

  it('parses cross-project full-path references, nested group paths included', () => {
    expect(gl('Closes group/otherproject#22')).toEqual(new Set([22]));
    // Ledger row 13: nested (3+ segment) refs, anchored at docs level (#115).
    expect(gl('closes group/subgroup/project#22')).toEqual(new Set([22]));
    expect(gl('Resolves group/sub1/sub2/deep-project#31')).toEqual(new Set([31]));
  });

  it('parses full /-/issues/ URLs, nested project full paths included', () => {
    expect(gl('Resolved https://gitlab.example.com/group/otherproject/-/issues/23')).toEqual(
      new Set([23])
    );
    expect(gl('closes https://gitlab.example.com/group/sub/project/-/issues/9')).toEqual(
      new Set([9])
    );
    expect(gl('closes https://gitlab.com/gitlab-org/gitlab/-/issues/1234#note_7')).toEqual(
      new Set([1234])
    );
  });

  it('does not recognize work-item URLs, bracket refs, or external-tracker keys', () => {
    expect(gl('Closes https://gitlab.example.com/g/p/-/work_items/123')).toEqual(new Set());
    expect(gl('Closes https://gitlab.example.com/groups/g/h/-/work_items/123')).toEqual(new Set());
    expect(gl('Closes [issue:123]')).toEqual(new Set());
    expect(gl('Closes ABC-123')).toEqual(new Set());
    expect(gl('resolves GL-9')).toEqual(new Set());
  });

  it('parses comma and `and` multi-reference continuations', () => {
    expect(gl('Closes #4, #6, Related to #5')).toEqual(new Set([4, 6]));
    expect(gl('fixed #1 and #2')).toEqual(new Set([1, 2]));
    expect(gl('Fix #20, Fixes #21 and Closes group/otherproject#22.')).toEqual(
      new Set([20, 21, 22])
    );
  });

  it('matches the pinned doc example commit message verbatim', () => {
    const body = [
      'Awesome commit message',
      '',
      'Fix #20, Fixes #21 and Closes group/otherproject#22.',
      'This commit is also related to #17 and fixes #18, #19',
      'and https://gitlab.example.com/group/otherproject/-/issues/23.',
    ].join('\n');
    expect(gl(body)).toEqual(new Set([18, 19, 20, 21, 22, 23]));
  });

  it('does not treat non-closing mentions as closing refs', () => {
    expect(gl('Related to #5')).toEqual(new Set());
    expect(gl('#5 alone')).toEqual(new Set());
    expect(gl('unclosed #5')).toEqual(new Set());
    expect(gl('Closes 4')).toEqual(new Set());
    expect(gl('')).toEqual(new Set());
  });

  it('ignores closing keywords inside fenced code blocks', () => {
    const body = ['Intro.', '', '```', 'closes #5', 'implementing #6', '```', '', 'Resolves #7.'].join(
      '\n'
    );
    expect(gl(body)).toEqual(new Set([7]));
  });
});
