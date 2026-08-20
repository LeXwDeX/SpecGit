/**
 * Deterministic draft-PR scaffold (#87).
 *
 * A pure function of the bound issue numbers: the same binding always
 * renders the identical body. `specgit issue` writes this body exactly
 * once, at draft creation — no SpecGit command edits an existing PR
 * body afterwards, so user edits (and bodies of PRs adopted by repair)
 * are never overwritten. The renderer reads no repository files: the
 * adopting repository keeps full ownership of its own pull-request
 * templates.
 *
 * Shape (pinned by test/specgit/pr-scaffold.test.ts):
 *
 *  - the `Closes #n` line for every bound issue comes first — before any
 *    scaffold section — so a later user edit (an unclosed code fence)
 *    can never hide the closing references from the closing-refs parser
 *    or from GitHub's merge-time auto-close;
 *  - the Why / What changed / Evidence / Checklist sections are advisory
 *    placeholders: they contain no closing keywords, no `#n` shapes, no
 *    HTML comments, and no fenced code blocks, so the only closing
 *    references in a rendered body are exactly the bound issues
 *    (`parseClosingRefs(render(n)) === Set(n)`).
 */

export function renderPrScaffold(issues: number[]): string {
  const seen = new Set<number>();
  const refs: string[] = [];
  for (const n of issues) {
    if (!seen.has(n)) {
      seen.add(n);
      refs.push(`Closes #${n}`);
    }
  }
  return [
    ...refs,
    ...(refs.length > 0 ? [''] : []),
    '## Why',
    'Summarize the problem or need this delivery addresses.',
    '',
    '## What changed',
    '- Describe each meaningful change.',
    '',
    '## Evidence',
    '- Point at the proof: tests, checks, verification runs.',
    '',
    '## Checklist',
    '- [ ] Why, What changed, and Evidence are filled in.',
    '- [ ] `specgit finish` exits 0.',
    '',
  ].join('\n');
}
