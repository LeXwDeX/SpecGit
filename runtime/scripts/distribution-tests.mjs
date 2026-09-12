import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Only repository-controlled basenames and exit values reach CI output. Raw
// subprocess output remains in the local attempt directory.
export function runDistributionTests(files, directory, { cwd, run = spawnSync } = {}) {
  const failures = [];
  for (const file of files) {
    if (!/^[a-z0-9-]+\.test\.mjs$/.test(file)) throw new Error('Unexpected distribution test filename.');
    const result = run(process.execPath, ['--test', `distribution/${file}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    writeFileSync(path.join(directory, `${file}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.error || result.status !== 0) failures.push(`${file}: exit ${Number.isInteger(result.status) ? result.status : 'unknown'}`);
  }
  if (failures.length) throw new Error(`Distribution regression failed: ${failures.join('; ')}. Raw logs retained locally.`);
}
