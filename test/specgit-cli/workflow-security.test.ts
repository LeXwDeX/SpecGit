import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

import { harnessWorkflowYaml } from '../../src/cli/harness-content.js';

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
  name?: string;
  'runs-on'?: string | string[];
  'continue-on-error'?: boolean | string;
  needs?: string[];
  if?: string;
  steps?: Step[];
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, Job>;
}

const allSteps = (doc: Workflow): Step[] =>
  Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);

const cacheSteps = (doc: Workflow): string[] =>
  allSteps(doc)
    .filter((step) => {
      if (typeof step.uses === 'string' && step.uses.startsWith('actions/cache')) return true;
      // setup-node also infers npm caching from package.json, which is
      // controlled by the checked-out candidate even without a cache input.
      if (step.uses?.startsWith('actions/setup-node') && step.with?.['package-manager-cache'] !== false) return true;
      const cache = step.with?.cache;
      return cache !== undefined && cache !== false && cache !== 'false' && cache !== '' && cache !== 'none';
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
  const pullRequest = on.pull_request as { branches?: string[]; types?: string[] } | undefined;
  if (!pullRequest || !Array.isArray(pullRequest.branches) || !pullRequest.branches.includes('main')) {
    throw new Error(`${label}: pull_request -> main trigger missing`);
  }
  // #122: a draft PR fails the verdict (pr_draft), so the draft→ready
  // transition must re-verdict. `types` replaces the defaults, so the
  // default activity types must be listed alongside ready_for_review.
  const requiredTypes = ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited'];
  if (
    !Array.isArray(pullRequest.types) ||
    !requiredTypes.every((t) => pullRequest.types!.includes(t))
  ) {
    throw new Error(
      `${label}: pull_request types must include ${requiredTypes.join(', ')} (a draft→ready transition must re-verdict)`
    );
  }
  if (!('workflow_dispatch' in on)) {
    throw new Error(`${label}: workflow_dispatch trigger missing`);
  }
  const steps = allSteps(doc);
  const finishes = steps.filter((step) => (step.run ?? '').includes('finish --json'));
  if (finishes.length === 0) {
    throw new Error(`${label}: specgit finish step missing`);
  }
  for (const finish of finishes) {
    const token = finish.env?.GH_TOKEN;
    if (typeof token !== 'string' || !token.includes('github.token')) {
      throw new Error(`${label}: finish step must use GH_TOKEN: \${{ github.token }}`);
    }
  }
  const headCheckout = steps.find(
    (step) => typeof step.with?.ref === 'string' && step.with.ref.includes('github.head_ref'),
  );
  if (!headCheckout) {
    throw new Error(`${label}: head-ref checkout missing (execution-context gate reads live git)`);
  }
};

const REQUIRED_MATRIX_LABELS = ['linux-bash', 'macos-bash', 'windows-pwsh'];

// #105: the self-hosted shadow leg is RETIRED (W2 retirement line,
// 2026-08-21). It was never green — every execution since introduction
// crashed at job initialization with zero steps run (the runner
// container cannot create its tool-cache directory; infrastructure-side,
// not repo-fixable per the W1 diagnosis on the issue), and the repair
// window closed without a runner-owner fix. Self-hosted coverage is not
// part of the release matrix; re-introducing self-hosted execution
// requires repairing the runner infrastructure first and updating this
// invariant with a recorded rationale on the tracker.
const assertNoSelfHostedExecution = (text: string, label: string): void => {
  const jobs = (parse(text) as Workflow).jobs ?? {};
  const matrixJob = jobs.test_matrix;
  if (!matrixJob) {
    throw new Error(`${label}: test_matrix job missing`);
  }
  const entries = matrixJob.strategy?.matrix?.include ?? [];
  const labels = entries.map((entry) => String(entry.label));
  for (const entry of entries) {
    const os = Array.isArray(entry.os) ? entry.os : [entry.os];
    if (os.includes('self-hosted') || String(entry.label) === 'self-hosted-linux') {
      throw new Error(`${label}: self-hosted entry must not ride the required test_matrix (retired; #105)`);
    }
  }
  for (const required of REQUIRED_MATRIX_LABELS) {
    if (!labels.includes(required)) {
      throw new Error(`${label}: required matrix label missing: ${required}`);
    }
  }
  for (const [jobId, job] of Object.entries(jobs)) {
    const runsOn = Array.isArray(job['runs-on']) ? job['runs-on'] : [job['runs-on']];
    if (runsOn.includes('self-hosted')) {
      throw new Error(`${label}: job "${jobId}" runs on the retired self-hosted pool (#105)`);
    }
  }
};

// GitHub evaluates a job-level `if` with only the github, needs, vars,
// and inputs contexts available (the same table actionlint enforces).
// matrix, steps, env, runner, job, secrets, ... are step-level only:
// referencing them at job level silently evaluates to null/false and has
// already wedged a required gate (rejected HEAD 50d9ea9 used
// `matrix.label` in test_matrix's job-level if). (#69)
const JOB_IF_LEGAL_CONTEXTS = new Set(['github', 'needs', 'vars', 'inputs']);

const contextsUsedInExpr = (expression: string): string[] => {
  // Strip quoted string literals first: dots inside them are not context refs.
  const stripped = expression.replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set<string>();
  for (const match of stripped.matchAll(/(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\./g)) {
    found.add(match[1]);
  }
  return [...found];
};

const assertJobIfUsesLegalContexts = (text: string, label: string): void => {
  const jobs = (parse(text) as Workflow).jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (typeof job.if !== 'string') continue;
    const illegal = contextsUsedInExpr(job.if).filter((ctx) => !JOB_IF_LEGAL_CONTEXTS.has(ctx));
    if (illegal.length > 0) {
      throw new Error(
        `${label}: job "${jobId}" if uses contexts illegal at job level (${illegal.join(', ')}); only github, needs, vars, inputs are available there`,
      );
    }
  }
};

// The acceptance gate waits for exactly the names in spec_git/policy.yaml;
// every one of them must still be produced by a ci.yml job (a matrix label
// contributes "Test (<label>)", every other job its literal name). (#69)
const assertRequiredChecksDerivable = (ciText: string, policyText: string, label: string): void => {
  const doc = parse(ciText) as Workflow;
  const produced = new Set<string>();
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    if (jobId === 'test_matrix') {
      for (const entry of job.strategy?.matrix?.include ?? []) {
        produced.add(`Test (${String(entry.label)})`);
      }
    } else if (typeof job.name === 'string') {
      produced.add(job.name);
    }
  }
  const policy = parse(policyText) as { required_checks?: string[] };
  const required = policy.required_checks ?? [];
  if (required.length === 0) {
    throw new Error(`${label}: policy declares no required checks`);
  }
  for (const name of required) {
    if (!produced.has(name)) {
      throw new Error(`${label}: required check "${name}" is not produced by any ci.yml job`);
    }
  }
};

// The OIDC response JSON embeds the raw JWT — a short-lived bearer
// credential for the npm audience. Anyone who can read the run log
// (fork PR authors included) must never see it: the response goes
// straight to a file, and only derived claims or the token length are
// logged. (#71 follow-up)
const assertOidcTokenNeverLogged = (text: string, label: string): void => {
  const steps = allSteps(parse(text) as Workflow).filter((step) =>
    (step.run ?? '').includes('ACTIONS_ID_TOKEN_REQUEST'),
  );
  if (steps.length === 0) {
    throw new Error(`${label}: OIDC audience probe step missing`);
  }
  for (const step of steps) {
    const run = step.run ?? '';
    const stepName = step.name ?? 'unnamed';
    if (/\btee\b/.test(run)) {
      throw new Error(`${label}: "${stepName}" pipes the OIDC response through tee — the raw JWT would land in the log`);
    }
    if (/console\.(log|info|warn|error)\(\s*value\s*\)/.test(run)) {
      throw new Error(`${label}: "${stepName}" prints the raw OIDC token value`);
    }
    if (!/value\.length/.test(run) || !/claims\.aud/.test(run)) {
      throw new Error(`${label}: "${stepName}" must log only safe derived claims or the token length`);
    }
  }
};

describe('workflow security invariants (#66, #69, #71)', () => {
  const acceptFile = readWorkflow('specgit-accept.yml');
  const acceptTemplate = harnessWorkflowYaml().replace(/\r\n/g, '\n');
  const ciFile = readWorkflow('ci.yml');
  const securityFile = readWorkflow('security.yml');
  const rcVerifyFile = readWorkflow('rc-verify.yml');
  const policyFile = readFileSync(path.join(__dirname, '..', '..', 'spec_git', 'policy.yaml'), 'utf-8');
  const workflowFiles = readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => [name, readWorkflow(name)] as [string, string]);

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

  it('the product CI re-verdicts on the draft→ready transition (#316)', () => {
    // The required checks come from ci.yml; without ready_for_review in
    // its pull_request types a delivery marked ready would wait forever
    // for post-transition runs that no event ever creates.
    const types = ((parse(ciFile) as Workflow).on?.pull_request as { types?: string[] }).types ?? [];
    for (const required of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
      expect(types).toContain(required);
    }
  });

  it('superseded acceptance runs cancel via a concurrency group (#319)', () => {
    for (const [label, text] of [
      ['specgit-accept.yml', acceptFile],
      ['harnessWorkflowYaml()', acceptTemplate],
    ] as Array<[string, string]>) {
      const concurrency = (parse(text) as Workflow).concurrency;
      expect(concurrency?.group, label).toBe('specgit-accept-${{ github.ref }}');
      expect(concurrency?.['cancel-in-progress'], label).toBe(true);
    }
  });

  it('ci.yml executes no self-hosted legs (retired shadow job; #105)', () => {
    assertNoSelfHostedExecution(ciFile, 'ci.yml');
  });

  it('every job-level if uses only job-level-legal contexts (github, needs, vars, inputs)', () => {
    for (const [name, text] of workflowFiles) {
      assertJobIfUsesLegalContexts(text, name);
    }
  });

  it('every required check name in the policy is still produced by ci.yml', () => {
    assertRequiredChecksDerivable(ciFile, policyFile, 'policy→ci.yml');
  });

  it('rc-verify.yml never logs the raw OIDC token (derived claims or length only)', () => {
    assertOidcTokenNeverLogged(rcVerifyFile, 'rc-verify.yml');
  });
});

describe('mutation sensitivity: every invariant rejects its known-bad mutant (#66, #69, #71)', () => {
  const acceptFile = readWorkflow('specgit-accept.yml');
  const acceptTemplate = harnessWorkflowYaml().replace(/\r\n/g, '\n');
  const ciFile = readWorkflow('ci.yml');
  const rcVerifyFile = readWorkflow('rc-verify.yml');

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
    const anchor = '      - name: Install classifier dependencies';
    expect(acceptFile).toContain(anchor);
    const mutant = acceptFile.replace(
      anchor,
      [
        '      - name: Warm the store',
        '        uses: actions/cache/restore@v5',
        '        with:',
        '          path: ~/.local/share/pnpm/store',
        '          key: pnpm-store',
        anchor,
      ].join('\n'),
    );
    expect(mutant).not.toBe(acceptFile);
    expect(() => assertNoCacheMechanism(mutant, 'mutant')).toThrow();
  });

  it('implicit npm cache inferred from candidate package metadata is detected', () => {
    for (const text of [acceptFile, acceptTemplate]) {
      const mutant = text.replace('          package-manager-cache: false\n', '');
      expect(mutant).not.toBe(text);
      expect(() => assertNoCacheMechanism(mutant, 'mutant')).toThrow();
    }
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

  it('dropping ready_for_review from the accept trigger (breaking draft re-verdict) is detected', () => {
    const mutant = acceptFile.replace(
      /    types: \[[^\n]+\]\n/,
      ''
    );
    expect(mutant).not.toBe(acceptFile);
    expect(() => assertAcceptanceGateSemantics(mutant, 'mutant')).toThrow(/ready_for_review/);
  });

  it('dropping edited from the acceptance trigger is detected', () => {
    const mutant = acceptTemplate.replace(', edited]', ']');
    expect(mutant).not.toBe(acceptTemplate);
    expect(() => assertAcceptanceGateSemantics(mutant, 'mutant')).toThrow(/edited/);
  });

  it('removing the trusted metadata verdict token is detected', () => {
    const mutant = acceptTemplate.replace(
      /(- name: specgit finish with trusted CLI[\s\S]*?env:\n)          GH_TOKEN: [^\n]+/,
      '$1          GH_TOKEN: missing',
    );
    expect(mutant).not.toBe(acceptTemplate);
    expect(() => assertAcceptanceGateSemantics(mutant, 'mutant')).toThrow(/GH_TOKEN/);
  });

  it('re-merging the self-hosted leg into the required matrix is detected', () => {
    const mutant = ciFile.replace(
      [
        '    strategy:',
        '      fail-fast: false',
        '      matrix:',
        '        include:',
      ].join('\n'),
      [
        '    strategy:',
        '      fail-fast: false',
        '      matrix:',
        '        include:',
        '          - os: [self-hosted, Linux, X64]',
        '            shell: bash',
        '            label: self-hosted-linux',
      ].join('\n'),
    );
    expect(mutant).not.toBe(ciFile);
    expect(() => assertNoSelfHostedExecution(mutant, 'mutant')).toThrow(/must not ride/);
  });

  it('re-adding the retired self-hosted shadow job is detected (#105)', () => {
    const mutant = ciFile.replace(
      '  lint:',
      [
        '  test_selfhosted:',
        '    name: Test (self-hosted-linux)',
        '    runs-on: [self-hosted, Linux, X64]',
        '    continue-on-error: true',
        '    steps:',
        '      - name: Checkout code',
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '  lint:',
      ].join('\n'),
    );
    expect(mutant).not.toBe(ciFile);
    expect(() => assertNoSelfHostedExecution(mutant, 'mutant')).toThrow(/retired self-hosted pool/);
  });

  it('the rejected 50d9ea9 shape — matrix context in a job-level if — is detected', () => {
    const matrixMutant = ciFile.replace(
      "    if: needs.changes.outputs.nix == 'true'",
      "    if: matrix.label != 'self-hosted-linux'",
    );
    expect(matrixMutant).not.toBe(ciFile);
    expect(() => assertJobIfUsesLegalContexts(matrixMutant, 'mutant')).toThrow(/matrix/);
    const envMutant = ciFile.replace(
      "    name: Lint & Type Check\n    runs-on: ubuntu-latest\n    needs: changes\n    if: needs.changes.outputs.build == 'true'",
      "    name: Lint & Type Check\n    runs-on: ubuntu-latest\n    needs: changes\n    if: env.LINT_SKIP != '1'",
    );
    expect(envMutant).not.toBe(ciFile);
    expect(() => assertJobIfUsesLegalContexts(envMutant, 'mutant')).toThrow(/env/);
    const stepsMutant = ciFile.replace(
      "    name: Lint & Type Check\n    runs-on: ubuntu-latest\n    needs: changes\n    if: needs.changes.outputs.build == 'true'",
      "    name: Lint & Type Check\n    runs-on: ubuntu-latest\n    needs: changes\n    if: steps.setup.outputs.ok == 'true'",
    );
    expect(stepsMutant).not.toBe(ciFile);
    expect(() => assertJobIfUsesLegalContexts(stepsMutant, 'mutant')).toThrow(/steps/);
  });

  it('renaming a required check out of existence is detected', () => {
    const summary = ciFile.replace('name: Required verification', 'name: Verification');
    expect(summary).not.toBe(ciFile);
    expect(() => assertRequiredChecksDerivable(summary, 'required_checks: [Required verification]', 'mutant')).toThrow(/Required verification/);
    // A configured legacy policy still needs its exact names during migration.
    const legacyPolicy = 'required_checks: [Test (macos-bash), Lint & Type Check]';
    const mutant = ciFile.replace('label: macos-bash', 'label: macos');
    expect(mutant).not.toBe(ciFile);
    expect(() => assertRequiredChecksDerivable(mutant, legacyPolicy, 'mutant')).toThrow(
      /Test \(macos-bash\)/,
    );
    const renamedLint = ciFile.replace('name: Lint & Type Check', 'name: Lint');
    expect(renamedLint).not.toBe(ciFile);
    expect(() => assertRequiredChecksDerivable(renamedLint, legacyPolicy, 'mutant')).toThrow(
      /Lint & Type Check/,
    );
  });

  it('tee-ing the OIDC response (or printing the raw token) back into the log is detected', () => {
    const teeMutant = rcVerifyFile.replace(
      '"${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npmjs.org" > oidc.json',
      '"${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npmjs.org" | tee oidc.json',
    );
    expect(teeMutant).not.toBe(rcVerifyFile);
    expect(() => assertOidcTokenNeverLogged(teeMutant, 'mutant')).toThrow(/tee/);
    const rawValueMutant = rcVerifyFile.replace('${value.length} chars', 'value');
    expect(rawValueMutant).not.toBe(rcVerifyFile);
    expect(() => assertOidcTokenNeverLogged(rawValueMutant, 'mutant')).toThrow();
  });
});
