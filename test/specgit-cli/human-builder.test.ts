/**
 * #190 — the shared human rendering builder.
 *
 * Every command composes its `CommandOutcome.human` lines through
 * `humanBuilder` and the shared line formatters instead of bespoke string
 * assembly. The byte shape of every formatter is the one the existing CLI
 * suites already pin on the wire: these tests lock the builder itself so a
 * future format drift fails here, not across a dozen command suites.
 *
 * Localization is pass-through: the builder never rewrites catalog text —
 * what `catalogFor(language)` produces reaches the terminal unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  bulletItem,
  detailLine,
  errorLine,
  gateFailureLine,
  humanBuilder,
  issueList,
  probeLine,
  verdictFailureLine,
  warningLine,
} from '../../src/cli/output.js';
import { catalogFor } from '../../src/i18n/language.js';

describe('humanBuilder (#190)', () => {
  it('builds an empty list from an empty builder', () => {
    expect(humanBuilder().build()).toEqual([]);
  });

  it('accepts pre-rendered seed lines', () => {
    expect(humanBuilder(['first', 'second']).build()).toEqual(['first', 'second']);
  });

  it('preserves composition order across every entry shape', () => {
    const lines = humanBuilder()
      .line('headline')
      .detail('context detail')
      .bullet('installed path')
      .append(['appended a', 'appended b'])
      .line('tail')
      .build();
    expect(lines).toEqual([
      'headline',
      '  context detail',
      '  - installed path',
      'appended a',
      'appended b',
      'tail',
    ]);
  });

  it('treats empty inputs as no-ops', () => {
    const lines = humanBuilder()
      .append([])
      .line('only')
      .build();
    expect(lines).toEqual(['only']);
  });

  it('keeps multi-line entries intact (one array element per entry)', () => {
    // The pr_ambiguous listing renders its candidates as one element whose
    // embedded newline survives emission verbatim.
    const listing = '  #1 one\n  #2 two';
    expect(humanBuilder().line(listing).build()).toEqual([listing]);
  });

  it('is immutable per build: later appends do not leak into earlier builds', () => {
    const builder = humanBuilder().line('one');
    const first = builder.build();
    builder.line('two');
    expect(first).toEqual(['one']);
    expect(builder.build()).toEqual(['one', 'two']);
  });
});

describe('shared line formatters (#190)', () => {
  it('detailLine indents with two spaces', () => {
    expect(detailLine('branch main')).toBe('  branch main');
  });

  it('bulletItem renders a two-space indented dash item', () => {
    expect(bulletItem('.opencode/command/specgit-issue.md')).toBe(
      '  - .opencode/command/specgit-issue.md'
    );
  });

  it('errorLine sanitizes the message', () => {
    expect(errorLine('boom')).toBe('Error: boom');
    expect(errorLine('bad\u0007char')).toBe('Error: badchar');
  });

  it('warningLine keeps the message verbatim (no sanitizing rewrite)', () => {
    expect(warningLine('no origin remote — cannot probe branch protection.')).toBe(
      'Warning: no origin remote — cannot probe branch protection.'
    );
  });

  it('probeLine renders ok and failing probes in their locked shapes', () => {
    expect(probeLine({ name: 'git', ok: true, detail: '2.45.0' })).toBe('ok    git — 2.45.0');
    expect(probeLine({ name: 'gh_present', ok: true })).toBe('ok    gh_present');
    expect(probeLine({ name: 'repo', ok: false, code: 'no_repo' })).toBe('FAIL  repo (no_repo)');
    expect(probeLine({ name: 'repo', ok: false })).toBe('FAIL  repo');
  });

  it('gateFailureLine renders the status-surface gate failure', () => {
    expect(gateFailureLine('record', 'record_invalid')).toBe('Gate record: record_invalid');
    expect(gateFailureLine('origin', 'origin_unresolved', 'Add an origin remote.')).toBe(
      'Gate origin: origin_unresolved — Add an origin remote.'
    );
  });

  it('verdictFailureLine renders the accept-surface gate failure', () => {
    expect(verdictFailureLine('pr_checks', 'pr_draft')).toBe('  pr_checks: pr_draft');
    expect(verdictFailureLine('pr_checks', 'checks_pending', 'Wait for CI.')).toBe(
      '  pr_checks: checks_pending — Wait for CI.'
    );
  });

  it('issueList joins issue numbers as closing-ref style references', () => {
    expect(issueList([190])).toBe('#190');
    expect(issueList([189, 190])).toBe('#189, #190');
    expect(issueList([])).toBe('');
  });
});

describe('localization pass-through (#190)', () => {
  it('renders catalog text byte-identical under every language', () => {
    for (const language of ['en', 'zh'] as const) {
      const { human } = catalogFor(language);
      const removed = human.unbindRemoved('.specgit.yaml');
      const lines = humanBuilder().line(removed).build();
      expect(lines).toEqual([removed]);
      expect(lines[0]).toBe(human.unbindRemoved('.specgit.yaml'));
    }
  });

  it('never rewrites indented catalog lines beyond their indent', () => {
    for (const language of ['en', 'zh'] as const) {
      const { human } = catalogFor(language);
      const context = human.bindContextBranch('feat/190-issue190');
      expect(humanBuilder().detail(context).build()).toEqual([`  ${context}`]);
    }
  });
});
