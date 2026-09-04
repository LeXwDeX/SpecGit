import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/acceptance/evaluate.js';
import { PolicySchema } from '../../src/record/policy.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeGitFacts } from '../specgit-cli/helpers.js';
import { MockForgeProvider, makeIssueFact, makePrFact } from './helpers/mock-forge.js';

async function verdict(options: {
  language?: 'en' | 'zh'; title?: string; prTitle?: string; labels?: string[];
  labelRule?: 'kind' | 'project'; titles?: boolean; metadata?: boolean;
} = {}) {
  const policy = PolicySchema.parse({
    version: 1, required_checks: [], language: options.language ?? 'en',
    tags: [{ name: 'module::auth' }, { name: 'bug' }],
    validation: { titles: options.titles ?? true, labels: options.labelRule ?? 'kind' },
  });
  const metadata = options.metadata === false ? {} : {
    title: options.title ?? 'fix: preserve evidence', labels: options.labels ?? ['kind::fix'],
  };
  return evaluate({
    root: ok('/repo'), policy: ok(policy),
    record: ok({ version: 1, delivery: 'audit', context: { kind: 'branch', branch: 'feat/123-login' }, issues: [123], pr: 42 }),
    git: { facts: async () => makeGitFacts(), headContains: async () => ok({ contained: false }) },
    gh: new MockForgeProvider({
      issues: { 123: ok(makeIssueFact({ number: 123, ...metadata })) },
      pr: ok(makePrFact({ title: options.prTitle ?? 'fix: preserve evidence' })),
    }),
  });
}

describe('explicit project title and label rules', () => {
  it('accepts an English delivery with one selected kind', async () => {
    expect((await verdict()).exitCode).toBe(0);
  });
  it.each(['fix: 修复 GitHub', 'fix: extension 𠀀'])('rejects Han characters in remote issue title %s', async (title) => {
    const result = await verdict({ title });
    expect(result.exitCode).toBe(1);
    expect(result.gates.find((g) => g.id === 'issues')?.failures[0].code).toBe('title_language_mismatch');
  });
  it('also checks the actual remote PR title', async () => {
    const result = await verdict({ prTitle: 'fix: 修复' });
    expect(result.exitCode).toBe(1);
    expect(result.gates.find((g) => g.id === 'pr')?.failures[0].code).toBe('title_language_mismatch');
  });
  it('permits English technical terms in a selected Chinese title rule', async () => {
    expect((await verdict({ language: 'zh', title: 'fix: 修复 GitHub API', prTitle: 'fix: 修复 API' })).exitCode).toBe(0);
    expect((await verdict({ language: 'zh', title: 'fix: API', prTitle: 'fix: 修复 API' })).exitCode).toBe(1);
  });
  it('fails unknown when required remote metadata is missing', async () => {
    const result = await verdict({ metadata: false });
    expect(result.exitCode).toBe(3);
    expect(result.classification).toBe('unknown');
  });
  it.each([[], ['kind::fix', 'kind::feat'], ['kind::fix', 'unknown'], ['kind::other']].map((labels) => ({ labels })))(
    'rejects a label set outside the chosen kind rule: $labels', async ({ labels }) => {
      const result = await verdict({ labels });
      expect(result.exitCode).toBe(1);
      expect(result.gates.find((g) => g.id === 'issues')?.failures[0].code).toBe('issue_labels_invalid');
    }
  );
  it('accepts project vocabulary alongside one kind', async () => {
    expect((await verdict({ labels: ['kind::fix', 'module::auth'] })).exitCode).toBe(0);
  });
  it('supports a selected project vocabulary without requiring kind labels', async () => {
    expect((await verdict({ labelRule: 'project', labels: ['bug'] })).exitCode).toBe(0);
    expect((await verdict({ labelRule: 'project', labels: ['kind::fix'] })).exitCode).toBe(1);
  });
  it('does not imply title rules from the presentation language alone', () => {
    expect(PolicySchema.parse({ version: 1, required_checks: [], language: 'en' }).validation).toBeUndefined();
  });
  it.each([undefined, []])('rejects a project label rule with no selectable vocabulary: %j', (tags) => {
    expect(PolicySchema.safeParse({ version: 1, required_checks: [], validation: { labels: 'project' }, tags }).success).toBe(false);
  });
});
