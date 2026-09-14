import { parse } from 'yaml';
export const assertReleaseActorCredentials = (text, label) => {
  const doc = parse(text);
  if (JSON.stringify(Object.keys(doc.on ?? {})) !== JSON.stringify(['workflow_dispatch']) || doc.jobs?.build.if !== "github.repository == 'LeXwDeX/SpecGit' && github.ref == 'refs/heads/main'") throw new Error(`${label}: explicit trusted main release required`);
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: 'read' })) throw new Error(`${label}: build permissions must stay read-only`);
  if (String(doc.jobs?.assemble.needs) !== 'build' || doc.jobs?.assemble.if !== undefined) throw new Error(`${label}: publication must require successful builds`);
  let publishers = 0;
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    const permissions = job.permissions ?? doc.permissions;
    const expected = id === 'assemble' ? { contents: 'write', actions: 'read', 'id-token': 'write' } : { contents: 'read' };
    if (JSON.stringify(permissions) !== JSON.stringify(expected)) throw new Error(`${label}: unexpected release permissions`);
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) throw new Error(`${label}: release must not persist checkout credentials`);
      const publisher = id === 'assemble' && step.run?.startsWith('node runtime/distribution/publish.mjs ');
      if (publisher) {
        publishers++;
        if (step.env?.GH_TOKEN !== '${{ github.token }}' || !step.run?.includes('--source "$GITHUB_SHA" --build-run "$GITHUB_RUN_ID" --github')) throw new Error(`${label}: publisher requires the current workflow actor and source`);
      }
      if (step.with?.token !== undefined || step.env?.NODE_AUTH_TOKEN !== undefined || (!publisher && step.env?.GH_TOKEN !== undefined)) throw new Error(`${label}: unexpected publishing actor`);
      if (/npm publish|changeset publish|gh release|git push|git remote set-url|--npm/.test(step.run ?? '') || (!publisher && /--github/.test(step.run ?? ''))) throw new Error(`${label}: unauthorized publishing or origin URL mutations`);
    }
  }
  if (publishers !== 1) throw new Error(`${label}: one final publisher required`);
  const steps = doc.jobs?.assemble.steps ?? [];
  const signer = steps.findIndex(step => step.run?.includes('cosign sign-blob'));
  const publisher = steps.findIndex(step => step.run?.startsWith('node runtime/distribution/publish.mjs '));
  const signing = steps[signer]?.run ?? '';
  const expectedVerification = `cosign verify-blob --bundle "$bundle/SHA256SUMS.sigstore.json" --certificate-identity 'https://github.com/LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' "$bundle/SHA256SUMS"`;
  if (signer < 0 || signer >= publisher || !signing.split('\n').some(line => line.trim() === expectedVerification) ||
      /--insecure|--ignore-tlog|--ignore-sct/.test(signing)) throw new Error(`${label}: verified main workflow signature required before publication`);
};

