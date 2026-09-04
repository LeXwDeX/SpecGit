import { isAutomationTargetBranch } from '../record/policy.js';

export const COMPLETION_WORKFLOW_PATH = '.github/workflows/specgit-complete.yml';
export const GITLAB_COMPLETION_WORKFLOW_PATH = '.gitlab/specgit-complete.yml';
export const COMPLETION_CHECK_NAME = 'SpecGit Completion';

export interface CompletionWorkflowInput {
  defaultBranch: string;
  version: string;
  selfHosted: boolean;
  platform?: 'github' | 'gitlab';
}

/** Trusted continuation: request code is data; all executable bytes come from approved runtime sources. */
export function completionWorkflowYaml(input: CompletionWorkflowInput): string {
  if (!isAutomationTargetBranch(input.defaultBranch) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(input.version)) {
    throw new Error('Completion requires a default branch and an exact runtime version.');
  }
  if (input.platform === 'gitlab') return gitlabCompletionWorkflow(input);
  return `# Managed by SpecGit: trusted delivery completion.
name: SpecGit Completion

on:
  workflow_run:
    workflows: [SpecGit Acceptance]
    types: [completed]
  workflow_dispatch:
    inputs:
      pr:
        description: 'Bound pull request to recover'
        required: true
        type: string
      head:
        description: 'Exact current pull request head SHA'
        required: true
        type: string

permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: read

jobs:
  identify:
    if: github.ref == 'refs/heads/${input.defaultBranch.replace(/'/g, "''")}'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      pr: \${{ steps.request.outputs.pr }}
      head: \${{ steps.request.outputs.head }}
    steps:
      - name: Resolve one current request
        id: request
        env:
          GH_TOKEN: \${{ github.token }}
          REQUEST_PR: \${{ inputs.pr }}
          REQUEST_HEAD: \${{ inputs.head }}
        run: |
          node --input-type=module <<'NODE'
          import { execFileSync } from 'node:child_process';
          import { readFileSync, appendFileSync } from 'node:fs';
          const run = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
          const head = run?.head_sha || process.env.REQUEST_HEAD;
          let number = process.env.REQUEST_PR || run?.pull_requests?.[0]?.number;
          const query = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
          if (!number) {
            if (typeof run?.head_branch !== 'string') throw new Error('Missing triggering branch.');
            const matches = query(['pr', 'list', '--repo', process.env.GITHUB_REPOSITORY, '--state', 'all', '--head', run.head_branch, '--limit', '100', '--json', 'number,headRefOid']).filter((pr) => pr.headRefOid === head);
            if (matches.length !== 1) throw new Error('The event must identify exactly one current request.');
            number = matches[0].number;
          }
          if (!/^[1-9][0-9]*$/.test(String(number)) || !/^[a-f0-9]{40}$/i.test(head || '')) throw new Error('Invalid request identity.');
          const current = query(['pr', 'view', String(number), '--repo', process.env.GITHUB_REPOSITORY, '--json', 'number,headRefOid']);
          if (current.headRefOid !== head) throw new Error('Stale completion event.');
          appendFileSync(process.env.GITHUB_OUTPUT, 'pr=' + current.number + '\\nhead=' + head + '\\n');
          NODE
  complete:
    needs: identify
    name: SpecGit Completion
    if: github.ref == 'refs/heads/${input.defaultBranch.replace(/'/g, "''")}'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: specgit-complete-\${{ github.repository }}-\${{ needs.identify.outputs.pr }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
          path: specgit-data
${input.selfHosted ? `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          persist-credentials: false
          path: specgit-runtime
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6
        with:
          package_json_file: specgit-runtime/package.json
` : ''}      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '24'
      - name: Prepare authenticated git reads
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh auth setup-git
${input.selfHosted ? `      - name: Install trusted classifier dependencies without lifecycle scripts
        working-directory: specgit-runtime
        run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Classify the request using approved source
        id: scope
        working-directory: specgit-data
        env:
          REQUEST_HEAD: \${{ needs.identify.outputs.head }}
        run: |
          git cat-file -e "$REQUEST_HEAD^{commit}"
          BASE=$(git merge-base HEAD "$REQUEST_HEAD")
          node ../specgit-runtime/scripts/ci-change-scope.mjs --base "$BASE" --head "$REQUEST_HEAD"
` : ''}      - name: Select a compatible trusted runtime
        id: runtime
        env:
          PRODUCT_CHANGE: ${input.selfHosted ? "${{ steps.scope.outputs.build || 'false' }}" : "'false'"}
        run: |
          node --input-type=module <<'NODE'
          import { execFileSync } from 'node:child_process';
          import { appendFileSync } from 'node:fs';
          import { pathToFileURL } from 'node:url';
          const prefix = process.env.RUNNER_TEMP + '/specgit-runtime';
          let directory = prefix + '/node_modules/specgit';
          try {
            execFileSync('npm', ['install', '--prefix', prefix, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', 'specgit@${input.version}'], { stdio: 'inherit' });
            const runtime = await import(pathToFileURL(directory + '/dist/automation/remote-delivery.js').href);
            if (runtime.REMOTE_DELIVERY_PROTOCOL !== 1) throw new Error('Incompatible completion runtime.');
          } catch (error) {
${input.selfHosted ? `            if (process.env.PRODUCT_CHANGE !== 'true') throw new Error('runtime_upgrade_required: publish the compatible runtime before completing metadata changes.');
            directory = process.env.GITHUB_WORKSPACE + '/specgit-runtime';
            execFileSync('pnpm', ['run', 'build'], { cwd: directory, stdio: 'inherit' });
            const runtime = await import(pathToFileURL(directory + '/dist/automation/remote-delivery.js').href);
            if (runtime.REMOTE_DELIVERY_PROTOCOL !== 1) throw new Error('The approved source lacks completion protocol 1.');
` : `            throw error;
`}          }
          appendFileSync(process.env.GITHUB_OUTPUT, 'directory=' + directory + '\\n');
          NODE
      - name: Complete the bound delivery
        env:
          GH_TOKEN: \${{ github.token }}
          SPECGIT_DATA_ROOT: \${{ github.workspace }}/specgit-data
          SPECGIT_PR: \${{ needs.identify.outputs.pr }}
          SPECGIT_HEAD: \${{ needs.identify.outputs.head }}
          SPECGIT_RUNTIME: \${{ steps.runtime.outputs.directory }}
        run: node "$SPECGIT_RUNTIME/dist/automation/remote-entry.js"
`;
}

function gitlabCompletionWorkflow(input: CompletionWorkflowInput): string {
  return `# Managed by SpecGit: include in a trusted default-branch pipeline.
# Trigger this independent pipeline with SPECGIT_PR and SPECGIT_HEAD after MR CI completes.
# The runner must provide authenticated glab and git; no MR scripts run in this job.
specgit-complete:
  stage: .post
  resource_group: specgit-complete-$SPECGIT_PR
  variables:
    GIT_DEPTH: '0'
    SPECGIT_DATA_ROOT: '$CI_PROJECT_DIR'
  rules:
    - if: '$CI_COMMIT_BRANCH == ${JSON.stringify(input.defaultBranch)} && $SPECGIT_PR && $SPECGIT_HEAD && ($CI_PIPELINE_SOURCE == "pipeline" || $CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api")'
    - when: never
  script:
    - npm install --prefix "$CI_PROJECT_DIR/../specgit-runtime" --no-save --ignore-scripts --no-audit --no-fund specgit@${input.version}
    - node --input-type=module -e 'const r=await import(process.env.CI_PROJECT_DIR+"/../specgit-runtime/node_modules/specgit/dist/automation/remote-delivery.js");if(r.REMOTE_DELIVERY_PROTOCOL!==1)throw new Error("runtime_upgrade_required")'
    - node "$CI_PROJECT_DIR/../specgit-runtime/node_modules/specgit/dist/automation/remote-entry.js"
`;
}
