import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const expectedSuites = ['src/lib.rs', 'src/main.rs', 'tests/fixtures/process-child.rs', ...readdirSync(fileURLToPath(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.rs')).map(name => `tests/${name}`)].sort();
export function assertProfileInventory(profile) {
  assert(Array.isArray(profile.suites) && profile.test_processes === profile.suites.length && profile.suites.length > 0, 'Installed test profile is incomplete.');
  assert.deepEqual(profile.suites.map(suite => suite.source).sort(), expectedSuites, 'Installed profile omits or duplicates a native test executable.');
}
