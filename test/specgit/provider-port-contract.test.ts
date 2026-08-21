import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIT_PORT_MEMBERS,
  FORGE_PROVIDER_MEMBERS,
  GITHUB_PROVIDER_MEMBERS,
  GhCliGitHubProvider,
  LocalGitAdapter,
  sanitizeApiText,
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
    expect(Array.isArray(FORGE_PROVIDER_MEMBERS)).toBe(true);
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
    expect([...FORGE_PROVIDER_MEMBERS].sort()).toEqual(
      [
        'addIssueComment',
        'createDraftPr',
        'createIssue',
        'enableBranchProtection',
        'enableRepoAutomerge',
        'getBranchProtection',
        'getCheckRuns',
        'getIssue',
        'getOpenIssueNumbers',
        'getOpenIssues',
        'getPr',
        'getRepoAutomerge',
        'listOpenPrsByHead',
        'preflight',
      ].sort()
    );
  });

  it('the pre-#169 names stay importable as aliases of the neutral ones (#169)', () => {
    // Same frozen list, never a copy: external consumers importing the
    // historical `GITHUB_PROVIDER_MEMBERS` see exactly the neutral
    // inventory, and the type alias keeps `GitHubProvider` assignable.
    expect(GITHUB_PROVIDER_MEMBERS).toBe(FORGE_PROVIDER_MEMBERS);
    const port = read('src', 'github', 'port.ts');
    expect(port).toContain('export type GitHubProvider = ForgeProvider;');
  });

  describe('every in-tree GitPort implementation exposes every GitPort member', () => {
    it('LocalGitAdapter', () => {
      expectExposes(new LocalGitAdapter(), GIT_PORT_MEMBERS, 'LocalGitAdapter');
    });
    it('makeGitPort (test double)', () => {
      expectExposes(makeGitPort(makeGitFacts()), GIT_PORT_MEMBERS, 'makeGitPort (test double)');
    });
  });

  describe('every in-tree ForgeProvider implementation exposes every ForgeProvider member (#169)', () => {
    it('GhCliGitHubProvider', () => {
      expectExposes(new GhCliGitHubProvider(), FORGE_PROVIDER_MEMBERS, 'GhCliGitHubProvider');
    });
    it('GlabProvider (#114)', async () => {
      const glab = await import('../../src/providers/gitlab/glab-cli.js');
      expectExposes(new glab.GlabProvider(), FORGE_PROVIDER_MEMBERS, 'GlabProvider');
    });
    it('PlatformRoutingProvider (#117)', async () => {
      const routing = await import('../../src/providers/routing.js');
      expectExposes(
        new routing.PlatformRoutingProvider({
          github: new GhCliGitHubProvider(),
          gitlab: async () => new GhCliGitHubProvider(),
          originPlatform: async () => 'github',
        }),
        FORGE_PROVIDER_MEMBERS,
        'PlatformRoutingProvider'
      );
    });
    it('MockGitHubProvider (test double)', () => {
      expectExposes(
        new MockGitHubProvider(),
        FORGE_PROVIDER_MEMBERS,
        'MockGitHubProvider (test double)'
      );
    });
    it('makeGhProvider (test double)', () => {
      expectExposes(makeGhProvider(), FORGE_PROVIDER_MEMBERS, 'makeGhProvider (test double)');
    });
  });

  // Adapter-home pins (#113): the GitHub adapter canonically lives under
  // src/providers/github/ (option B — neutral port, per-platform adapters),
  // while the legacy src/github module paths and the public API remain
  // stable aliases of that home — same class, same functions, never copies.
  describe('the GitHub adapter home under src/providers/github (#113)', () => {
    it('GhCliGitHubProvider canonically lives at src/providers/github/gh-cli.ts and implements the port', async () => {
      const canonical = await import('../../src/providers/github/gh-cli.js');
      expectExposes(
        new canonical.GhCliGitHubProvider(),
        FORGE_PROVIDER_MEMBERS,
        'GhCliGitHubProvider (src/providers/github/gh-cli.ts)'
      );
    });

    it('the legacy src/github module paths are stable aliases of the canonical home', async () => {
      const canonical = await import('../../src/providers/github/gh-cli.js');
      const legacyGhCli = await import('../../src/github/gh-cli.js');
      const canonicalProtection = await import('../../src/providers/github/protection-merge.js');
      const legacyProtection = await import('../../src/github/protection-merge.js');
      expect(legacyGhCli.GhCliGitHubProvider).toBe(canonical.GhCliGitHubProvider);
      expect(legacyGhCli.sanitizeApiText).toBe(canonical.sanitizeApiText);
      expect(legacyGhCli.resolveNodeScriptCommand).toBe(canonical.resolveNodeScriptCommand);
      expect(legacyProtection.buildProtectionUpdateBody).toBe(
        canonicalProtection.buildProtectionUpdateBody
      );
    });

    it('the legacy alias modules are marked @deprecated toward their canonical home (#170)', () => {
      // src/github keeps exactly two roles: the canonical port definition
      // (port.ts) and deprecated alias modules for the adapter home under
      // src/providers/github/. The aliases stay importable (referential
      // equality pinned above) until their removal lands as its own
      // delivery; until then every alias header names both facts.
      const ghCliAlias = read('src', 'github', 'gh-cli.ts');
      const protectionAlias = read('src', 'github', 'protection-merge.ts');
      expect(ghCliAlias).toContain('@deprecated');
      expect(ghCliAlias).toContain('src/providers/github/gh-cli.ts');
      expect(protectionAlias).toContain('@deprecated');
      expect(protectionAlias).toContain('src/providers/github/protection-merge.ts');
    });

    it('CONTRIBUTING.md states the canonical home and the alias removal intent (#170)', () => {
      const contributing = read('CONTRIBUTING.md');
      expect(contributing).toContain('src/providers/github/');
      expect(contributing).toContain('src/github');
      expect(contributing).toMatch(/deprecated/i);
    });

    it('the public API re-exports the canonical provider implementation', async () => {
      const canonical = await import('../../src/providers/github/gh-cli.js');
      expect(GhCliGitHubProvider).toBe(canonical.GhCliGitHubProvider);
      expect(sanitizeApiText).toBe(canonical.sanitizeApiText);
    });
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
    expect(sectionMembers(/^### ForgeProvider /).sort()).toEqual(
      [...FORGE_PROVIDER_MEMBERS].sort()
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
      'ForgeProvider',
      'GitPort',
      'GitWritePort',
      'BranchCheckout',
      'BranchProtectionFact',
      'RepoAutomergeFact',
      'GIT_PORT_MEMBERS',
      'FORGE_PROVIDER_MEMBERS',
      // The pre-#169 names remain exported as compatibility aliases (#169).
      'GitHubProvider',
      'GITHUB_PROVIDER_MEMBERS',
    ]) {
      expect(api, `src/index.ts must export ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
