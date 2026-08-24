/**
 * Harness content (#280): configuration in, bytes out. These tests never
 * touch the filesystem — every artifact is asserted as pure bytes, and
 * the generated texts are locked with snapshots.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_CHECK_NAME,
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  GUARD_SCRIPT,
  harnessWorkflowYaml,
  injectManagedBlock,
  managedPromptBlock,
  mergeGitPrePush,
  mergeHooksJson,
} from '../../src/cli/harness-content.js';

describe('harnessWorkflowYaml', () => {
  it('is a byte-stable snapshot', () => {
    expect(harnessWorkflowYaml()).toMatchSnapshot();
  });

  it('names the acceptance check it contributes', () => {
    expect(harnessWorkflowYaml()).toContain(`name: ${ACCEPTANCE_CHECK_NAME}`);
  });
});

describe('managedPromptBlock', () => {
  it('en and zh are byte-stable snapshots framed by identical markers', () => {
    const en = managedPromptBlock('en');
    const zh = managedPromptBlock('zh');
    expect(en).toMatchSnapshot();
    expect(zh).toMatchSnapshot();
    for (const block of [en, zh]) {
      expect(block.startsWith(BLOCK_START_MARKER)).toBe(true);
      expect(block.endsWith(BLOCK_END_MARKER)).toBe(true);
    }
  });

  it('defaults to en', () => {
    expect(managedPromptBlock()).toBe(managedPromptBlock('en'));
  });
});

describe('guard script bytes', () => {
  it('is a byte-stable snapshot and spawnable: shebang on line 1', () => {
    expect(GUARD_SCRIPT).toMatchSnapshot();
    expect(GUARD_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('the fresh-install hooks.json seed parses and carries the PreToolUse guard', () => {
    const { json, warning } = mergeHooksJson(null);
    expect(warning).toBeUndefined();
    const parsed = JSON.parse(json) as { PreToolUse: unknown[] };
    expect(Array.isArray(parsed.PreToolUse)).toBe(true);
    expect(json).toMatchSnapshot();
  });
});

describe('injectManagedBlock: pure byte merge', () => {
  const block = `${BLOCK_START_MARKER}\nbody\n${BLOCK_END_MARKER}`;

  it('appends to foreign content and seeds an empty file', () => {
    expect(injectManagedBlock('', block)).toBe(`${block}\n`);
    const injected = injectManagedBlock('# notes\n', block);
    expect(injected.startsWith('# notes\n')).toBe(true);
    expect(injected.endsWith(`${block}\n`)).toBe(true);
  });

  it('replaces only the managed region; re-injection is byte-stable', () => {
    const injected = injectManagedBlock('# notes\n', block);
    expect(injectManagedBlock(injected, block)).toBe(injected);
  });

  // ---- marker-order and stray-marker convergence: a damaged layout ----
  // ---- (reversed markers, a stray marker, duplicated regions) must  ----
  // ---- converge in ONE pass instead of growing on every re-run.     ----

  it('converges reversed-order markers; user lines survive verbatim', () => {
    const reversed = `# intro\n${BLOCK_END_MARKER}\nuser note\n${BLOCK_START_MARKER}\n`;
    const once = injectManagedBlock(reversed, block);
    // The user prose keeps its bytes; exactly one managed region remains.
    expect(once).toContain('user note');
    expect(once.split(BLOCK_START_MARKER).length - 1).toBe(1);
    expect(once.split(BLOCK_END_MARKER).length - 1).toBe(1);
    // The old behavior appended a second block on every run.
    expect(injectManagedBlock(once, block)).toBe(once);
  });

  it('a stray start marker before a complete region converges without swallowing user bytes', () => {
    const stray = `# notes\n${BLOCK_START_MARKER}\nuser line\n${BLOCK_START_MARKER}\nold body\n${BLOCK_END_MARKER}\ntail\n`;
    const once = injectManagedBlock(stray, block);
    // The stray marker line is consumed; the user line between it and the
    // real region keeps its bytes and position.
    expect(once).toContain('# notes\nuser line');
    expect(once).toContain('user line\n' + BLOCK_START_MARKER);
    expect(once.split(BLOCK_START_MARKER).length - 1).toBe(1);
    expect(injectManagedBlock(once, block)).toBe(once);
  });

  it('a lone end marker is consumed and the file converges', () => {
    const lone = `# notes\n${BLOCK_END_MARKER}\n`;
    const once = injectManagedBlock(lone, block);
    expect(once).toContain('# notes\n');
    expect(once.split(BLOCK_END_MARKER).length - 1).toBe(1);
    expect(injectManagedBlock(once, block)).toBe(once);
  });

  it('mid-line marker prose neither pairs nor is consumed', () => {
    const prose = `discusses ${BLOCK_START_MARKER} inline and ${BLOCK_END_MARKER} too\n`;
    const once = injectManagedBlock(prose, block);
    // The inline mentions stay verbatim; the block is appended.
    expect(once.startsWith(prose)).toBe(true);
    expect(once.endsWith(`\n${block}\n`)).toBe(true);
    expect(injectManagedBlock(once, block)).toBe(once);
  });
});

describe('mergeGitPrePush: pure byte merge', () => {
  it('a fresh install is the spawnable managed file; re-merge is byte-stable', () => {
    const fresh = mergeGitPrePush(null);
    expect(fresh.startsWith('#!/bin/sh\n')).toBe(true);
    expect(fresh).toMatchSnapshot();
    expect(mergeGitPrePush(fresh)).toBe(fresh);
    expect(mergeGitPrePush('')).toBe(fresh);
  });

  it('a user hook is preserved verbatim with the managed region appended', () => {
    const user = '#!/bin/sh\necho user-hook\n';
    const merged = mergeGitPrePush(user);
    expect(merged.startsWith(user)).toBe(true);
    expect(mergeGitPrePush(merged)).toBe(merged);
  });

  it('converges reversed-order pre-push markers; user hook bytes survive', () => {
    const reversed =
      '#!/bin/sh\necho user-hook\n# <<< specgit:end <<<\nuser line\n# >>> specgit:start >>>\n';
    const once = mergeGitPrePush(reversed);
    expect(once).toContain('echo user-hook\nuser line');
    expect(once.split('# >>> specgit:start >>>').length - 1).toBe(1);
    expect(mergeGitPrePush(once)).toBe(once);
  });

  it('a stray start marker before a complete region converges without swallowing user bytes', () => {
    const stray =
      '#!/bin/sh\necho user-hook\n# >>> specgit:start >>>\nuser line\n# >>> specgit:start >>>\nguard body\n# <<< specgit:end <<<\n';
    const once = mergeGitPrePush(stray);
    expect(once).toContain('echo user-hook\nuser line');
    expect(once.split('# >>> specgit:start >>>').length - 1).toBe(1);
    expect(mergeGitPrePush(once)).toBe(once);
  });
});

describe('mergeHooksJson: pure byte merge', () => {
  it('preserves user keys and is byte-stable on re-merge', () => {
    const first = mergeHooksJson('{ "custom": true }');
    expect(first.warning).toBeUndefined();
    expect(JSON.parse(first.json)).toMatchObject({ custom: true });
    expect(mergeHooksJson(first.json).json).toBe(first.json);
  });

  it('invalid JSON is returned untouched with a warning', () => {
    const broken = '{ nope';
    const result = mergeHooksJson(broken);
    expect(result.json).toBe(broken);
    expect(result.warning).toBeDefined();
  });
});
