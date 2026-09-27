#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkRepositoryDocumentation } from './documentation-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(path.join(root, name), 'utf8');
// Local initialization is optional in clean CI checkouts.
if (existsSync(path.join(root, '.specgit.yaml'))) {
  const declaration = parse(read('.specgit.yaml'));
  assert.equal(declaration.version, 2);
  assert.equal(declaration.target, 'main');
  assert(!('issues' in declaration), 'Native associations must not use v1 binding records.');
}
const workspace = JSON.parse(read('package.json'));
assert.equal(workspace.private, true);
assert(!workspace.bin && !workspace.exports, 'The private tooling workspace must not expose a CLI.');
assert.equal(workspace.version, read('runtime/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1]);
for (const retired of ['src/index.ts', 'bin/specgit.js', 'build.js', 'vitest.config.ts', 'spec_git/policy.yaml', '.opencode/hooks.json', '.github/workflows/specgit-accept.yml', '.github/workflows/specgit-complete.yml', '.github/workflows/rc-verify.yml']) {
  assert(!existsSync(path.join(root, retired)), `Retired v1 entry point: ${retired}`);
}
const documentCount = checkRepositoryDocumentation(root);
process.stdout.write(`Native repository metadata and ${documentCount} documentation files passed.\n`);
