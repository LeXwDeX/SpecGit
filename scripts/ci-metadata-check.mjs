#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { checkRepositoryDocumentation } from './documentation-check.mjs';

const retiredEntryPoints = ['src/index.ts', 'bin/specgit.js', 'build.js', 'vitest.config.ts', 'spec_git/policy.yaml', '.github/workflows/specgit-accept.yml', '.github/workflows/specgit-complete.yml', '.github/workflows/rc-verify.yml'];
// The v1 global integration registered this hook command in .opencode/hooks.json
// (verified content from git history, commit eaf9bbb9^). Project v2 receipts
// generate `hook --event` commands instead, so the filename itself is supported.
const retiredHookCommand = 'specgit-merge-guard.sh';
const referencesRetiredHook = value => {
  if (typeof value === 'string') return value.includes(retiredHookCommand);
  if (Array.isArray(value)) return value.some(referencesRetiredHook);
  if (value && typeof value === 'object') return Object.values(value).some(referencesRetiredHook);
  return false;
};

export function checkRepositoryMetadata(root) {
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
  for (const retired of retiredEntryPoints) {
    assert(!existsSync(path.join(root, retired)), `Retired v1 entry point: ${retired}`);
  }
  const hooks = path.join(root, '.opencode/hooks.json');
  if (existsSync(hooks)) {
    let configuration;
    try {
      configuration = JSON.parse(read('.opencode/hooks.json'));
    } catch (error) {
      throw new Error(`.opencode/hooks.json is not valid JSON: ${error.message}`);
    }
    assert(!referencesRetiredHook(configuration), 'Retired v1 entry point: .opencode/hooks.json');
  }
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  checkRepositoryMetadata(root);
  const documentCount = checkRepositoryDocumentation(root);
  process.stdout.write(`Native repository metadata and ${documentCount} documentation files passed.\n`);
}

const entry = process.argv[1] && realpathSync(process.argv[1]);
const module = realpathSync(fileURLToPath(import.meta.url));
if (entry && pathToFileURL(entry).href === pathToFileURL(module).href) main();
