import { isAutomationTargetBranch } from '../record/policy.js';

export const COMPLETION_WORKFLOW_PATH = '.github/workflows/specgit-complete.yml';
export const GITLAB_COMPLETION_WORKFLOW_PATH = '.gitlab/specgit-complete.yml';
export const GITLAB_BUSINESS_WORKFLOW_PATH = '.gitlab/specgit-business.yml';
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
${input.selfHosted ? `    # The source repository's version proposal is not a bound delivery.
    branches-ignore: [changeset-release/main]
` : ''}  workflow_dispatch:
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
  contents: read

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
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read
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
          GH_TOKEN: \${{ github.token }}
          REQUEST_PR: \${{ needs.identify.outputs.pr }}
          REQUEST_HEAD: \${{ needs.identify.outputs.head }}
        run: |
          node --input-type=module <<'NODE'
          import { execFileSync } from 'node:child_process';
          import { appendFileSync } from 'node:fs';
          import { classifyEntries } from '../specgit-runtime/scripts/ci-change-scope.mjs';
          const repo = process.env.GITHUB_REPOSITORY;
          const number = Number(process.env.REQUEST_PR);
          const head = process.env.REQUEST_HEAD;
          const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
          if (!/^[\\w.-]+\\/[\\w.-]+$/.test(repo || '') || !Number.isSafeInteger(number) || number <= 0 || !sha(head)) throw new Error('Invalid request identity.');
          const endpoint = 'repos/' + repo + '/pulls/' + number;
          const query = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
          const readRequest = () => {
            const request = query(endpoint);
            if (request?.number !== number || request.head?.sha !== head || !sha(request.base?.sha)) throw new Error('The request identity or base changed.');
            if (!Number.isSafeInteger(request.changed_files) || request.changed_files < 0 || request.changed_files > 3000) throw new Error('The complete request file count is unavailable or exceeds the GitHub API limit.');
            return request;
          };
          const before = readRequest();
          const entries = [];
          const seen = new Set();
          const validPath = (value) => typeof value === 'string' && value.length > 0 && !/[\\\\\\p{Cc}]/u.test(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
          for (let page = 1; page <= 30; page++) {
            const files = query(endpoint + '/files?per_page=100&page=' + page);
            if (!Array.isArray(files) || files.length > 100) throw new Error('The request file page is invalid.');
            for (const file of files) {
              if (!validPath(file?.filename) || seen.has(file.filename) || !['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status)) throw new Error('The request file evidence is invalid or repeated.');
              seen.add(file.filename);
              if (file.status === 'renamed') {
                if (!validPath(file.previous_filename) || file.previous_filename === file.filename) throw new Error('The renamed request file has no original path.');
                entries.push({ status: 'D', path: file.previous_filename });
              }
              entries.push({ status: file.status === 'removed' ? 'D' : 'M', path: file.filename });
            }
            if (seen.size > before.changed_files) throw new Error('The request file count changed during pagination.');
            if (files.length < 100) break;
          }
          const after = readRequest();
          if (after.base.sha !== before.base.sha || after.changed_files !== before.changed_files || seen.size !== before.changed_files) throw new Error('The request file evidence changed or is incomplete.');
          const scope = classifyEntries(entries);
          appendFileSync(process.env.GITHUB_OUTPUT, 'build=' + scope.build + '\\n');
          NODE
` : ''}      - name: Select a compatible trusted runtime
        id: runtime
        env:
          PRODUCT_CHANGE: ${input.selfHosted ? "${{ steps.scope.outputs.build || 'false' }}" : "'false'"}
        run: |
          node --input-type=module <<'NODE'
          import { execFileSync } from 'node:child_process';
          import { appendFileSync${input.selfHosted ? ', readFileSync' : ''} } from 'node:fs';
          import { pathToFileURL } from 'node:url';
          const prefix = process.env.RUNNER_TEMP + '/specgit-runtime';
          let directory = prefix + '/node_modules/specgit';
${input.selfHosted ? `          const version = JSON.parse(readFileSync(process.env.GITHUB_WORKSPACE + '/specgit-runtime/package.json', 'utf8')).version;
          if (typeof version !== 'string' || !/^\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?(?:\\+[\\w.-]+)?$/.test(version)) throw new Error('The approved source has no exact runtime version.');
` : ''}          const packageSpec = ${input.selfHosted ? "'specgit@' + version" : JSON.stringify(`specgit@${input.version}`)};
          try {
            execFileSync('npm', ['install', '--prefix', prefix, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', packageSpec], { stdio: 'inherit' });
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
          GH_TOKEN: ${input.selfHosted ? '${{ secrets.RELEASE_BOT_TOKEN || github.token }}' : '${{ github.token }}'}
          SPECGIT_DATA_ROOT: \${{ github.workspace }}/specgit-data
          SPECGIT_PR: \${{ needs.identify.outputs.pr }}
          SPECGIT_HEAD: \${{ needs.identify.outputs.head }}
          SPECGIT_RUNTIME: \${{ steps.runtime.outputs.directory }}
        run: node "$SPECGIT_RUNTIME/dist/automation/remote-entry.js"
`;
}

function gitlabCompletionCondition(input: CompletionWorkflowInput): string {
  if (!isAutomationTargetBranch(input.defaultBranch)) throw new Error('Completion requires a valid default branch.');
  return `$CI_COMMIT_BRANCH == ${JSON.stringify(input.defaultBranch)} && $CI_PIPELINE_SOURCE == "pipeline" && $SPECGIT_SOURCE_PROJECT == $CI_PROJECT_ID && $SPECGIT_SOURCE_PIPELINE && $SPECGIT_PR && $SPECGIT_HEAD`;
}

/** Ordinary pipelines retain the project's original configuration and execution semantics. */
export function gitlabRoutingWorkflowYaml(input: CompletionWorkflowInput): string {
  const condition = gitlabCompletionCondition(input).replace(/'/g, "''");
  return `# Managed by SpecGit: isolated GitLab routing.
include:
  - local: /${GITLAB_BUSINESS_WORKFLOW_PATH}
    rules:
      - if: '${condition}'
        when: never
      - when: always
  - local: /${GITLAB_COMPLETION_WORKFLOW_PATH}
    rules:
      - if: '${condition}'

specgit-request-completion:
  stage: .post
  inherit:
    default: false
    variables: false
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
      when: always
    - when: never
  variables:
    SPECGIT_PR: '$CI_MERGE_REQUEST_IID'
    SPECGIT_HEAD: '$CI_COMMIT_SHA'
    SPECGIT_SOURCE_PROJECT: '$CI_PROJECT_ID'
    SPECGIT_SOURCE_PIPELINE: '$CI_PIPELINE_ID'
  trigger:
    project: '$CI_PROJECT_PATH'
    branch: ${JSON.stringify(input.defaultBranch)}
    forward:
      yaml_variables: true
      pipeline_variables: false
`;
}

function gitlabCompletionWorkflow(input: CompletionWorkflowInput): string {
  return `# Managed by SpecGit: include in a trusted default-branch pipeline.
# Only the native MR bridge routes here; the runtime proves its platform identity.
# The runner must provide authenticated glab and git; no MR scripts run in this job.
specgit-complete:
  stage: test
  resource_group: specgit-complete-$SPECGIT_PR
  variables:
    GIT_DEPTH: '0'
    SPECGIT_DATA_ROOT: '$CI_PROJECT_DIR'
  rules:
    - if: '${gitlabCompletionCondition(input).replace(/'/g, "''")}'
    - when: never
  script:
    - npm install --prefix "$CI_PROJECT_DIR/../specgit-runtime" --no-save --ignore-scripts --no-audit --no-fund specgit@${input.version}
    - node --input-type=module -e 'const r=await import(process.env.CI_PROJECT_DIR+"/../specgit-runtime/node_modules/specgit/dist/automation/remote-delivery.js");if(r.REMOTE_DELIVERY_PROTOCOL!==1)throw new Error("runtime_upgrade_required")'
    - node "$CI_PROJECT_DIR/../specgit-runtime/node_modules/specgit/dist/automation/remote-entry.js"
`;
}
