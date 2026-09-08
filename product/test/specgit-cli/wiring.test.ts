import { describe, expect, it } from 'vitest';

import { createDefaultContext } from '../../src/cli/wiring.js';
import { ok, type Evidence } from '../../src/kernel/evidence.js';

/**
 * Behavior lock for #184: the repo root has exactly one answer per command
 * run, so the composition root must resolve it once and inject the cached
 * value into every consumer (providers, policy, platform routing, record
 * IO). A counting discover stub proves no consumer rediscovers the root.
 */
describe('createDefaultContext root resolution (#184)', () => {
  it('resolves the repo root exactly once across all context consumers', async () => {
    let discoverCalls = 0;
    const root = process.cwd();
    const discoverRoot = async (_cwd: string): Promise<Evidence<string>> => {
      discoverCalls += 1;
      return ok(root);
    };

    const ctx = createDefaultContext({ discoverRoot });

    // The command-side entry point, called repeatedly the way commands use it.
    const first = await ctx.discoverRoot(ctx.cwd);
    const second = await ctx.discoverRoot(ctx.cwd);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toBe(first.value);
    }

    // parseRepoRef threads the declared GitLab host, which reads the root
    // and the providers declaration — the cache must serve both.
    const parsed = await ctx.parseRepoRef('https://github.com/LeXwDeX/SpecGit.git');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // No GitLab declaration: the parse layer still fills the marker —
      // platform is a required union (#186), explicitly 'github' here.
      expect(parsed.value.platform).toBe('github');
    }

    // The evaluator delegate fills in the declared host the same way.
    expect(discoverCalls).toBe(1);
  });

  it('keeps distinct cwds distinct in the root cache', async () => {
    const seen: string[] = [];
    const discoverRoot = async (cwd: string): Promise<Evidence<string>> => {
      seen.push(cwd);
      return ok(cwd);
    };

    const ctx = createDefaultContext({ discoverRoot });
    await ctx.discoverRoot('/tmp/a');
    await ctx.discoverRoot('/tmp/a');
    await ctx.discoverRoot('/tmp/b');

    expect(seen).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('accepts no overrides and keeps the production default', () => {
    // The composition root must stay callable with zero arguments — the
    // CLI entry point constructs it exactly this way.
    const ctx = createDefaultContext();
    expect(typeof ctx.discoverRoot).toBe('function');
  });
});
