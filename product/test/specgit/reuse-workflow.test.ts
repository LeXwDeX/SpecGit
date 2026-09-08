import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { githubReuseWorkflow, gitlabReuseWorkflow, gitlabReuseChild } from '../../src/verification/reuse-workflow.js';
import { ReuseProfileSchema } from '../../src/verification/reuse-profile.js';

const profile = ReuseProfileSchema.parse({
  id: 'linux', check: 'Test (linux)', max_age_seconds: 3600, node: '20.19.0', pnpm: '9.15.9',
  runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' }, commands: [['pnpm', 'test']], fresh_commands: [['node', 'ci/current.mjs']],
  github: { runner: 'ubuntu-24.04', entry: '.github/workflows/reuse-linux.yml' },
  gitlab: { image: 'node@sha256:' + 'a'.repeat(64), entry: '.gitlab-ci.yml', tags: ['runner'] },
});

describe('fixed native verification reuse integrations', () => {
  it('always produces a fresh GitHub gate and separates native originals from reuse jobs', () => {
    const text = githubReuseWorkflow(profile);
    const config = YAML.parse(text);
    expect(config.on.pull_request.types).toContain('ready_for_review');
    expect(config.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
    expect(config.jobs.original.if).toContain("== 'execute'");
    expect(config.jobs.reused.if).toContain("== 'reuse'");
    expect(config.jobs.original.name).toContain('needs.prepare.outputs.job_name');
    expect(config.jobs.gate.name).toBe(profile.check);
    expect(config.jobs.gate.if).toBe('always()');
    expect(config.jobs.gate.needs).toEqual(['prepare', 'original', 'reused']);
    expect(text).not.toContain('pull_request_target');
    expect(text).not.toContain('write-all');
    expect(text).not.toContain('secrets: inherit');
    expect(text).toContain('persist-credentials: false');
    expect(text).toContain('include-hidden-files: true');
  });

  it('uses a signed GitLab parent and an artifact-bound child without variable forwarding', () => {
    const config = YAML.parse(gitlabReuseWorkflow([profile]));
    const prepare = config['SpecGit prepare / linux'];
    const bridge = config['SpecGit dispatch / linux'];
    expect(prepare.id_tokens.SPECGIT_REUSE_IDENTITY.aud).toBe('urn:specgit:verification-reuse:v1');
    expect(bridge.trigger.include).toEqual([{ artifact: '.specgit-reuse/child.yml', job: 'SpecGit prepare / linux' }]);
    expect(bridge.trigger.strategy).toBe('mirror');
    expect(bridge.trigger.forward).toEqual({ yaml_variables: false, pipeline_variables: false });
    expect(config[profile.check].needs).toContain('SpecGit dispatch / linux');
    expect(config[profile.check].when).toBeUndefined();
    expect(prepare.artifacts.paths).toContain('.specgit-reuse/');
  });

  it('binds child artifacts to the exact parent pipeline and retains the native original name', () => {
    const name = 'SpecGit original / linux / ' + 'b'.repeat(64);
    const child = YAML.parse(gitlabReuseChild(profile, { parentPipeline: '100', jobName: name, mode: 'execute' }));
    expect(child[name].needs).toEqual([{ pipeline: '100', job: 'SpecGit prepare / linux', artifacts: true }]);
    expect(child[name].script.join('\n')).toContain(' execute linux');
    expect(child[name].id_tokens).toBeUndefined();
    expect(child[name].artifacts.paths).toContain('.specgit-reuse/parent.json');
  });

  it('runs one independent authenticated acceptance after every public verification gate', () => {
    const second = { ...profile, id: 'second', check: 'Test (second)' };
    const config = YAML.parse(gitlabReuseWorkflow([profile, second]));
    const acceptance = config['SpecGit Acceptance'];
    expect(acceptance.stage).toBe('acceptance');
    expect(acceptance.needs).toEqual([
      { job: profile.check, artifacts: false }, { job: second.check, artifacts: false },
    ]);
    expect(acceptance.allow_failure).toBeUndefined();
    expect(acceptance.id_tokens).toBeUndefined();
    expect(acceptance.script.slice(-5)).toEqual([
      'export SPECGIT_ACCEPT_ROOT="$(mktemp -d)"',
      'mv .specgit-runtime "$SPECGIT_ACCEPT_ROOT/runtime"',
      'export SPECGIT_ACCEPT_RUNTIME="$SPECGIT_ACCEPT_ROOT/runtime/node_modules/specgit"',
      'node .gitlab/specgit-accept.mjs --prepare-gitlab-event',
      'node .gitlab/specgit-accept.mjs',
    ]);
    expect(acceptance.script.join('\n')).not.toContain('verification-ci.js execute');
  });

  it('never labels a reuse-only child as a native original', () => {
    const child = YAML.parse(gitlabReuseChild(profile, { parentPipeline: '100', jobName: 'SpecGit reused / linux', mode: 'reuse' }));
    expect(child['SpecGit reused / linux'].script.join('\n')).toContain(' reuse linux');
    expect(Object.keys(child).some((name) => name.startsWith('SpecGit original /'))).toBe(false);
  });
});
