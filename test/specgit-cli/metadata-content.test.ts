import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { validateDeliveryMetadata, validateGeneratedMetadata } from '../../scripts/ci-metadata-content.js';
import { parseReleaseNote } from '../../scripts/ci-changesets.mjs';
import { PolicySchema } from '../../src/record/policy.js';
import { harnessWorkflowYaml, managedPromptBlock } from '../../src/cli/harness-content.js';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const valid = () => ({
  record: 'version: 1\ndelivery: verify-metadata\ncontext: {kind: branch, branch: main}\nissues: [423]\npr: 424\n',
  policy: 'version: 1\nrequired_checks: [Required verification]\nlanguage: en\n',
  ci: 'jobs:\n  verify:\n    name: Required verification\n',
});

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
      mkdirSync(path.join(fixture, '.github/workflows'), { recursive: true });
      const workflowPath = path.join(fixture, '.github/workflows/specgit-accept.yml');
      const guidancePath = path.join(fixture, 'AGENTS.md');
      writeFileSync(workflowPath, harnessWorkflowYaml());
      writeFileSync(guidancePath, `Personal guidance\n${managedPromptBlock('en')}\n`);
      await expect(validateGeneratedMetadata(fixture, 'en')).resolves.toBeUndefined();
      writeFileSync(workflowPath, harnessWorkflowYaml().replace('contents: read', 'contents: write'));
      await expect(validateGeneratedMetadata(fixture, 'en')).rejects.toThrow(/Acceptance workflow/);
      writeFileSync(workflowPath, harnessWorkflowYaml());
      writeFileSync(guidancePath, `${managedPromptBlock('en').replace('specgit finish', 'specgit bypass')}\n`);
      await expect(validateGeneratedMetadata(fixture, 'en')).rejects.toThrow(/managed guidance/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
