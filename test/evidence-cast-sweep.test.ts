/**
 * #213 — the zero-Evidence-cast invariant of the test tree.
 *
 * The #178 delivery aligned every CLI test double with the real port
 * signatures and removed the last never-cast Evidence assertions; this
 * sweep keeps them removed. Both evasion forms are forbidden anywhere
 * under test/: a direct never-cast and the two-step unknown-bridge
 * rewrite that hides the same drift from the type checker. The
 * forbidden tokens are built by concatenation so this file stays clean
 * under its own sweep.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = path.join(REPO_ROOT, 'test');

const FORBIDDEN_PATTERNS: RegExp[] = [
  new RegExp('as ' + 'Evidence<' + 'never>'),
  new RegExp('as ' + 'unknown as ' + 'Evidence'),
];

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      yield* walkFiles(fullPath);
    } else if (entry.isFile() && path.extname(entry.name) === '.ts') {
      yield fullPath;
    }
  }
}

describe('test-tree Evidence-cast sweep (#213)', () => {
  it('keeps the port-signature-hiding Evidence casts out of the test tree', () => {
    const offenders: string[] = [];

    for (const filePath of walkFiles(TEST_ROOT)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push(
              `${path.relative(REPO_ROOT, filePath)}:${index + 1}: ${line.trim()}`
            );
          }
        }
      });
    }

    expect(
      offenders,
      `Evidence evasion casts found — align the double with the port signature instead:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
