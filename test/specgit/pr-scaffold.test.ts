/**
 * Issue #87 — the deterministic draft-PR scaffold renderer.
 *
 * The renderer is a pure function of the bound issue numbers: the same
 * binding always yields byte-identical output. Its contract:
 *
 *  - the closing reference (`Closes #n`) for every bound issue comes
 *    first, so no later user edit (an unclosed fence) can hide them from
 *    the closing-refs parser or GitHub's auto-close;
 *  - the Why / What changed / Evidence / Checklist sections follow as
 *    advisory placeholders — they contain no closing keywords, no
 *    `#n` shapes, no HTML comments, no fenced code blocks, so the only
 *    closing references in the rendered body are exactly the bound ones;
 *  - issue numbers render in record order, deduplicated;
 *  - the body ends with exactly one trailing newline.
 */

import { describe, expect, it } from 'vitest';

import { renderPrScaffold } from '../../src/github/pr-scaffold.js';
import { parseClosingRefs } from '../../src/github/closing-refs.js';

const GOLDEN_87 = `Closes #87

## Why
Summarize the problem or need this delivery addresses.

## What changed
- Describe each meaningful change.

## Evidence
- Point at the proof: tests, checks, verification runs.

## Checklist
- [ ] Why, What changed, and Evidence are filled in.
- [ ] \`specgit finish\` exits 0.
`;

describe('renderPrScaffold (#87)', () => {
  it('renders the pinned golden body for a single bound issue', () => {
    expect(renderPrScaffold([87])).toBe(GOLDEN_87);
  });

  it('is deterministic: the same binding renders the identical body', () => {
    expect(renderPrScaffold([11, 12])).toBe(renderPrScaffold([11, 12]));
  });

  it('renders one closing line per bound issue in record order', () => {
    const body = renderPrScaffold([12, 7]);
    expect(body.startsWith('Closes #12\nCloses #7\n\n## Why\n')).toBe(true);
  });

  it('deduplicates repeated issue numbers, keeping first occurrence', () => {
    const body = renderPrScaffold([87, 11, 87]);
    expect(body.match(/^Closes #\d+$/gm)).toEqual(['Closes #87', 'Closes #11']);
  });

  it('parses back to exactly the bound set — placeholders add no closing refs', () => {
    for (const issues of [[1], [87], [11, 12], [12, 7], [87, 11, 87], [0, 2147483647]]) {
      const bound = new Set(issues);
      expect(parseClosingRefs(renderPrScaffold(issues))).toEqual(bound);
    }
  });

  it('carries no HTML comments and no fenced code blocks', () => {
    const body = renderPrScaffold([3, 5]);
    expect(body).not.toContain('<!--');
    expect(body).not.toContain('```');
    expect(body).not.toContain('~~~');
  });

  it('ends with exactly one trailing newline', () => {
    const body = renderPrScaffold([9]);
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
  });

  it('renders the sections alone when no issue is bound', () => {
    const body = renderPrScaffold([]);
    expect(body.startsWith('## Why\n')).toBe(true);
    expect(parseClosingRefs(body).size).toBe(0);
  });
});
