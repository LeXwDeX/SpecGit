#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseNotes } from './publish.mjs';
const { values } = parseArgs({ options: { version: { type: 'string' } } });
const workspace = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
const cargo = readFileSync(fileURLToPath(new URL('../Cargo.toml', import.meta.url)), 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (!/^\d+\.\d+\.\d+$/.test(values.version ?? '') || values.version !== workspace.version || values.version !== cargo || workspace.private !== true) {
  throw new Error('Stable release versions or private workspace identity differ.');
}
// Fail before building and signing when the source cannot render its Release notes.
releaseNotes({ version: values.version, source: '0'.repeat(40), archives: [] }, '1');
process.stdout.write(JSON.stringify({ version: values.version, workspace_private: true, release_notes: 'renderable' }) + '\n');
