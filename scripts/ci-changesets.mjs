import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Reuse the parser actually installed by the locked Changesets CLI.
 * @param {string} text
 * @param {string} file
 * @returns {{summary: string, releases: Array<{name: string, type: string}>}}
 */
export function parseReleaseNote(text, file) {
  const cliRequire = createRequire(require.resolve('@changesets/cli/package.json'));
  const readRequire = createRequire(cliRequire.resolve('@changesets/read'));
  const parse = readRequire('@changesets/parse').default;
  /** @type {{summary: string, releases: Array<{name: string, type: string}>}} */
  const result = parse(text);
  if (!result.summary.trim()) throw new Error(`${file}: a changeset needs a summary.`);
  if (result.releases.some((release) => release.name !== 'specgit' || !['patch', 'minor', 'major'].includes(release.type))) {
    throw new Error(`${file}: declare a specgit patch, minor, or major release.`);
  }
  return result;
}
