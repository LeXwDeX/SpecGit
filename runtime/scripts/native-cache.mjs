import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const fileDigest = file => digest(readFileSync(file));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

export function snapshotFiles(paths, allowedRoot) {
  const rows = [];
  function visit(file) {
    file = path.resolve(file);
    assert(inside(allowedRoot, file), 'Cached outputs must stay inside the owned runner cache.');
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) rows.push({ file, link: readlinkSync(file) });
    else if (stat.isDirectory()) {
      rows.push({ file, directory: true });
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    } else {
      assert(stat.isFile(), 'Only regular build outputs can be reused.');
      rows.push({ file, sha256: fileDigest(file), mode: stat.mode & 0o777 });
    }
  }
  for (const file of [...new Set(paths)].sort()) visit(file);
  return rows;
}

// Receipts attest successful local phases, not remote acceptance. Missing,
// changed or partial outputs require the affected phase to run again.
export class PhaseCache {
  constructor(directory, identity, allowedRoot = directory) {
    this.directory = path.resolve(directory);
    this.allowedRoot = path.resolve(allowedRoot);
    this.identity = digest(JSON.stringify(identity));
    mkdirSync(this.directory, { recursive: true });
  }

  file(name) {
    assert(/^[a-z][a-z-]+$/.test(name), 'Invalid native phase name.');
    return path.join(this.directory, `${name}.json`);
  }

  get(name, visiting = new Set()) {
    if (visiting.has(name)) return null;
    visiting = new Set([...visiting, name]);
    try {
      const receipt = JSON.parse(readFileSync(this.file(name), 'utf8'));
      if (receipt.schema_version !== 1 || receipt.identity !== this.identity || receipt.phase !== name) return null;
      for (const [dependency, fingerprint] of Object.entries(receipt.dependencies)) {
        const current = this.get(dependency, visiting);
        if (!current || digest(JSON.stringify(current)) !== fingerprint) return null;
      }
      if (JSON.stringify(snapshotFiles(receipt.paths, this.allowedRoot)) !== JSON.stringify(receipt.files)) return null;
      return receipt;
    } catch { return null; }
  }

  async run(name, dependencies, execute) {
    const fingerprints = {};
    for (const dependency of dependencies) {
      const receipt = this.get(dependency);
      assert(receipt, `Native phase ${dependency} must succeed before ${name}.`);
      fingerprints[dependency] = digest(JSON.stringify(receipt));
    }
    const previous = this.get(name);
    if (previous && JSON.stringify(previous.dependencies) === JSON.stringify(fingerprints)) {
      process.stdout.write(`Reusing verified native phase: ${name}\n`);
      return previous.value;
    }
    const { value, files } = await execute();
    assert(Array.isArray(files) && files.length > 0, 'A successful phase must retain its outputs.');
    const receipt = { schema_version: 1, identity: this.identity, phase: name, dependencies: fingerprints,
      paths: files, files: snapshotFiles(files, this.allowedRoot), value };
    // A torn receipt is deliberately invalid; previously written outputs remain.
    writeFileSync(this.file(name), JSON.stringify(receipt, null, 2) + '\n');
    return value;
  }
}

export function readCompiledTests(file, source) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.source, source, 'Compiled tests belong to another source commit.');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  assert(manifest.executables.length > 0, 'Compiled Cargo executables are required.');
  for (const executable of manifest.executables) {
    assert(existsSync(executable.file), 'A compiled executable is missing.');
    assert.equal(fileDigest(executable.file), executable.sha256, 'A compiled executable changed.');
  }
  assert(manifest.artifacts.every(artifact => artifact.profile.test && manifest.executables.some(row => row.file === artifact.executable)), 'Every test must identify a verified compiled executable.');
  return manifest;
}
