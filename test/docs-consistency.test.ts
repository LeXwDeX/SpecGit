import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODE_INFO } from '../src/acceptance/codes.js';
import { validateIssueTitles } from '../src/cli/commands/issue.js';

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

  it('release-gates.md carries the current CI dispositions and retires the old event gate', () => {
    const text = read('docs', 'release-gates.md');

    expect(text).toMatch(/Known CI dispositions/i);
    // Every standing disposition outside a delivery PR's own gates: the
    // self-hosted leg (#105), the auto-merge arm-off (#107), the GHAS
    // dynamic-workflow exemption (#109), and the replacement for the
    // historical Validate Release Tracking event gate (#110).
    for (const issue of ['#105', '#107', '#109', '#110']) {
      expect(text, `dispositions table must track ${issue}`).toContain(issue);
    }
    expect(text).toMatch(/complete-diff classification and release intent/i);
    expect(text).toMatch(/supersedes the historical `Validate Release Tracking`/i);
    expect(text).toMatch(/old job is no longer a live check/i);
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

  it('docs/gitlab-support.md carries the version-window rebaseline SOP (#181)', () => {
    const text = read('docs', 'gitlab-support.md');

    // The SOP section exists and names the procedure.
    expect(text).toMatch(/## Rebaseline SOP/);

    // Which constants change in a rebaseline delivery.
    expect(text).toContain('VERSION_WINDOW_MIN');
    expect(text).toContain('VERSION_WINDOW_MAX_EXCLUSIVE');

    // Triggers: new releases and the advisory unverified-version warning.
    expect(text).toMatch(/gitlab_version_unverified/);

    // Which dogfood evidence must be recaptured — the SOP names the
    // evidence artifacts under docs/evidence/ it produces.
    expect(text).toMatch(/docs\/evidence\//);
    expect(text).toMatch(/ledger/i);

    // Which tests must pass: the regression matrix names the port contract
    // and the offline GitLab delivery e2e.
    expect(text).toContain('provider-port-contract.test.ts');
    expect(text).toContain('gitlab-delivery.e2e.test.ts');
  });

  it('the rebaseline SOP does not itself move the window or the glab floor (#181)', () => {
    const src = read('src', 'providers', 'gitlab', 'glab-cli.ts');
    expect(src).toContain('VERSION_WINDOW_MIN = [19, 2, 4]');
    expect(src).toContain('VERSION_WINDOW_MAX_EXCLUSIVE = [19, 4, 0]');

    const docs = read('docs', 'gitlab-support.md');
    expect(docs).toMatch(/>= 19\.2\.4 < 19\.4\.0/);
    expect(docs).toMatch(/glab floor.*1\.113\.0/i);
  });

  it('the PR template carries no literal issue number that could auto-close a real issue', () => {
    const template = read('.github', 'PULL_REQUEST_TEMPLATE.md');
    expect(template).not.toMatch(/#[0-9]+\b/);
    expect(template).toContain('Closes #<issue-number>');
  });
});

describe('docs consistency (issue templates obey this repository policy)', () => {
  it.each([
    ['bug_report.md', 'fix', 'kind::fix'],
    ['feature_request.md', 'feat', 'kind::feat'],
  ])('%s uses an English typed title and exactly one kind label', (file, type, label) => {
    const template = read('.github', 'ISSUE_TEMPLATE', file);
    const frontmatter = template.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(frontmatter).toContain(`title: '${type}: <english title>'`);
    expect(frontmatter).toContain(`labels: ${label}`);
    expect(frontmatter.match(/^labels:/gm)).toHaveLength(1);
    expect(frontmatter).not.toMatch(/^labels:\s*(bug|enhancement)\s*$/m);
  });

  it('the template contract stays aligned with the checked-in kind-mode policy', () => {
    const policy = read('spec_git', 'policy.yaml');
    expect(policy).toMatch(/language:\s*en/);
    expect(policy).toMatch(/labels:\s*kind/);
  });
});

describe('docs consistency (upgrades refresh generated assets)', () => {
  const LIFECYCLE_PAGES = [
    'README.md',
    'docs/actions.md',
    'docs/cli.md',
    'docs/concepts.md',
    'docs/existing-projects.md',
    'docs/glossary.md',
    'docs/providers.md',
    'docs/troubleshooting.md',
  ] as const;

  it.each(LIFECYCLE_PAGES)('%s does not present init/setup as a one-time action', (page) => {
    const text = read(page);
    expect(text).not.toMatch(/init\s*\/\s*setup\s+once per repository/i);
    expect(text).toMatch(/after (?:CLI )?upgrades/i);
  });

  it('the installation guide carries the complete published-CLI refresh sequence', () => {
    const text = read('docs', 'installation.md');
    for (const step of [
      'npm install -g specgit@latest',
      'specgit status',
      'specgit init --force',
      'specgit setup --tool all',
      'specgit doctor',
    ]) {
      expect(text, `upgrade guide must include ${step}`).toContain(step);
    }
  });

  it('CLI examples describe their version as runtime supplied instead of pinning an old package', () => {
    const text = read('docs', 'cli.md');
    expect(text).not.toContain('"version": "1.1.0"');
    expect(text).toMatch(/runtime[- ]supplied version/i);
  });
});

// #312 — one wording everywhere: `required_checks` is an array of non-empty
// strings and the array itself may be empty (the no-CI policy, #63). Canonical
// pages that claimed the list must be non-empty pushed users toward invented
// check names that never report and permanently trigger `checks_missing`.
describe('docs consistency (empty required_checks is the no-CI policy, #312)', () => {
  const CANONICAL_PAGES = [
    'customization.md',
    'team-workflow.md',
    'concepts.md',
    'troubleshooting.md',
  ] as const;

  // The retired claims, each anchored to the phrasing the stale pages used.
  const RETIRED_CLAIMS: Array<[string, RegExp]> = [
    ['an empty list is invalid', /empty list is invalid/i],
    ['the non-empty list', /non-empty list/i],
    ['fails closed on an empty list', /fails? closed on an empty list/i],
    ['the list must be non-empty', /must be non-empty/i],
  ];

  it.each(CANONICAL_PAGES)('docs/%s states the empty/no-CI semantics, not the retired wording', (page) => {
    const text = read('docs', page);
    for (const [claim, pattern] of RETIRED_CLAIMS) {
      expect(text, `docs/${page} must not claim ${claim}`).not.toMatch(pattern);
    }
    expect(text, `docs/${page} must name the no-CI policy`).toMatch(/no-CI policy/);
  });

  it('the schema remains the source of truth: the empty list is the no-CI policy', () => {
    expect(read('schemas', 'specgit', 'schema.yaml')).toMatch(
      /An empty list is the no-CI policy/
    );
  });

  it('policy_invalid stays generic: no non-empty-list demand, a truthful repair path', () => {
    const fix = CODE_INFO.policy_invalid.fix ?? '';
    // policy_invalid covers malformed YAML, unknown keys, wrong types, and
    // empty names — the fix must not falsely require a non-empty list.
    expect(fix, 'the fix must not demand at least one check').not.toMatch(/at least one/i);
    expect(fix, 'the fix must not require a non-empty list').not.toMatch(/non-empty list/i);
    expect(fix, 'the fix must name the real name rule').toMatch(/non-empty string/);
    expect(fix, 'the fix must keep the empty list truthful').toMatch(/no-CI policy/);
  });
});

// #353 — documentation examples are executable CLI contracts: every
// concrete `specgit issue "title" ...` example in the shipped docs must
// pass the production title validator. The Quick Start's copy-paste
// command is the one users run first; an example that exits 2 is a
// contract break, not a typo. Placeholder invocations (`"..."`,
// `"<type>: <title>"`) are templates, not examples — they are skipped.
describe('docs consistency (specgit issue examples pass the production validator, #353)', () => {
  const DOC_PAGES: string[] = [
    'README.md',
    'CONTRIBUTING.md',
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'docs'), { recursive: true })
      .filter((f) => String(f).endsWith('.md'))
      .map((f) => path.join('docs', String(f))),
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'workflows'))
      .filter((f) => String(f).endsWith('.md'))
      .map((f) => path.join('workflows', String(f))),
  ];

  /**
   * Lines that carry `specgit issue` invocations in CODE context only —
   * fenced code blocks and inline backtick spans. Prose quoting an
   * example in double quotes (agent-contract's parentheticals) is not an
   * executable example and must not be validated.
   */
  function issueExampleLines(markdown: string): string[] {
    const lines: string[] = [];
    let inFence = false;
    for (const line of markdown.split('\n')) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        lines.push(line);
      } else {
        for (const span of line.matchAll(/`([^`]+)`/g)) {
          lines.push(span[1]);
        }
      }
    }
    return lines.filter((l) => /specgit issue /.test(l));
  }

  /** Concrete quoted titles of one `specgit issue ...` line, placeholders excluded. */
  function concreteTitles(line: string): string[] {
    const stripped = line.replace(/\s+#.*$/, '');
    const quoted = [...stripped.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
    return quoted.filter(
      (title) =>
        title.trim() !== '' &&
        title !== '...' &&
        title !== '…' &&
        !title.includes('<') &&
        !title.includes('>')
    );
  }

  it('the doc set under test carries at least one concrete specgit issue example', () => {
    const count = DOC_PAGES.flatMap((page) =>
      issueExampleLines(read(page)).flatMap((line) => concreteTitles(line))
    );
    expect(count.length).toBeGreaterThan(0);
  });

  it.each(DOC_PAGES)('%s: every concrete example passes validateIssueTitles', (page) => {
    for (const line of issueExampleLines(read(page))) {
      const titles = concreteTitles(line);
      if (titles.length === 0) continue;
      const first = validateIssueTitles(titles);
      expect(
        first,
        `${page}: the example '${line.trim()}' must be executable — ${first?.message ?? ''}`
      ).toBeNull();
    }
  });
});

// #368/#369/#370 — the documented environment contract is five variables
// (four CLI, one hook-only), the schema guide represents every
// parser-supported authoritative field, and the provider diagnostic-code
// tables match the runtime adapters. Anchored to the pages this delivery
// owns; the parsers (src/record/{policy,schema,providers}.ts and the
// CODE_INFO registry) are the runtime evidence.
describe('docs consistency (env contract, schema guide, provider codes)', () => {
  const FIVE_ENV_VARS = [
    'SPECGIT_GH',
    'SPECGIT_GH_TIMEOUT_MS',
    'SPECGIT_GLAB',
    'SPECGIT_GLAB_TIMEOUT_MS',
    'SPECGIT_GUARD_BUDGET_S',
  ] as const;

  it('docs/cli.md documents all five environment variables, distinguishing CLI variables from the hook-only guard budget', () => {
    const text = read('docs', 'cli.md');
    for (const variable of FIVE_ENV_VARS) {
      expect(text, `docs/cli.md must document ${variable}`).toContain(variable);
    }
    expect(text, 'the guard budget must be scoped to the merge-guard hook').toMatch(
      /merge[- ]guard hook/i
    );
  });

  it('docs/agent-contract.md names the five-variable environment contract', () => {
    const text = read('docs', 'agent-contract.md');
    for (const variable of FIVE_ENV_VARS) {
      expect(text, `agent-contract.md must name ${variable}`).toContain(variable);
    }
  });

  it('README names the guard budget, the glab merge guard, and the actual setup destinations', () => {
    const text = read('README.md');
    expect(text).toContain('SPECGIT_GUARD_BUDGET_S');
    expect(text).toMatch(/glab mr merge/);
    expect(text).toContain('.agents/skills');
  });

  it('the schema guide carries every parser-supported authoritative field and provider code', () => {
    const text = read('schemas', 'specgit', 'schema.yaml');
    // Record: bootstrap-written per-issue kinds (#338).
    expect(text).toMatch(/issueKinds/);
    // Policy: the presentation language (#118) and the declared tag pool (#330).
    expect(text).toMatch(/\blanguage\b/);
    expect(text).toMatch(/tags:/);
    // The providers.yaml declaration schema.
    expect(text).toMatch(/gitlab:/);
    expect(text).toContain('providers.yaml');
    // Provider diagnostic codes match the runtime adapters and the PR gate.
    for (const code of ['glab_missing', 'glab_unauthenticated', 'glab_transport', 'pr_draft']) {
      expect(text, `schema gate table must carry ${code}`).toContain(code);
    }
  });

  it('the policy template documents the optional language and tags keys', () => {
    const template = read('schemas', 'specgit', 'templates', 'specgit-policy.yaml');
    expect(template).toMatch(/language/);
    expect(template).toMatch(/tags:/);
  });
});
