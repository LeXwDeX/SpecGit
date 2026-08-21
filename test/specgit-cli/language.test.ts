/**
 * #118 — language configuration: the generated-text surface and the
 * never-localized machine contract.
 *
 * The language key lives in `spec_git/policy.yaml` (`en` default, `zh`
 * supported). It selects the language of GENERATED text — issue/PR body
 * scaffolding, the init harness guidance block, and success-path human
 * prose. The machine contract is pinned NEVER localized: exit codes,
 * `--json` envelope field names, diagnostic `code` values, and the
 * closing-reference keywords (`Closes #n`) stay English/ASCII under every
 * configuration.
 *
 * Branch-slug derivation for non-ASCII titles is defined here: any
 * non-ASCII character in the clean title yields the numeric fallback
 * `issue<N>` (branch `<type>/<N>-issue<N>`), under every language
 * setting.
 */

import { describe, expect, it } from 'vitest';
import { ok } from '../../src/kernel/evidence.js';
import { parseClosingRefs } from '../../src/github/closing-refs.js';
import { renderPrScaffold } from '../../src/github/pr-scaffold.js';
import { slugifyTitle, runIssue } from '../../src/cli/commands/issue.js';
import { catalogFor } from '../../src/i18n/language.js';
import {
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  managedPromptBlock,
} from '../../src/cli/harness-assets.js';
import { runCliWith } from '../../src/cli/index.js';
import {
  makeCtx,
  makeGhProvider,
  samplePolicy,
  parseStdoutJson,
  type GhScript,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Harness: issue bootstrap with a captured gh provider (issue creation and
// draft-PR creation record their bodies) under a chosen policy language.
// ---------------------------------------------------------------------------

interface IssueHarness {
  createdIssues: Array<{ title: string; body: string }>;
  createdPrs: Array<{ head: string; base: string; title: string; body: string }>;
}

function zhCtx(
  options: {
    gh?: GhScript;
  } = {}
) {
  const harness: IssueHarness = { createdIssues: [], createdPrs: [] };
  const gh = makeGhProvider({
    createIssue: (_repo, title, body) => {
      harness.createdIssues.push({ title, body });
      return {
        ok: true,
        value: {
          number: 123,
          url: 'https://github.com/LeXwDeX/SpecGit/issues/123',
        },
      };
    },
    createDraftPr: (_repo, head, base, title, body) => {
      harness.createdPrs.push({ head, base, title, body });
      return {
        ok: true,
        value: { number: 42, url: 'https://github.com/LeXwDeX/SpecGit/pull/42' },
      };
    },
    listOpenPrsByHead: () => ok([]),
    ...(options.gh ?? {}),
  });
  const t = makeCtx({ gh, policy: samplePolicy({ language: 'zh' }) });
  return { ...t, harness };
}

/** A full fake gh provider for issue bootstraps: issue/PR creation captured, empty remote otherwise. */
function issueGh(harness: IssueHarness) {
  return makeGhProvider({
    createIssue: (_repo, title, body) => {
      harness.createdIssues.push({ title, body });
      return { ok: true, value: { number: 77, url: 'u' } };
    },
    createDraftPr: (_repo, head, base, title, body) => {
      harness.createdPrs.push({ head, base, title, body });
      return { ok: true, value: { number: 78, url: 'u' } };
    },
    listOpenPrsByHead: () => ok([]),
  });
}

describe('#118 language: branch slug for non-ASCII titles', () => {
  it('slugifyTitle yields the empty string (numeric fallback) for any non-ASCII title', () => {
    expect(slugifyTitle('添加登录功能')).toBe('');
    // Mixed titles fall back too: a partial ASCII-word slug from a
    // translated title would be garbage.
    expect(slugifyTitle('修复 login flow')).toBe('');
  });

  it('slugifyTitle keeps the three-ASCII-word behavior for ASCII titles', () => {
    expect(slugifyTitle('Add Login Flow Now')).toBe('add-login-flow');
    expect(slugifyTitle('one two three four')).toBe('one-two-three');
  });

  it('bootstraps a non-ASCII title with the numeric fallback branch (issue 118 recommendation)', async () => {
    const t = zhCtx();
    const outcome = await runIssue({ titles: ['feat: 添加登录功能'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues).toHaveLength(1);
    expect(t.harness.createdIssues[0].title).toBe('feat: 添加登录功能');
    expect(t.harness.createdPrs[0].head).toBe('feat/123-issue123');
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.delivery).toBe('issue123');
    expect(written?.context.branch).toBe('feat/123-issue123');
  });

  it('bootstraps a mixed non-ASCII title with the numeric fallback branch', async () => {
    const t = zhCtx();
    const outcome = await runIssue({ titles: ['fix: 修复 login flow'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdPrs[0].head).toBe('fix/123-issue123');
  });

  it('the numeric fallback is the defined behavior under the default (en) language too', async () => {
    const harness: IssueHarness = { createdIssues: [], createdPrs: [] };
    const t = makeCtx({ policy: 'none', gh: issueGh(harness) });
    const outcome = await runIssue({ titles: ['feat: 中文标题'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(harness.createdPrs[0].head).toBe('feat/77-issue77');
    expect(harness.createdIssues[0].body).toContain('## Why\n');
  });
});

describe('#118 language: generated scaffolding follows policy.language', () => {
  it('renders the issue body scaffold in the policy language', async () => {
    const t = zhCtx();
    await runIssue({ titles: ['feat: 添加登录功能'] }, t.ctx);
    const body = t.harness.createdIssues[0].body;
    expect(body).toContain('## 为什么\n');
    expect(body).toContain('feat: 添加登录功能');
    expect(body).toContain('## 范围\n');
    expect(body).toContain('## 验收\n');
    expect(body).toContain('`specgit finish`');
  });

  it('renders the issue body scaffold in English by default', async () => {
    const harness: IssueHarness = { createdIssues: [], createdPrs: [] };
    const t = makeCtx({ policy: 'none', gh: issueGh(harness) });
    await runIssue({ titles: ['feat: add login'] }, t.ctx);
    expect(harness.createdIssues[0].body).toContain('## Why\n');
  });

  it('renders the PR scaffold sections in the policy language', async () => {
    const t = zhCtx();
    await runIssue({ titles: ['feat: 添加登录功能'] }, t.ctx);
    const body = t.harness.createdPrs[0].body;
    expect(body.startsWith('Closes #123\n\n## 为什么\n')).toBe(true);
    expect(body).toContain('## 变更内容');
    expect(body).toContain('## 证据');
    expect(body).toContain('## 清单');
  });

  it('never localizes the closing references — they stay `Closes #n`, first, and parse back exactly', () => {
    for (const issues of [[1], [123], [11, 12], [12, 7]] as const) {
      const body = renderPrScaffold([...issues], 'zh');
      expect(body.match(/^Closes #\d+$/gm)).toEqual(issues.map((n) => `Closes #${n}`));
      expect(parseClosingRefs(body, 'github')).toEqual(new Set(issues));
      expect(parseClosingRefs(body, 'gitlab')).toEqual(new Set(issues));
    }
  });

  it('the zh PR scaffold hints add no closing references of their own', () => {
    const body = renderPrScaffold([9, 8], 'zh');
    expect(parseClosingRefs(body)).toEqual(new Set([9, 8]));
    expect(body).not.toContain('<!--');
    expect(body).not.toContain('```');
    expect(body).not.toContain('~~~');
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
  });

  it('renderPrScaffold keeps the pinned English golden body as the default', () => {
    expect(renderPrScaffold([87])).toBe(renderPrScaffold([87], 'en'));
  });

  it('the init harness guidance block renders per language with identical markers', () => {
    const en = managedPromptBlock('en');
    const zh = managedPromptBlock('zh');
    expect(en).toBe(managedPromptBlock());
    expect(zh).not.toBe(en);
    expect(zh.startsWith(BLOCK_START_MARKER)).toBe(true);
    expect(zh.endsWith(BLOCK_END_MARKER)).toBe(true);
    expect(zh).toContain('specgit issue');
    expect(zh).toContain('specgit finish');
    expect(zh).toContain('spec_git/policy.yaml');
    // The block is guidance prose, not closing grammar: it introduces no
    // closing references in either language.
    expect(parseClosingRefs(zh).size).toBe(0);
    expect(parseClosingRefs(en).size).toBe(0);
  });

  it('both languages carry the draft-to-ready fix path with verbatim commands (#163)', () => {
    const en = managedPromptBlock('en');
    const zh = managedPromptBlock('zh');
    for (const block of [en, zh]) {
      expect(block).toContain('pr_draft');
      // Command literals are machine contract: never localized.
      expect(block).toContain('gh pr ready');
      expect(block).toContain('glab mr update');
      expect(block).toContain('--ready');
    }
    // Still no closing references introduced by the guidance.
    expect(parseClosingRefs(zh).size).toBe(0);
  });
});

describe('#118 language: success-path human prose follows policy.language', () => {
  it('the issue summary renders in the policy language', async () => {
    const t = zhCtx();
    const outcome = await runIssue({ titles: ['feat: 添加登录功能'] }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(outcome.human?.[0]).toBe("已引导交付 'issue123'：");
    expect(outcome.human?.join('\n')).toContain('分支：feat/123-issue123');
    expect(outcome.human?.join('\n')).toContain('议题：#123');
  });

  it('the English summary is unchanged when no language is configured', async () => {
    const harness: IssueHarness = { createdIssues: [], createdPrs: [] };
    const t = makeCtx({ policy: 'none', gh: issueGh(harness) });
    const outcome = await runIssue({ titles: ['feat: add login'] }, t.ctx);
    expect(outcome.human?.[0]).toBe("Bootstrapped delivery 'add-login':");
  });
});

describe('#118 language: the machine contract never localizes', () => {
  interface CliRun {
    exit: number;
    envelope: Record<string, unknown>;
  }

  async function runIssueCli(language: 'en' | 'zh'): Promise<CliRun> {
    const gh = makeGhProvider({
      createIssue: () => ({
        ok: true,
        value: { number: 123, url: 'https://github.com/LeXwDeX/SpecGit/issues/123' },
      }),
      createDraftPr: () => ({
        ok: true,
        value: { number: 42, url: 'https://github.com/LeXwDeX/SpecGit/pull/42' },
      }),
      listOpenPrsByHead: () => ok([]),
    });
    const t = makeCtx({
      gh,
      policy: language === 'zh' ? samplePolicy({ language: 'zh' }) : samplePolicy(),
    });
    // Same title under both languages: the language must not leak into the
    // record — only generated text differs.
    const exit = await runCliWith(['node', 'specgit', 'issue', 'feat: add login', '--json'], t.ctx);
    return { exit, envelope: parseStdoutJson(t.io) };
  }

  it('the --json envelope keeps identical field names and record content under both languages', async () => {
    const en = await runIssueCli('en');
    const zh = await runIssueCli('zh');
    expect(zh.exit).toBe(en.exit);
    expect(Object.keys(zh.envelope).sort()).toEqual(Object.keys(en.envelope).sort());
    expect(zh.envelope.status).toBe('ok');
    expect(zh.envelope.record).toEqual(en.envelope.record);
    expect(zh.envelope.record).toMatchObject({ delivery: 'add-login' });
    // zh changes the language of generated text (stderr human channel),
    // never the envelope shape or the record.
  });

  it('stdout is exactly one JSON document under zh (single parse surface)', async () => {
    const zh = await runIssueCli('zh');
    expect(zh.exit).toBe(0);
  });

  it('usage errors keep the same exit code, ASCII diagnostic code, and message under both languages', async () => {
    const runs: Array<Record<string, any>> = [];
    for (const language of ['en', 'zh'] as const) {
      const t = makeCtx({
        policy: language === 'zh' ? samplePolicy({ language: 'zh' }) : samplePolicy(),
      });
      const exit = await runCliWith(['node', 'specgit', 'issue', 'bogus title', '--json'], t.ctx);
      const envelope = parseStdoutJson(t.io);
      runs.push({ language, exit, envelope });
    }
    const [en, zh] = runs;
    expect(zh.exit).toBe(en.exit);
    expect(zh.exit).toBe(2);
    expect(zh.envelope.errors[0].code).toBe(en.envelope.errors[0].code);
    expect(zh.envelope.errors[0].code).toBe('issue_type_invalid');
    expect(zh.envelope.errors[0].message).toBe(en.envelope.errors[0].message);
    for (const run of runs) {
      expect(run.envelope.errors[0].code).toMatch(/^[\x20-\x7E]+$/);
      expect(run.envelope.errors[0].message).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('scaffolded issue headings carry no parenthesized required/optional markers, in every locale (#155)', () => {
    // The markers are authoring meta-information with no machine semantics;
    // kept in headings they leak verbatim into created issues (observed on
    // #152) and get copied downstream by LLM authors. Pin: every scaffold
    // heading, in every catalog, is marker-free.
    for (const language of ['en', 'zh'] as const) {
      const { scaffold } = catalogFor(language);
      const headings = [
        scaffold.issueWhy,
        scaffold.issueScope,
        scaffold.issueAcceptance,
      ];
      for (const heading of headings) {
        expect(heading, `${language}: ${heading}`).toMatch(/^## [^(（]+$/);
      }
    }
  });

  it('provider-failure diagnostics keep the same ASCII code and message under both languages', async () => {
    const runs: Array<Record<string, any>> = [];
    for (const language of ['en', 'zh'] as const) {
      const t = makeCtx({
        policy: language === 'zh' ? samplePolicy({ language: 'zh' }) : samplePolicy(),
      });
      const exit = await runCliWith(['node', 'specgit', 'issue', 'feat: x', '--json'], t.ctx);
      const envelope = parseStdoutJson(t.io);
      runs.push({ language, exit, envelope });
    }
    const [en, zh] = runs;
    expect(en.exit).toBe(3);
    expect(zh.exit).toBe(en.exit);
    expect(zh.envelope.errors[0].code).toBe(en.envelope.errors[0].code);
    expect(zh.envelope.errors[0].message).toBe(en.envelope.errors[0].message);
    expect(zh.envelope.errors[0].code).toMatch(/^[\x20-\x7E]+$/);
  });
});

