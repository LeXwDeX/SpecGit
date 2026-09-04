/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * npm <=11 returns an array; npm 12 returns metadata keyed by package name.
 * Both callers pack exactly one package and require a local tarball basename.
 * Lifecycle banners may precede the JSON document, but extra results or
 * trailing output are never used to guess which artifact should be installed.
 * @param {string} output
 * @returns {string}
 */
export function parseNpmPackFilename(output) {
  const lines = output.split(/\r?\n/);
  const jsonStart = lines.findIndex((line) => {
    const text = line.trimStart();
    return text.startsWith('[') || text.startsWith('{');
  });
  if (jsonStart === -1) throw new Error('npm pack returned no JSON metadata.');

  /** @type {unknown} */
  let metadata;
  try {
    metadata = JSON.parse(lines.slice(jsonStart).join('\n').trim());
  } catch {
    throw new Error('npm pack returned invalid JSON metadata.');
  }
  const entries = Array.isArray(metadata) ? metadata : isRecord(metadata) ? Object.values(metadata) : [];
  if (entries.length !== 1 || !isRecord(entries[0])) {
    throw new Error('npm pack must return exactly one package metadata record.');
  }
  const { filename } = entries[0];
  if (typeof filename !== 'string' || filename.trim() !== filename || !filename.endsWith('.tgz') ||
      /[\\/:\x00-\x1f\x7f]/.test(filename)) {
    throw new Error('npm pack returned no valid tarball basename.');
  }
  return filename;
}
