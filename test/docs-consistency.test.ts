import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Docs-consistency pins for the 1.0.0 convergence docs (#108). The release
// gates, the dual-platform scope narrative, and the PR template are contract
// surfaces: a regression here is a contract break, not a typo.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf-8');

describe('docs consistency (release gates, scope narrative, PR template)', () => {
  it('docs/release-gates.md carries the invariant core, red-line blockers, GA gates, and gate-7 protocol', () => {
    const text = read('docs', 'release-gates.md');

    // Invariant core, both I3 branches named.
    for (const inv of ['I0', 'I1', 'I2', 'I3a', 'I3b', 'I4', 'I5']) {
      expect(text, `invariant core must name ${inv}`).toContain(inv);
    }
    expect(text).toMatch(/fail[- ]closed/i);
    expect(text).toMatch(/the record is a claim, never truth/i);

    // Red-line closure checklist: the four 1.0 blockers with evidence slots.
    for (const blocker of ['#119', '#120', '#121', '#122']) {
      expect(text, `red-line checklist must track ${blocker}`).toContain(blocker);
    }

    // GA five gates are the only authoritative completion vocabulary.
    expect(text).toMatch(/issue tracker empty/i);
    expect(text).toMatch(/zero review residue/i);
    expect(text).toMatch(/no undisposed red/i);
    expect(text).toMatch(/nested-group GitLab/i);
    expect(text).toMatch(/archived evidence/i);
    expect(text).toMatch(/G-FINAL/i);
    expect(text).toMatch(/supersedes/i);

    // Gate-7 protocol: workflow_dispatch acceptance run on the release tag.
    expect(text).toMatch(/workflow_dispatch/);
    expect(text).toMatch(/release tag/i);

    // Growth discipline.
    expect(text).toMatch(/accept-or-defer/i);
  });

  it('release-gates.md carries the known CI dispositions (gate 3 record)', () => {
    const text = read('docs', 'release-gates.md');

    expect(text).toMatch(/Known CI dispositions/i);
    // Every standing disposition outside a delivery PR's own gates: the
    // self-hosted leg (#105), the auto-merge arm-off (#107), the GHAS
    // dynamic-workflow exemption (#109), and the Validate Release Tracking
    // event gate (#110).
    for (const issue of ['#105', '#107', '#109', '#110']) {
      expect(text, `dispositions table must track ${issue}`).toContain(issue);
    }
    // VRT's skip-by-design is an event gate, and the predicate names where
    // its green is read.
    expect(text).toMatch(/event-gated/i);
    expect(text).toMatch(/merge_group/);
  });

  it('README links the release gates', () => {
    expect(read('README.md')).toMatch(/\]\(docs\/release-gates\.md\)/);
  });

  it('the committed v1 scope narrative is dual-platform with the glab provider shipped, not GitHub-only', () => {
    for (const doc of ['AGENTS.md', path.join('docs', 'baseline-v1.md')] as const) {
      const text = read(doc);
      expect(text, `${doc} must not claim GitHub-only v1`).not.toMatch(/GitHub\.com only/i);
      expect(text, `${doc} must carry the dual-platform scope`).toMatch(/dual-platform/i);
      expect(text, `${doc} must route GitLab evidence through glab`).toMatch(/glab/);
      expect(text, `${doc} must not claim the GitLab provider has not landed`).not.toMatch(
        /until the Phase-2 provider lands/i
      );
    }
  });

  it('the PR template carries no literal issue number that could auto-close a real issue', () => {
    const template = read('.github', 'PULL_REQUEST_TEMPLATE.md');
    expect(template).not.toMatch(/#[0-9]+\b/);
    expect(template).toContain('Closes #<issue-number>');
  });
});
