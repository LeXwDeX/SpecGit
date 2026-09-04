import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyPaths } from '../scripts/ci-change-scope.mjs';

// #370 — pnpm reports the package.json `pnpm` field as no longer read
// (the wrapper-generation engines print the ignored-keys warning on every
// command). The repository's verified configuration home is
// pnpm-workspace.yaml:
//   - `overrides`   — the settings home for the security pins since pnpm 10
//                     (GHSA-5p4m-2wfm-xmqj js-yaml, GHSA-2v37-7h3g-55p8
//                     nanoid, brace-expansion, postcss). The pinned
//                     9.15.9 engine does not read settings from this file
//                     (verified empirically), so the lockfile carries no
//                     overrides section — its resolutions ARE the pinned
//                     versions — and a settings-vs-lockfile mismatch would
//                     otherwise break every `pnpm install --frozen-lockfile`
//                     (the command CI runs) with
//                     ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
//   - `allowBuilds` — the build-approval map, added in pnpm 10.26.0;
//                     inert but tolerated on the pinned 9.15.9 engine
//                     (verified: unknown workspace keys do not error).
//                     Entries name the exact locked version — never guess
//                     a new entry without verifying the pnpm docs for the
//                     running engine.
const projectRoot = process.cwd();

/** The security overrides, declared for every engine that reads the workspace settings home. */
const SECURITY_OVERRIDES = {
  'brace-expansion@<=5.0.8': '>=5.0.9 <6',
  'postcss@<8.5.23': '>=8.5.23 <9',
  'js-yaml@>=3.0.0 <3.15.1': '>=3.15.1 <4',
  'js-yaml@>=4.0.0 <4.3.1': '>=4.3.1 <5',
  'nanoid@<3.3.17': '>=3.3.17 <4',
};

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function readYaml(relativePath: string): Record<string, any> {
  return parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

describe('pnpm workspace configuration', () => {
  it('keeps build approval and security overrides in the verified workspace home', () => {
    const packageJson = readJson('package.json');
    const lockfile = readYaml('pnpm-lock.yaml');
    const workspace = readYaml('pnpm-workspace.yaml');
    const esbuildVersions = Object.keys(lockfile.packages)
      .filter((key) => key.startsWith('esbuild@'))
      .map((key) => key.slice('esbuild@'.length));

    // The retired package.json home must stay retired: its presence makes
    // wrapper-generation pnpm print an ignored-configuration warning on
    // every repository command (#370 acceptance).
    expect(packageJson.pnpm).toBeUndefined();
    expect(workspace.packages).toEqual(['.']);
    expect(esbuildVersions).toHaveLength(1);
    expect(workspace.allowBuilds).toEqual({
      [`esbuild@${esbuildVersions[0]}`]: true,
    });
    expect(workspace.overrides).toEqual(SECURITY_OVERRIDES);
    // The lockfile must agree with the (now empty) settings overrides:
    // a recorded section the settings no longer name fails every frozen
    // install with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. The pinned
    // resolutions stay materialized in the lockfile.
    expect(lockfile.overrides).toBeUndefined();
    expect(JSON.stringify(lockfile)).toContain('js-yaml@3.15.1');
    // 3.3.17 was skipped on the registry; the pin materialized as 3.3.18.
    expect(JSON.stringify(lockfile)).toContain('nanoid@3.3.18');
  });

  it('includes install policy changes in Nix and security validation', () => {
    const flake = fs.readFileSync(path.join(projectRoot, 'flake.nix'), 'utf8');
    const ci = fs.readFileSync(path.join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
    const security = fs.readFileSync(
      path.join(projectRoot, '.github/workflows/security.yml'),
      'utf8'
    );

    expect(flake).toContain('./pnpm-workspace.yaml');
    expect(classifyPaths(['pnpm-workspace.yaml'])).toMatchObject({ build: true, nix: true, dependencies: true });
    expect(ci).toContain('node scripts/ci-change-scope.mjs');
    expect(security).toContain('node scripts/ci-change-scope.mjs');
  });
});
