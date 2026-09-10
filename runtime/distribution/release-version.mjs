#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { version: { type: 'string' } } });
const workspace = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
const cargo = readFileSync(fileURLToPath(new URL('../Cargo.toml', import.meta.url)), 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (!/^\d+\.\d+\.\d+$/.test(values.version ?? '') || values.version !== workspace.version || values.version !== cargo || workspace.private !== true) {
  throw new Error('Stable release versions or private workspace identity differ.');
}
process.stdout.write(JSON.stringify({ version: values.version, workspace_private: true }) + '\n');
