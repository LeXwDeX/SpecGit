import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBinary } from './native-release.mjs';
import { targets } from './native-build.mjs';
import { checkSurfaces, writeSchemas } from './check-surfaces.mjs';

export function installNative(binary, output, version, source, target) {
  const evidence = prepareBinary(binary, output, version, source, target);
  const installed = path.join(output, targets[target].os === 'win32' ? 'specgit.exe' : 'specgit');
  renameSync(path.join(output, evidence.filename), installed);
  chmodSync(installed, 0o755);
  const runtime = fileURLToPath(new URL('../', import.meta.url));
  writeSchemas(installed, path.join(output, 'schemas'), path.join(runtime, 'schemas'));
  copyFileSync(path.join(runtime, 'REFERENCE.md'), path.join(output, 'README.md'));
  const surfaces = checkSurfaces(installed, output);
  assert(readFileSync(installed).equals(readFileSync(binary)), 'Installed binary differs from the compiled artifact.');
  const result = { ...evidence, binary: installed, surfaces };
  writeFileSync(path.join(output, 'installed.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
