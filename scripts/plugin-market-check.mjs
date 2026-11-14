#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const portableSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const portableFields = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
const portableName = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const authenticationPolicies = ['ON_INSTALL', 'ON_USE'];
const pluginContents = ['.claude-plugin/plugin.json', 'skills/specgit-native/SKILL.md'];

export function checkPluginMarketplace(root) {
  const read = name => readFileSync(path.join(root, name), 'utf8');
  const readJson = name => {
    try {
      return JSON.parse(read(name));
    } catch (error) {
      throw new Error(`${name}: invalid JSON: ${error.message}`);
    }
  };
  const version = JSON.parse(read('package.json')).version;
  // [package] is a header-delimited section; take its first version assignment.
  const cargoPackage = read('runtime/Cargo.toml').split(/^\[/m).find(section => section.startsWith('package]')) ?? '';
  const cargoVersion = cargoPackage.match(/^version = "([^"]+)"/m)?.[1];
  assert(cargoVersion, 'runtime/Cargo.toml: [package] version is missing');
  assert.equal(version, cargoVersion, 'package.json and runtime/Cargo.toml versions differ');
  for (const manifest of ['plugin/.claude-plugin/plugin.json', 'plugin/plugin.json']) {
    assert.equal(readJson(manifest).version, version, `${manifest}: version drift`);
  }

  const checkSource = (label, source) => {
    assert.equal(typeof source, 'string', `${label}: source must be a string`);
    assert(source.startsWith('./'), `${label}: source must start with ./`);
    assert(!source.includes('..'), `${label}: source must not contain ..`);
    assert(existsSync(path.join(root, source)), `${label}: source directory does not exist: ${source}`);
    for (const file of pluginContents) {
      assert(existsSync(path.join(root, source, file)), `${label}: ${source} is missing ${file}`);
    }
  };
  const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
  assert(Array.isArray(claudeMarketplace.plugins), '.claude-plugin/marketplace.json: plugins must be an array');
  for (const [index, plugin] of claudeMarketplace.plugins.entries()) {
    checkSource(`.claude-plugin/marketplace.json plugins[${index}]`, plugin?.source);
  }
  const codexMarketplace = readJson('.agents/plugins/marketplace.json');
  assert(Array.isArray(codexMarketplace.plugins), '.agents/plugins/marketplace.json: plugins must be an array');
  for (const [index, plugin] of codexMarketplace.plugins.entries()) {
    const label = `.agents/plugins/marketplace.json plugins[${index}]`;
    checkSource(`${label}.source`, plugin?.source?.path);
    assert(authenticationPolicies.includes(plugin?.policy?.authentication), `${label}: policy.authentication must be ON_INSTALL or ON_USE`);
  }

  // The distributed Skill is the host-neutral template plus a plugin-only appendix.
  const base = read('runtime/assets/SKILL.md').replaceAll('{{version}}', version);
  const distributed = read('plugin/skills/specgit-native/SKILL.md');
  assert(distributed.startsWith(base), 'plugin/skills/specgit-native/SKILL.md: template prefix drift');
  assert.equal(distributed.match(/^Contract version: (.*)\.$/m)?.[1], version, 'plugin/skills/specgit-native/SKILL.md: Contract version drift');
  const appendix = distributed.slice(base.length);
  assert(appendix.trim().length > 0, 'plugin/skills/specgit-native/SKILL.md: plugin appendix is missing');
  assert(appendix.includes('## 插件环境与安装引导'), 'plugin/skills/specgit-native/SKILL.md: plugin installation guidance heading is missing');

  const icon = path.join(root, 'plugin/assets/icon.png');
  assert(existsSync(icon), 'plugin/assets/icon.png: missing');
  assert(readFileSync(icon).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'plugin/assets/icon.png: not a PNG');

  const portable = readJson('plugin/plugin.json');
  for (const field of Object.keys(portable)) {
    assert(portableFields.has(field), `plugin/plugin.json: unsupported top-level field: ${field}`);
  }
  assert.equal(portable.$schema, portableSchema, 'plugin/plugin.json: $schema drift');
  assert.equal(typeof portable.name, 'string', 'plugin/plugin.json: name must be a string');
  assert.match(portable.name, portableName, 'plugin/plugin.json: name is not a valid portable plugin name');
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    checkPluginMarketplace(root);
  } catch (error) {
    process.stderr.write(`Plugin marketplace check failed:\n${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Plugin marketplace artifacts passed.\n');
}

const entry = process.argv[1] && realpathSync(process.argv[1]);
const module = realpathSync(fileURLToPath(import.meta.url));
if (entry && pathToFileURL(entry).href === pathToFileURL(module).href) main();