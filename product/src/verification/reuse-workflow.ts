import YAML from 'yaml';
import { ReuseProfileSchema, type ReuseProfile } from './reuse-profile.js';
import { REUSE_IDENTITY_AUDIENCE } from '../providers/gitlab/job-identity.js';

export const REUSE_CI_ENTRY = '.specgit-runtime/node_modules/specgit/dist/cli/verification-ci.js';
const managed = '# Managed by SpecGit: verified-input execution.\n';
const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNode = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const setupPnpm = 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86';
const upload = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const download = 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131';
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const render = (value: unknown) => managed + YAML.stringify(value, { lineWidth: 0 });

function runtimeInstall(profile: ReuseProfile): string[] {
  const runtime = profile.runtime;
  const paths = [runtime.lockfile, ...('archive' in runtime ? [runtime.archive] : [])];
  const commands: string[] = [`node -e "const f=require('node:fs');for(const p of process.argv.slice(1)){const a=p.split('/');for(let i=1;i<=a.length;i++){const s=f.lstatSync(a.slice(0,i).join('/'));if(s.isSymbolicLink()||(i<a.length?!s.isDirectory():!s.isFile()))process.exit(1)}}try{f.lstatSync('.specgit-runtime');process.exit(1)}catch(e){if(e.code!=='ENOENT')throw e}" ${paths.join(' ')}`];
  if ('archive' in runtime) {
    commands.push(`node -e "const f=require('node:fs'),c=require('node:crypto');if(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')!==process.argv[2])process.exit(1)" ${runtime.archive} ${runtime.sha256}`);
  }
  const dependency = 'archive' in runtime ? `file:../${runtime.archive}` : runtime.package.slice('specgit@'.length);
  commands.push(`node -e "const f=require('node:fs');f.mkdirSync('.specgit-runtime');f.writeFileSync('.specgit-runtime/package.json',JSON.stringify({name:'specgit-verification-runtime',private:true,dependencies:{specgit:process.argv[1]}}));f.copyFileSync(process.argv[2],'.specgit-runtime/package-lock.json')" ${dependency} ${runtime.lockfile}`);
  commands.push('npm ci --ignore-scripts --no-audit --no-fund --prefix .specgit-runtime');
  return commands;
}

function githubSetup(profile: ReuseProfile, prepared = false): object[] {
  return [
    { uses: checkout, with: { 'fetch-depth': 0, 'persist-credentials': false,
      ...(prepared ? { ref: '${{ needs.prepare.outputs.checkout_sha }}' } : {}) } },
    { uses: setupNode, with: { 'node-version': profile.node, 'package-manager-cache': false } },
    { uses: setupPnpm, with: { version: profile.pnpm } },
    ...runtimeInstall(profile).map((run) => ({ run })),
  ];
}

/** One fixed workflow per profile; each current run owns its fresh public check. */
export function githubReuseWorkflow(input: ReuseProfile): string {
  const profile = ReuseProfileSchema.parse(input);
  if (!profile.github) throw new Error('A GitHub integration is required');
  const executeJob = (mode: 'execute' | 'reuse') => ({
    name: mode === 'execute' ? '${{ needs.prepare.outputs.job_name }}' : `SpecGit reused / ${profile.id}`,
    'runs-on': profile.github!.runner, needs: ['prepare'], if: `needs.prepare.outputs.mode == '${mode}'`,
    'timeout-minutes': 30,
    steps: [
      ...githubSetup(profile, true),
      { uses: download, with: { name: `specgit-plan-${profile.id}`, path: '.specgit-reuse' } },
      { name: mode === 'execute' ? 'Execute verified inputs and current checks' : 'Reverify original evidence and current checks',
        run: `node ${REUSE_CI_ENTRY} ${mode} ${profile.id}`, env: { GH_TOKEN: '${{ github.token }}' } },
    ],
  });
  return render({
    name: `SpecGit verification / ${profile.id}`,
    on: { pull_request: { types: ['opened', 'synchronize', 'reopened', 'ready_for_review'] }, workflow_dispatch: {} },
    permissions: { contents: 'read', actions: 'read', 'pull-requests': 'read' },
    concurrency: { group: `specgit-verify-${profile.id}-` + '${{ github.ref }}', 'cancel-in-progress': true },
    jobs: {
      prepare: {
        name: `SpecGit prepare / ${profile.id}`, 'runs-on': profile.github.runner, 'timeout-minutes': 10,
        outputs: { mode: '${{ steps.prepare.outputs.mode }}', job_name: '${{ steps.prepare.outputs.job_name }}', checkout_sha: '${{ steps.prepare.outputs.checkout_sha }}' },
        steps: [
          ...githubSetup(profile),
          { id: 'prepare', run: `node ${REUSE_CI_ENTRY} prepare ${profile.id}`, env: { GH_TOKEN: '${{ github.token }}' } },
          { uses: upload, with: { name: `specgit-plan-${profile.id}`, path: '.specgit-reuse/',
            'include-hidden-files': true, 'if-no-files-found': 'error', 'retention-days': 2, overwrite: true } },
        ],
      },
      original: executeJob('execute'), reused: executeJob('reuse'),
      gate: {
        name: profile.check, 'runs-on': 'ubuntu-24.04', needs: ['prepare', 'original', 'reused'], if: 'always()',
        steps: [{ env: { PREPARE: '${{ needs.prepare.result }}', MODE: '${{ needs.prepare.outputs.mode }}',
          ORIGINAL: '${{ needs.original.result }}', REUSED: '${{ needs.reused.result }}' },
        run: `node -e "const e=process.env;if(e.PREPARE!=='success'||!['execute','reuse'].includes(e.MODE)||e.ORIGINAL!==(e.MODE==='execute'?'success':'skipped')||e.REUSED!==(e.MODE==='reuse'?'success':'skipped'))process.exit(1)"` }],
      },
    },
  });
}

function gitlabSetup(profile: ReuseProfile): string[] {
  return [
    ...profile.gitlab!.bootstrap.map((args) => `env -u SPECGIT_REUSE_IDENTITY ${args.map(quote).join(' ')}`),
    `env -u SPECGIT_REUSE_IDENTITY npm install --global --ignore-scripts --no-audit --no-fund pnpm@${profile.pnpm}`,
    ...runtimeInstall(profile).map((command) => `env -u SPECGIT_REUSE_IDENTITY ${command}`),
  ];
}

/** The root has no floating includes; only the approved preparation job supplies its child. */
export function gitlabReuseWorkflow(inputs: ReuseProfile[]): string {
  const profiles = inputs.map((profile) => ReuseProfileSchema.parse(profile)).filter((profile) => profile.gitlab);
  if (!profiles.length || new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error('Distinct GitLab profiles are required');
  const root: Record<string, unknown> = {
    workflow: { rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
      { if: '$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS', when: 'never' }, { if: '$CI_COMMIT_BRANCH' }] },
    stages: ['prepare', 'verify', 'gate', 'acceptance'],
    variables: { GIT_DEPTH: '0', CI_DEBUG_TRACE: 'false', GLAB_ENABLE_CI_AUTOLOGIN: 'true' },
  };
  for (const profile of profiles) {
    const prepare = `SpecGit prepare / ${profile.id}`;
    const bridge = `SpecGit dispatch / ${profile.id}`;
    root[prepare] = {
      stage: 'prepare', image: profile.gitlab!.image, tags: profile.gitlab!.tags, timeout: '10m',
      cache: [], before_script: [], after_script: [],
      id_tokens: { SPECGIT_REUSE_IDENTITY: { aud: REUSE_IDENTITY_AUDIENCE } },
      script: [...gitlabSetup(profile), `node ${REUSE_CI_ENTRY} prepare ${profile.id}`],
      artifacts: { paths: ['.specgit-reuse/'], expire_in: '2 days', access: 'maintainer' },
    };
    root[bridge] = {
      stage: 'verify', needs: [prepare],
      trigger: { include: [{ artifact: '.specgit-reuse/child.yml', job: prepare }], strategy: 'mirror',
        forward: { yaml_variables: false, pipeline_variables: false } },
    };
    root[profile.check] = { stage: 'gate', image: profile.gitlab!.image, tags: profile.gitlab!.tags,
      needs: [bridge], cache: [], before_script: [], after_script: [], script: ['exit 0'] };
  }
  // Current delivery acceptance owns an authenticated checkout, separate from business commands.
  const acceptance = profiles[0];
  root['SpecGit Acceptance'] = {
    stage: 'acceptance', image: acceptance.gitlab!.image, tags: acceptance.gitlab!.tags, timeout: '10m',
    rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
      { if: '$CI_PIPELINE_SOURCE == "web" && $CI_COMMIT_BRANCH' }],
    needs: profiles.map((profile) => ({ job: profile.check, artifacts: false })),
    cache: [], before_script: [], after_script: [],
    script: [...gitlabSetup(acceptance),
      'export SPECGIT_ACCEPT_ROOT="$(mktemp -d)"',
      'mv .specgit-runtime "$SPECGIT_ACCEPT_ROOT/runtime"',
      'export SPECGIT_ACCEPT_RUNTIME="$SPECGIT_ACCEPT_ROOT/runtime/node_modules/specgit"',
      'node .gitlab/specgit-accept.mjs --prepare-gitlab-event',
      'node .gitlab/specgit-accept.mjs',
    ],
  };
  return render(root);
}

export function gitlabReuseChild(input: ReuseProfile, plan: { parentPipeline: string; jobName: string; mode: 'execute' | 'reuse' }): string {
  const profile = ReuseProfileSchema.parse(input);
  if (!profile.gitlab || !/^[1-9][0-9]*$/.test(plan.parentPipeline) ||
      !new RegExp(`^SpecGit (?:original / ${profile.id} / [a-f0-9]{64}|uncached / ${profile.id}|reused / ${profile.id}|not applicable / ${profile.id})$`).test(plan.jobName) ||
      !['execute', 'reuse'].includes(plan.mode)) throw new Error('Invalid native child identity');
  return render({
    workflow: { rules: [{ if: '$CI_PIPELINE_SOURCE == "parent_pipeline"' }] },
    variables: { GIT_DEPTH: '0', CI_DEBUG_TRACE: 'false', GLAB_ENABLE_CI_AUTOLOGIN: 'true' },
    [plan.jobName]: {
      image: profile.gitlab.image, tags: profile.gitlab.tags, timeout: '30m', cache: [], before_script: [], after_script: [],
      needs: [{ pipeline: plan.parentPipeline, job: `SpecGit prepare / ${profile.id}`, artifacts: true }],
      script: [...gitlabSetup(profile), `node ${REUSE_CI_ENTRY} ${plan.mode} ${profile.id}`],
      artifacts: { paths: ['.specgit-reuse/parent.json'], expire_in: '2 days', access: 'maintainer' },
    },
  });
}
