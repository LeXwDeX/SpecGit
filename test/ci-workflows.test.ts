import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// CI-workflow consistency pin for the #85 repair: the Nix Flake Validation
// job must not depend on the deprecated magic-nix-cache action — its upstream
// FlakeHub registration path fails intermittently from external decay and
// red-noises Nix-touching runs without any product regression (#85, failing
// main run 32313535281).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('CI workflow consistency (#85: deprecated Nix cache path)', () => {
  it('no workflow references the deprecated magic-nix-cache action', () => {
    const workflowsDir = path.join(REPO_ROOT, '.github', 'workflows');
    for (const file of fs.readdirSync(workflowsDir)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const text = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');
      expect(
        text,
        `${file} must not use DeterminateSystems/magic-nix-cache-action (deprecated; #85)`,
      ).not.toContain('magic-nix-cache');
    }
  });
});
