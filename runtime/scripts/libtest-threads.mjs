// Windows process startup and teardown are slower, so the native qualification
// runs both the source and installed-binary phases with one libtest budget.
// The hook suite starts one native CLI per case and keeps a single worker.
export function libtestThreads(platform, source) {
  if (platform !== 'win32') return undefined;
  return source === 'tests/hooks.rs' ? '1' : '2';
}
