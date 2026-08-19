import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

import { harnessWorkflowYaml } from '../../src/cli/harness-assets.js';

// #66: security invariants for the workflows that execute untrusted code.
// Invariants throw (instead of returning booleans) so the mutation tests
// below can prove each one rejects its known-bad mutant.
//
// Trust boundary: specgit-accept.yml and ci.yml/security.yml run on
// pull_request (fork code included) and workflow_dispatch. The release
// workflow (push-to-main only) checks out trusted refs and is therefore
// exempt from the read-only rules.

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

const readWorkflow = (name: string): string =>
  readFileSync(path.join(WORKFLOWS_DIR, name), 'utf-8').replace(/\r\n/g, '\n');

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  env?: Record<string, unknown>;
}

interface Job {
  if?: string;
  steps?: Step[];
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const allSteps = (doc: Workflow): Step[] =>
  Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);

const cacheSteps = (doc: Workflow): string[] =>
  allSteps(doc)
    .filter((step) => {
      if (typeof step.uses === 'string' && step.uses.startsWith('actions/cache')) return true;
      const cache = step.with?.cache;
      return cache !== undefined && cache !== '' && cache !== 'none';
    })
    .map((step) => step.name ?? step.uses ?? 'unnamed');

// Alerts 7-9 (actions/cache-poisoning/poisonable-step): a job that checks
// out and executes untrusted refs must not write to — or restore from —
// the repository cache, because its steps can poison the cached store
// that trusted contexts then read.
const assertNoCacheMechanism = (text: string, label: string): void => {
  const offenders = cacheSteps(parse(text) as Workflow);
  if (offenders.length > 0) {
    throw new Error(`${label}: cache write/restore in untrusted execution: ${offenders.join(', ')}`);
  }
};

// Untrusted-trigger workflows never need a write-capable GITHUB_TOKEN.
const assertPermissionsReadOnly = (text: string, label: string): void => {
  const permissions = (parse(text) as Workflow).permissions ?? {};
  const nonRead = Object.entries(permissions).filter(([, scope]) => scope !== 'read');
  if (Object.keys(permissions).length === 0 || nonRead.length > 0) {
    throw new Error(`${label}: permissions must exist and be read-only, got ${JSON.stringify(permissions)}`);
  }
};

// Fork pull-request code must never keep git credentials on disk after
// checkout.
const assertPersistCredentialsFalse = (text: string, label: string): void => {
  const offenders = allSteps(parse(text) as Workflow)
    .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'))
    .filter((step) => step.with?.['persist-credentials'] !== false)
    .map((step) => step.name ?? step.uses ?? 'unnamed');
  if (offenders.length > 0) {
    throw new Error(`${label}: checkout without persist-credentials: false: ${offenders.join(', ')}`);
  }
};

// Hardening must not blunt the gate: the acceptance workflow still opens
// pull requests against main, still supports manual dispatch, still
// checks out the PR head branch (the execution-context gate reads live
// git), and still runs the verdict with the run token.
const assertAcceptanceGateSemantics = (text: string, label: string): void => {
  const doc = parse(text) as Workflow;
  const on = doc.on ?? {};
  const pullRequest = on.pull_request as { branches?: string[] } | undefined;
  if (!pullRequest || !Array.isArray(pullRequest.branches) || !pullRequest.branches.includes('main')) {
    throw new Error(`${label}: pull_request -> main trigger missing`);
  }
  if (!('workflow_dispatch' in on)) {
    throw new Error(`${label}: workflow_dispatch trigger missing`);
  }
  const steps = allSteps(doc);
  const finish = steps.find((step) => (step.run ?? '').includes('node bin/specgit.js finish --json'));
  if (!finish) {
    throw new Error(`${label}: specgit finish step missing`);
  }
  const token = finish.env?.GH_TOKEN;
  if (typeof token !== 'string' || !token.includes('github.token')) {
    throw new Error(`${label}: finish step must use GH_TOKEN: \${{ github.token }}`);
  }
  const headCheckout = steps.find(
    (step) => typeof step.with?.ref === 'string' && step.with.ref.includes('github.head_ref'),
  );
  if (!headCheckout) {
    throw new Error(`${label}: head-ref checkout missing (execution-context gate reads live git)`);
  }
};

const normalizeExpr = (expression: string): string => expression.replace(/\s+/g, '');

const SELF_HOSTED_FORK_GUARD =
  "(matrix.label!='self-hosted-linux')||(github.event_name!='pull_request')||(github.event.pull_request.head.repo.full_name==github.repository)";

// The self-hosted shadow runner outlives any single job; fork pull-request
// code must never execute on it. Same-repo pull requests keep proving the
// container; push, merge_group, and dispatch check out trusted refs.
const assertSelfHostedForkGuard = (text: string, label: string): void => {
  const matrix = (parse(text) as Workflow).jobs?.test_matrix;
  if (!matrix) {
    throw new Error(`${label}: test_matrix job missing`);
  }
  const entries = matrix.strategy?.matrix?.include ?? [];
  if (!entries.some((entry) => entry.label === 'self-hosted-linux')) {
    throw new Error(`${label}: self-hosted shadow matrix entry missing`);
  }
  const jobIf = matrix.if;
  if (typeof jobIf !== 'string' || normalizeExpr(jobIf) !== SELF_HOSTED_FORK_GUARD) {
    throw new Error(`${label}: self-hosted leg not fork-guarded (job if: ${String(jobIf)})`);
  }
};

describe('workflow security invariants (#66)', () => {
  const acceptFile = readWorkflow('specgit-accept.yml');
  const acceptTemplate = harnessWorkflowYaml().replace(/\r\n/g, '\n');
  const ciFile = readWorkflow('ci.yml');
  const securityFile = readWorkflow('security.yml');

  it('the untrusted acceptance gate keeps zero cache mechanisms (file and generated template)', () => {
    assertNoCacheMechanism(acceptFile, 'specgit-accept.yml');
    assertNoCacheMechanism(acceptTemplate, 'harnessWorkflowYaml()');
  });

  it('untrusted-trigger workflows grant read-only token scopes', () => {
    const surfaces: Array<[string, string]> = [
      ['specgit-accept.yml', acceptFile],
      ['harnessWorkflowYaml()', acceptTemplate],
      ['ci.yml', ciFile],
      ['security.yml', securityFile],
    ];
    for (const [label, text] of surfaces) {
      assertPermissionsReadOnly(text, label);
    }
  });

  it('untrusted-trigger workflows never persist checkout credentials', () => {
    const surfaces: Array<[string, string]> = [
      ['specgit-accept.yml', acceptFile],
      ['harnessWorkflowYaml()', acceptTemplate],
      ['ci.yml', ciFile],
      ['security.yml', securityFile],
    ];
    for (const [label, text] of surfaces) {
      assertPersistCredentialsFalse(text, label);
    }
  });

  it('acceptance gate semantics survive the hardening (triggers, head-ref checkout, finish, token)', () => {
    assertAcceptanceGateSemantics(acceptFile, 'specgit-accept.yml');
    assertAcceptanceGateSemantics(acceptTemplate, 'harnessWorkflowYaml()');
  });

  it('ci.yml keeps fork pull requests off the self-hosted shadow runner', () => {
    assertSelfHostedForkGuard(ciFile, 'ci.yml');
  });
});

describe('mutation sensitivity: every invariant rejects its known-bad mutant (#66)', () => {
  const acceptFile = readWorkflow('specgit-accept.yml');
  const acceptTemplate = harnessWorkflowYaml().replace(/\r\n/g, '\n');
  const ciFile = readWorkflow('ci.yml');

  it('re-adding cache to the gate is detected (file and generated template)', () => {
    const mutation = "node-version: '20.19.0'\n          cache: 'pnpm'";
    expect(() =>
      assertNoCacheMechanism(acceptFile.replace("node-version: '20.19.0'", mutation), 'mutant'),
    ).toThrow();
    expect(() =>
      assertNoCacheMechanism(acceptTemplate.replace("node-version: '20.19.0'", mutation), 'mutant'),
    ).toThrow();
  });

  it('an actions/cache step in the gate is detected', () => {
    const mutant = acceptFile.replace(
      '      - name: Install dependencies',
      [
        '      - name: Warm the store',
        '        uses: actions/cache/restore@v5',
        '        with:',
        '          path: ~/.local/share/pnpm/store',
        '          key: pnpm-store',
        '      - name: Install dependencies',
      ].join('\n'),
    );
    expect(() => assertNoCacheMechanism(mutant, 'mutant')).toThrow();
  });

  it('write-permission creep is detected', () => {
    const mutant = acceptFile.replace('contents: read', 'contents: write');
    expect(() => assertPermissionsReadOnly(mutant, 'mutant')).toThrow();
  });

  it('persisted checkout credentials are detected', () => {
    const mutant = acceptFile.replace('          persist-credentials: false\n', '');
    expect(() => assertPersistCredentialsFalse(mutant, 'mutant')).toThrow();
  });

  it('removing the head-ref checkout (breaking the gate) is detected', () => {
    const mutant = acceptFile.replace('          ref: ${{ github.head_ref || github.ref }}\n', '');
    expect(() => assertAcceptanceGateSemantics(mutant, 'mutant')).toThrow();
  });

  it('dropping the self-hosted fork guard is detected', () => {
    const guardBlock = [
      '    if: >-',
      "      (matrix.label != 'self-hosted-linux') ||",
      "      (github.event_name != 'pull_request') ||",
      '      (github.event.pull_request.head.repo.full_name == github.repository)',
      '',
    ].join('\n');
    const mutant = ciFile.replace(guardBlock, '    if: true\n');
    expect(mutant).not.toBe(ciFile);
    expect(() => assertSelfHostedForkGuard(mutant, 'mutant')).toThrow();
  });
});
