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
 * non-ASCII character in the clean title yields no slug (#118), and the
 * naming gap is surfaced, never papered over (#246): an interactive
 * session is asked for a kebab-case delivery name, a scripted one gets
 * a usage error naming `--delivery <slug>` — under every language
 * setting, never a silent `issue<N>`.
 */

import { describe, expect, it } from 'vitest';
import { ok } from '../../src/kernel/evidence.js';
import { parseClosingRefs } from '../../src/github/closing-refs.js';
import { renderPrScaffold } from '../../src/github/pr-scaffold.js';
import { slugifyTitle, runIssue, resolveDeliveryName } from '../../src/cli/commands/issue.js';
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

describe('#118/#246 language: branch naming for non-ASCII titles', () => {
  it('slugifyTitle yields the empty string (a naming gap) for any non-ASCII title', () => {
    expect(slugifyTitle('添加登录功能')).toBe('');
    // Mixed titles yield no slug either: a partial ASCII-word slug from a
    // translated title would be garbage.
    expect(slugifyTitle('修复 login flow')).toBe('');
  });

  it('slugifyTitle keeps the three-ASCII-word behavior for ASCII titles', () => {
    expect(slugifyTitle('Add Login Flow Now')).toBe('add-login-flow');
    expect(slugifyTitle('one two three four')).toBe('one-two-three');
  });

  it('bootstraps a non-ASCII title with an explicit delivery name (#246)', async () => {
    const t = zhCtx();
    const outcome = await runIssue(
      { titles: ['feat: 添加登录功能'], delivery: 'add-login' },
      t.ctx
    );
    expect(outcome.exit).toBe(0);
    expect(t.harness.createdIssues).toHaveLength(1);
    expect(t.harness.createdIssues[0].title).toBe('feat: 添加登录功能');
    expect(t.harness.createdPrs[0].head).toBe('feat/123-add-login');
    const written = t.recordPort.recordWrites.at(-1)?.record;
    expect(written?.delivery).toBe('add-login');
    expect(written?.context.branch).toBe('feat/123-add-login');
  });

  it('refuses a non-ASCII title without a name in a scripted session (#246)', async () => {
    const t = zhCtx();
    const outcome = await runIssue({ titles: ['feat: 添加登录功能'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_delivery_name_required');
    expect(outcome.errors?.[0]?.fix).toContain('--delivery');
    // Zero side effects: no issue created before the name exists.
    expect(t.harness.createdIssues).toHaveLength(0);
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('a mixed non-ASCII title hits the same naming gap (#246)', async () => {
    const t = zhCtx();
    const outcome = await runIssue({ titles: ['fix: 修复 login flow'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_delivery_name_required');
  });

  it('the naming gap is refused under the default (en) language too, with ASCII scaffolding untouched', async () => {
    const harness: IssueHarness = { createdIssues: [], createdPrs: [] };
    const t = makeCtx({ policy: 'none', gh: issueGh(harness) });
    const outcome = await runIssue({ titles: ['feat: 中文标题'] }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('issue_delivery_name_required');
    // With the explicit name, the English scaffold still renders.
    const healed = makeCtx({ policy: 'none', gh: issueGh(harness) });
    const named = await runIssue(
      { titles: ['feat: 中文标题'], delivery: 'zh-title' },
      healed.ctx
    );
    expect(named.exit).toBe(0);
    expect(harness.createdPrs.at(-1)?.head).toBe('feat/77-zh-title');
    expect(harness.createdIssues.at(-1)?.body).toContain('## Why\n');
  });
});

describe('#246 delivery-name resolution precedence and prompt loop', () => {
  const neverPrompt = async () => {
    throw new Error('test: the prompt must not be reached');
  };

  it('an explicit override wins over the derived slug and never prompts', async () => {
    const resolved = await resolveDeliveryName({
      cleanTitle: 'add login',
      override: 'auth-flow',
      interactive: true,
      prompt: neverPrompt,
      promptText: 'p',
      retryText: 'r',
    });
    expect('name' in resolved && resolved.name).toBe('auth-flow');
  });

  it('a valid ASCII slug resolves without prompting', async () => {
    const resolved = await resolveDeliveryName({
      cleanTitle: 'Add Login Flow Now',
      interactive: false,
      prompt: neverPrompt,
      promptText: 'p',
      retryText: 'r',
    });
    expect('name' in resolved && resolved.name).toBe('add-login-flow');
  });

  it('an interactive session is asked, and the first valid answer wins', async () => {
    const prompts: string[] = [];
    const answers = ['Not Valid', 'still bad', 'good-name', 'never-reached'];
    const resolved = await resolveDeliveryName({
      cleanTitle: '添加登录功能',
      interactive: true,
      prompt: async (message) => {
        prompts.push(message);
        return answers.shift() ?? null;
      },
      promptText: 'first?',
      retryText: 'retry?',
    });
    expect('name' in resolved && resolved.name).toBe('good-name');
    expect(prompts).toEqual(['first?', 'retry?', 'retry?']);
  });

  it('EOF on the prompt is a refusal, and attempts are bounded', async () => {
    let asked = 0;
    const resolved = await resolveDeliveryName({
      cleanTitle: '添加登录功能',
      interactive: true,
      prompt: async () => {
        asked += 1;
        return asked === 1 ? 'BAD ANSWER' : null;
      },
      promptText: 'p',
      retryText: 'r',
    });
    expect('exit' in resolved && resolved.exit).toBe(2);
    expect('exit' in resolved && resolved.errors?.[0]?.code).toBe('issue_delivery_name_required');
    expect(asked).toBe(2);
  });

  it('three invalid answers exhaust the attempts and fail closed', async () => {
    let asked = 0;
    const resolved = await resolveDeliveryName({
      cleanTitle: '',
      interactive: true,
      prompt: async () => {
        asked += 1;
        return 'NOPE';
      },
      promptText: 'p',
      retryText: 'r',
    });
    expect('exit' in resolved && resolved.exit).toBe(2);
    expect(asked).toBe(3);
  });

  it('a resume keeps the recorded name and never asks again', async () => {
    // Seed a record whose name was prompted in a previous session: the
    // title yields no slug, yet resume must not ask again.
    const seeded = makeCtx({
      gh: makeGhProvider({
        getPr: () =>
          ok({
            number: 42,
            state: 'open' as const,
            headBranch: 'feat/123-prompted-name',
            headSha: 'a'.repeat(40),
            baseBranch: 'main',
            body: 'Closes #123\n',
            mergeCommitSha: null,
            draft: false,
          }),
        listOpenPrsByHead: () => ok([]),
      }),
      policy: samplePolicy({ language: 'zh' }),
      record: {
        version: 1,
        delivery: 'prompted-name',
        context: { kind: 'branch', branch: 'feat/123-prompted-name' },
        issues: [123],
        pr: 42,
      },
    });
    const outcome = await runIssue({ titles: [] }, seeded.ctx);
    expect(outcome.exit).toBe(0);
    // The recorded name survives resume untouched — no prompt, no rename.
    expect(outcome.record?.delivery).toBe('prompted-name');
  });
});

describe('#118 language: generated scaffolding follows policy.language', () => {
  it('renders the issue body scaffold in the policy language', async () => {
    const t = zhCtx();
    await runIssue({ titles: ['feat: 添加登录功能'], delivery: 'add-login' }, t.ctx);
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
    await runIssue({ titles: ['feat: 添加登录功能'], delivery: 'add-login' }, t.ctx);
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

  it('both languages carry the agent-contract essentials with verbatim machine literals (#176)', () => {
    const en = managedPromptBlock('en');
    const zh = managedPromptBlock('zh');
    // Each language renders its own essentials section.
    expect(en).toContain('### Agent contract essentials');
    expect(zh).toContain('### 代理契约要点');
    for (const block of [en, zh]) {
      // The one rule names the verdict as the only completion signal.
      expect(block).toContain('specgit finish');
      // Exit-code semantics route exit 3 to the environment repair loop.
      expect(block).toContain('specgit doctor');
      // Command and closing-ref literals are machine contract: never
      // localized.
      expect(block).toContain('Closes #n');
      expect(block).toContain('gh');
      expect(block).toContain('glab');
      expect(block).toContain('spec_git/policy.yaml');
    }
    // The essentials are prose, not closing grammar, in either language.
    expect(parseClosingRefs(zh).size).toBe(0);
    expect(parseClosingRefs(en).size).toBe(0);
  });

  it('the zh block names the never-localized diagnostic surface, the en block stays byte-stable (#183)', () => {
    const zh = managedPromptBlock('zh');
    const en = managedPromptBlock('en');
    // The zh note names the machine-contract surface: diagnostics, codes,
    // and fix strings remain English under every configuration.
    expect(zh).toContain('诊断信息');
    expect(zh).toContain('机器契约');
    // Act on the machine literals, never on language consistency.
    expect(zh).toContain('`code`');
    expect(zh).toContain('`fix`');
    // The en block carries no counterpart: issue #183 scopes the note to
    // zh, and the en text is the pre-#118 byte-stable pin.
    expect(en).not.toContain('诊断信息');
    // The note introduces no closing references.
    expect(parseClosingRefs(zh).size).toBe(0);
    expect(parseClosingRefs(en).size).toBe(0);
  });
});

describe('#118 language: success-path human prose follows policy.language', () => {
  it('the issue summary renders in the policy language', async () => {
    const t = zhCtx();
    const outcome = await runIssue(
      { titles: ['feat: 添加登录功能'], delivery: 'add-login' },
      t.ctx
    );
    expect(outcome.exit).toBe(0);
    expect(outcome.human?.[0]).toBe("已引导交付 'add-login'：");
    expect(outcome.human?.join('\n')).toContain('分支：feat/123-add-login');
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

