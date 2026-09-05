import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import {
  validateDeliveryMetadata,
  validateGeneratedMetadata,
  validateRepositoryMetadataConfigurations,
} from '../../scripts/ci-metadata-content.js';
import { parseReleaseNote } from '../../scripts/ci-changesets.mjs';
import { PolicySchema } from '../../src/record/policy.js';
import { harnessWorkflowYaml, managedPromptBlock } from '../../src/cli/harness-content.js';
import { buildAgentSurfaceDesiredState } from '../../src/cli/agent-surface.js';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const valid = () => ({
  record: 'version: 1\ndelivery: verify-metadata\ncontext: {kind: branch, branch: main}\nissues: [423]\npr: 424\n',
  policy: 'version: 1\nrequired_checks: [Required verification]\nlanguage: en\n',
  ci: 'jobs:\n  verify:\n    name: Required verification\n',
});
const repositoryConfigurations = () => {
  const issueDirectory = path.join(root, '.github', 'ISSUE_TEMPLATE');
  return {
    issueConfig: read(path.join('.github', 'ISSUE_TEMPLATE', 'config.yml')),
    issueForms: readdirSync(issueDirectory)
      .filter((file) => /\.ya?ml$/.test(file) && file !== 'config.yml')
      .map((file) => ({
        file: `.github/ISSUE_TEMPLATE/${file}`,
        text: read(path.join('.github', 'ISSUE_TEMPLATE', file)),
      })),
    issueTemplates: readdirSync(issueDirectory)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file: `.github/ISSUE_TEMPLATE/${file}`,
        text: read(path.join('.github', 'ISSUE_TEMPLATE', file)),
      })),
    dependabot: read(path.join('.github', 'dependabot.yml')),
    changesets: read(path.join('.changeset', 'config.json')),
    codeRabbit: read('.coderabbit.yaml'),
    gitignore: read('.gitignore'),
    codeowners: read(path.join('.github', 'CODEOWNERS')),
  };
};

async function writeGeneratedFixture(fixture: string): Promise<string[]> {
  mkdirSync(path.join(fixture, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(fixture, '.github/workflows/specgit-accept.yml'), harnessWorkflowYaml());
  writeFileSync(path.join(fixture, 'AGENTS.md'), `Personal guidance\n${managedPromptBlock('en')}\n`);
  const desired = await buildAgentSurfaceDesiredState(fixture, 'all');
  for (const step of desired.steps) {
    if (step.kind !== 'write') continue;
    const content = step.merge(null);
    if (content === null) continue;
    const target = path.join(fixture, step.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return desired.installed;
}

describe('metadata content validation', () => {
  it('validates every pending note with the real Changesets grammar', () => {
    for (const file of readdirSync(path.join(root, '.changeset'))) {
      if (file.endsWith('.md') && file !== 'README.md') expect(() => parseReleaseNote(read(`.changeset/${file}`), file)).not.toThrow();
    }
  });
  it('validates the committed record and policy with production schemas and repository requirements', () => {
    expect(() => validateDeliveryMetadata({ ...valid(), record: read('.specgit.yaml'), policy: read('spec_git/policy.yaml'),
      ci: read('.github/workflows/ci.yml'),
      ...(existsSync(path.join(root, 'spec_git/providers.yaml')) ? { providers: read('spec_git/providers.yaml') } : {}),
    })).not.toThrow();
  });

  it('strictly validates every repository configuration admitted to metadata-only CI', () => {
    expect(() => validateRepositoryMetadataConfigurations(repositoryConfigurations())).not.toThrow();
  });

  it('rejects malformed or off-contract metadata configuration instead of returning a green job', () => {
    const configs = repositoryConfigurations();
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueConfig: 'blank_issues_enabled: [',
    })).toThrow(/invalid YAML/);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueConfig: configs.issueConfig.replace(
        'blank_issues_enabled: false',
        'blank_issues_enabled: "false"'
      ),
    })).toThrow(/ISSUE_TEMPLATE\/config\.yml/);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      dependabot: configs.dependabot.replace('version: 2', 'version: 1'),
    })).toThrow(/dependabot\.yml/);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      changesets: configs.changesets.replace('"baseBranch": "main"', '"baseBranch": "dev"'),
    })).toThrow(/changeset\/config\.json/);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      codeRabbit: configs.codeRabbit.replace('enabled: true', 'enabled: "true"'),
    })).toThrow(/coderabbit\.yaml/);
  });

  it('accepts CRLF metadata without weakening managed-ignore validation', () => {
    const configs = repositoryConfigurations();
    const crlf = configs.gitignore.replace(/\r?\n/g, '\r\n');
    expect(() => validateRepositoryMetadataConfigurations({ ...configs, gitignore: crlf })).not.toThrow();
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs, gitignore: crlf.replace('/spec_git/', '/wrong-policy/'),
    })).toThrow(/gitignore.*stale|gitignore.*damaged/i);
  });

  it('accepts a valid issue form and rejects an invalid body shape', () => {
    const configs = repositoryConfigurations();
    const form = {
      file: '.github/ISSUE_TEMPLATE/reproduction.yml',
      text: [
        'name: Reproduction',
        'description: Provide a minimal reproduction',
        'title: "fix: "',
        'labels: ["kind::fix"]',
        'body:',
        '  - type: textarea',
        '    id: reproduction',
        '    attributes:',
        '      label: Reproduction',
        '      description: Show the failing command.',
        '      render: shell',
        '    validations:',
        '      required: true',
      ].join('\n'),
    };
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs, issueForms: [...configs.issueForms, form],
    })).not.toThrow();
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueForms: [...configs.issueForms, {
        ...form,
        text: form.text.replace('id: reproduction', 'id: "bad id"'),
      }],
    })).toThrow(/reproduction\.yml/);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueForms: [...configs.issueForms, {
        ...form,
        text: form.text.replace('title: "fix: "', 'title: "fix: 中文标题"'),
      }],
    })).toThrow(/English issue-template title/);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueForms: [...configs.issueForms, {
        ...form,
        text: form.text.replace('labels: ["kind::fix"]', 'labels: ["kind::feat"]'),
      }],
    })).toThrow(/exactly one kind label/);
  });

  it('strictly validates every legacy Markdown issue template admitted to metadata CI', () => {
    const configs = repositoryConfigurations();
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueTemplates: [...configs.issueTemplates, {
        file: '.github/ISSUE_TEMPLATE/security.md',
        text: '---\nname: Security\nabout: Report a security concern\ntitle: "security: report concern"\nlabels: kind::security\n---\n\n## Evidence\n\nPrivate-report guidance.\n',
      }],
    })).not.toThrow();
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueTemplates: [...configs.issueTemplates, {
        file: '.github/ISSUE_TEMPLATE/broken.md',
        text: '---\nname: Broken\nabout: Missing closing frontmatter\n',
      }],
    })).toThrow(/broken\.md.*frontmatter/i);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueTemplates: [{
        ...configs.issueTemplates[0],
        text: configs.issueTemplates[0].text.replace('labels: kind::', 'labels: kind::wrong-'),
      }, ...configs.issueTemplates.slice(1)],
    })).toThrow(/kind label/i);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      issueTemplates: [{
        ...configs.issueTemplates[0],
        text: configs.issueTemplates[0].text.replace('labels: kind::fix', 'labels: kind::fix, triage'),
      }, ...configs.issueTemplates.slice(1)],
    })).toThrow(/exactly one kind label/i);
  });

  it('rejects damaged shielding and CODEOWNERS configuration on the metadata route', () => {
    const configs = repositoryConfigurations();
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      gitignore: configs.gitignore.replace('/spec_git/\n', ''),
    })).toThrow(/gitignore.*managed/i);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      gitignore: `${configs.gitignore}!/.specgit.yaml\n`,
    })).toThrow(/gitignore.*negation/i);
    expect(() => validateRepositoryMetadataConfigurations({
      ...configs,
      codeowners: '* invalid-owner\n',
    })).toThrow(/CODEOWNERS/);
  });

  it('rejects invalid schema data and a valid but weakened repository policy', () => {
    expect(() => validateDeliveryMetadata({ ...valid(), record: 'version: 999' })).toThrow();
    expect(() => validateDeliveryMetadata({ ...valid(), policy: 'version: 1\nrequired_checks: []\n' })).toThrow(/Required verification/);
    expect(() => validateDeliveryMetadata({ ...valid(), providers: 'gitlab: {host: "https://invalid/path"}' })).toThrow();
  });

  it('rejects required checks that the workflow cannot produce', () => {
    expect(() => validateDeliveryMetadata({ ...valid(), policy: valid().policy + 'unexpected: true\n' })).toThrow();
    expect(() => validateDeliveryMetadata({ ...valid(), ci: 'jobs: {}' })).toThrow(/not produced/);
  });

  it('compares committed generated assets with their actual generators without writing them', async () => {
    const policy = PolicySchema.parse(parse(read('spec_git/policy.yaml')));
    await expect(validateGeneratedMetadata(root, policy.language ?? 'en')).resolves.toBeUndefined();
  });

  it('detects changed generated workflow and guidance bytes even when the paths qualify as metadata', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'specgit-metadata-content-'));
    try {
      const installed = await writeGeneratedFixture(fixture);
      const workflowPath = path.join(fixture, '.github/workflows/specgit-accept.yml');
      const guidancePath = path.join(fixture, 'AGENTS.md');
      await expect(validateGeneratedMetadata(fixture, 'en')).resolves.toBeUndefined();
      writeFileSync(workflowPath, harnessWorkflowYaml().replace('contents: read', 'contents: write'));
      await expect(validateGeneratedMetadata(fixture, 'en')).rejects.toThrow(/Acceptance workflow/);
      writeFileSync(workflowPath, harnessWorkflowYaml());
      writeFileSync(guidancePath, `${managedPromptBlock('en').replace('specgit finish', 'specgit bypass')}\n`);
      await expect(validateGeneratedMetadata(fixture, 'en')).rejects.toThrow(/managed guidance/);
      writeFileSync(guidancePath, `Personal guidance\n${managedPromptBlock('en')}\n`);
      rmSync(path.join(fixture, installed[0]));
      await expect(validateGeneratedMetadata(fixture, 'en')).rejects.toThrow(/required generated entry point/);
      await writeGeneratedFixture(fixture);
      rmSync(guidancePath);
      await expect(validateGeneratedMetadata(fixture, 'en')).rejects.toThrow(/AGENTS\.md/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
