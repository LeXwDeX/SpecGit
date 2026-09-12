import { registryRelease } from './release-check.mjs';

const need = (value, message) => { if (!value) throw new Error(message); };
export async function publishNpm(release, { registry = registryRelease, npm, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 6 }) {
  npm(['whoami', '--registry=https://registry.npmjs.org']);
  let state = await registry(release);
  const ordered = [...release.packages.filter(item => item.name !== 'specgit'), release.packages.find(item => item.name === 'specgit')];
  for (const artifact of ordered) {
    need(artifact, 'Missing wrapper package.');
    state = await registry(release);
    if (artifact.name === 'specgit') need(state.observations.filter(item => item.name !== 'specgit').every(item => item.state === 'verified'), 'Native packages must be visible before the wrapper.');
    if (state.observations.find(item => item.name === artifact.name)?.state === 'verified') continue;
    // A lost response stops here. The next explicit invocation reconciles first.
    npm(['publish', artifact.tarball, '--registry=https://registry.npmjs.org', '--access=public', '--ignore-scripts', '--provenance=false', '--tag=v2-staging']);
    let visible = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      state = await registry(release);
      if (state.observations.find(item => item.name === artifact.name)?.state === 'verified') { visible = true; break; }
      if (attempt + 1 < attempts) await wait(5000);
    }
    need(visible, `Registry propagation for ${artifact.name} remains unknown. Reconcile before retrying.`);
  }
  state = await registry(release);
  need(state.can_promote_latest, 'All immutable versions must be verified before latest promotion.');
  for (const artifact of ordered) {
    npm(['dist-tag', 'add', `${artifact.name}@${artifact.version}`, 'latest', '--registry=https://registry.npmjs.org']);
    let visible = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (JSON.parse(npm(['view', artifact.name, 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org'])) === artifact.version) { visible = true; break; }
      if (attempt + 1 < attempts) await wait(5000);
    }
    need(visible, `The latest tag for ${artifact.name} is not confirmed.`);
  }
  return { ...state, latest_verified: true, publication_performed: true };
}
