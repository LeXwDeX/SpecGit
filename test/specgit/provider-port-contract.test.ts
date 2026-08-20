import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIT_PORT_MEMBERS,
  GITHUB_PROVIDER_MEMBERS,
  GhCliGitHubProvider,
  LocalGitAdapter,
} from '../../src/index.js';
import { MockGitHubProvider } from './helpers/mock-github.js';
import { makeGitFacts, makeGitPort, makeGhProvider } from '../specgit-cli/helpers.js';

// Port-contract pins (#80): every in-tree implementation — production
// adapters and test doubles alike — is held to the same port shape, the
// policy document tracks the ports member-for-member, and the public API
// carries the full port vocabulary. A regression here is a seam break,
// not a typo.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf-8');

function expectExposes(instance: object, members: readonly string[], label: string): void {
  const record = instance as Record<string, unknown>;
  for (const member of members) {
    expect(
      typeof record[member] === 'function',
      `${label} must implement port member '${member}'`
    ).toBe(true);
  }
}

describe('provider port contract (#80)', () => {
  it('exports the member inventories for both ports', () => {
    expect(Array.isArray(GIT_PORT_MEMBERS)).toBe(true);
    expect(Array.isArray(GITHUB_PROVIDER_MEMBERS)).toBe(true);
    expect([...GIT_PORT_MEMBERS].sort()).toEqual(
      [
        'checkoutOrCreateBranch',
        'commitFile',
        'facts',
        'headContains',
        'hooksPath',
        'pushBranch',
        'remoteDefaultBranch',
      ].sort()
    );
    expect([...GITHUB_PROVIDER_MEMBERS].sort()).toEqual(
      [
        'createDraftPr',
        'createIssue',
        'enableBranchProtection',
        'enableRepoAutomerge',
        'getBranchProtection',
        'getCheckRuns',
        'getIssue',
        'getOpenIssueNumbers',
        'getPr',
        'getRepoAutomerge',
        'listOpenPrsByHead',
        'preflight',
      ].sort()
    );
  });

  it('every in-tree GitPort implementation exposes every GitPort member', () => {
    expectExposes(new LocalGitAdapter(), GIT_PORT_MEMBERS, 'LocalGitAdapter');
    expectExposes(makeGitPort(makeGitFacts()), GIT_PORT_MEMBERS, 'makeGitPort (test double)');
  });

  it('every in-tree GitHubProvider implementation exposes every GitHubProvider member', () => {
    expectExposes(new GhCliGitHubProvider(), GITHUB_PROVIDER_MEMBERS, 'GhCliGitHubProvider');
    expectExposes(
      new MockGitHubProvider(),
      GITHUB_PROVIDER_MEMBERS,
      'MockGitHubProvider (test double)'
    );
    expectExposes(
      makeGhProvider(),
      GITHUB_PROVIDER_MEMBERS,
      'makeGhProvider (test double)'
    );
  });

  it('the port-compatibility policy documents every port member', () => {
    const doc = read('docs', 'providers.md');

    const sectionMembers = (heading: RegExp): string[] => {
      const lines = doc.split('\n');
      const start = lines.findIndex((line) => heading.test(line));
      expect(start, `docs/providers.md must have a section matching ${heading}`).toBeGreaterThanOrEqual(0);
      const members: string[] = [];
      for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.startsWith('#')) break;
        const row = line.match(/^\|\s*`([A-Za-z]+)`\s*\|/);
        if (row) members.push(row[1]);
      }
      return members;
    };

    expect(sectionMembers(/^### GitPort /).sort()).toEqual([...GIT_PORT_MEMBERS].sort());
    expect(sectionMembers(/^### GitHubProvider /).sort()).toEqual(
      [...GITHUB_PROVIDER_MEMBERS].sort()
    );
  });

  it('the policy pins the optional-evidence fallback for IssueFact.title', () => {
    const doc = read('docs', 'providers.md');
    expect(doc).toContain('IssueFact.title');
    expect(doc).toMatch(/fallback/i);
    expect(doc).toMatch(/adopt/i);
  });

  it('the public API carries the full port vocabulary', () => {
    const api = read('src', 'index.ts');
    for (const name of [
      'GitHubProvider',
      'GitPort',
      'GitWritePort',
      'BranchCheckout',
      'BranchProtectionFact',
      'RepoAutomergeFact',
      'GIT_PORT_MEMBERS',
      'GITHUB_PROVIDER_MEMBERS',
    ]) {
      expect(api, `src/index.ts must export ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
