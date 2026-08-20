/**
 * Deterministic draft-PR scaffold (#87), language-aware (#118).
 *
 * A pure function of the bound issue numbers and the policy language: the
 * same inputs always render the identical body. `specgit issue` writes
 * this body exactly once, at draft creation — no SpecGit command edits an
 * existing PR body afterwards, so user edits (and bodies of PRs adopted
 * by repair) are never overwritten. The renderer reads no repository
 * files: the adopting repository keeps full ownership of its own
 * pull-request templates.
 *
 * Shape (pinned by test/specgit/pr-scaffold.test.ts and
 * test/specgit-cli/language.test.ts):
 *
 *  - the `Closes #n` line for every bound issue comes first — before any
 *    scaffold section — so a later user edit (an unclosed code fence)
 *    can never hide the closing references from the closing-refs parser
 *    or from GitHub's merge-time auto-close. The closing keywords are
 *    provider grammar and are NEVER localized;
 *  - the Why / What changed / Evidence / Checklist sections are advisory
 *    placeholders in the policy language: they contain no closing
 *    keywords, no `#n` shapes, no HTML comments, and no fenced code
 *    blocks, so the only closing references in a rendered body are
 *    exactly the bound issues (`parseClosingRefs(render(n)) === Set(n)`).
 */

import type { PolicyLanguage } from '../record/policy.js';
import { catalogFor } from '../i18n/language.js';

export function renderPrScaffold(issues: number[], language: PolicyLanguage = 'en'): string {
  const { scaffold } = catalogFor(language);
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
    scaffold.prWhy,
    scaffold.prWhyHint,
    '',
    scaffold.prWhat,
    scaffold.prWhatHint,
    '',
    scaffold.prEvidence,
    scaffold.prEvidenceHint,
    '',
    scaffold.prChecklist,
    scaffold.prChecklistFilled,
    scaffold.prChecklistFinish,
    '',
  ].join('\n');
}
