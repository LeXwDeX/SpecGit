import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { PolicySchema } from '../src/record/policy.js';
import { ProvidersSchema } from '../src/record/providers.js';
import { DeliveryBindingSchema } from '../src/record/schema.js';
import { buildAgentSurfaceDesiredState } from '../src/cli/agent-surface.js';
import {
  LOCAL_ASSET_IGNORE_END,
  LOCAL_ASSET_IGNORE_START,
  hasManagedIgnoreRegion,
  reconcileLocalAssetIgnore,
} from '../src/cli/commands/init-ignore.js';
import { BLOCK_START_MARKER, BLOCK_END_MARKER, harnessWorkflowYaml, managedPromptBlock } from '../src/cli/harness-content.js';
import { DELIVERY_TYPES } from '../src/tags/catalog.js';
import type { PolicyLanguage } from '../src/record/policy.js';

const NonEmpty = z.string().trim().min(1);
const NonBlank = z.string().refine((value) => value.trim().length > 0, 'string must contain non-whitespace text');
const StringList = z.array(NonEmpty);

const IssueContactSchema = z.object({
  name: NonEmpty,
  url: z.url().refine((value) => value.startsWith('https://'), 'contact URL must use HTTPS'),
  about: NonEmpty,
}).strict();

const IssueConfigSchema = z.object({
  blank_issues_enabled: z.boolean(),
  contact_links: z.array(IssueContactSchema).min(1).max(10),
}).strict();

const RequiredValidationSchema = z.object({ required: z.boolean().optional() }).strict().optional();
const IssueFormSchema = z.object({
  name: NonEmpty,
  description: NonEmpty,
  title: NonBlank,
  labels: StringList,
  assignees: StringList.optional(),
  body: z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('markdown'),
      attributes: z.object({ value: NonEmpty }).strict(),
    }).strict(),
    z.object({
      type: z.literal('input'),
      id: NonEmpty.regex(/^[A-Za-z0-9_-]+$/),
      attributes: z.object({
        label: NonEmpty,
        description: z.string().optional(),
        placeholder: z.string().optional(),
        value: z.string().optional(),
      }).strict(),
      validations: RequiredValidationSchema,
    }).strict(),
    z.object({
      type: z.literal('textarea'),
      id: NonEmpty.regex(/^[A-Za-z0-9_-]+$/),
      attributes: z.object({
        label: NonEmpty,
        description: z.string().optional(),
        placeholder: z.string().optional(),
        value: z.string().optional(),
        render: NonEmpty.optional(),
      }).strict(),
      validations: RequiredValidationSchema,
    }).strict(),
    z.object({
      type: z.literal('dropdown'),
      id: NonEmpty.regex(/^[A-Za-z0-9_-]+$/),
      attributes: z.object({
        label: NonEmpty,
        description: z.string().optional(),
        multiple: z.boolean().optional(),
        options: z.array(NonEmpty).min(1),
      }).strict(),
      validations: RequiredValidationSchema,
    }).strict(),
    z.object({
      type: z.literal('checkboxes'),
      id: NonEmpty.regex(/^[A-Za-z0-9_-]+$/),
      attributes: z.object({
        label: NonEmpty,
        description: z.string().optional(),
        options: z.array(z.object({
          label: NonEmpty,
          required: z.boolean().optional(),
        }).strict()).min(1),
      }).strict(),
      validations: RequiredValidationSchema,
    }).strict(),
  ])).min(1),
}).strict();

const LegacyIssueTemplateSchema = z.object({
  name: NonEmpty,
  about: NonEmpty,
  title: NonBlank,
  labels: NonEmpty,
  assignees: z.string().optional(),
}).strict();

const DependabotSchema = z.object({
  version: z.literal(2),
  updates: z.array(z.object({
    'package-ecosystem': z.enum(['npm', 'github-actions']),
    directory: z.literal('/'),
    schedule: z.object({
      interval: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'semiannually', 'yearly']),
      day: z.enum([
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ]).optional(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      timezone: NonEmpty.optional(),
    }).strict(),
    cooldown: z.object({
      'default-days': z.number().int().nonnegative(),
      'semver-major-days': z.number().int().nonnegative().optional(),
      'semver-minor-days': z.number().int().nonnegative().optional(),
      'semver-patch-days': z.number().int().nonnegative().optional(),
    }).strict(),
    'open-pull-requests-limit': z.number().int().nonnegative().optional(),
    ignore: z.array(z.object({
      'dependency-name': NonEmpty,
      'update-types': z.array(z.enum([
        'version-update:semver-major',
        'version-update:semver-minor',
        'version-update:semver-patch',
      ])).min(1),
    }).strict()).optional(),
    'commit-message': z.object({
      prefix: NonEmpty,
      include: z.literal('scope').optional(),
    }).strict(),
    groups: z.record(NonEmpty, z.object({
      patterns: z.array(NonEmpty).min(1).optional(),
      'dependency-type': z.enum(['production', 'development']).optional(),
      'update-types': z.array(z.enum(['major', 'minor', 'patch'])).min(1).optional(),
    }).strict()),
  }).strict()).length(2),
}).strict().superRefine((value, context) => {
  const ecosystems = value.updates.map((update) => update['package-ecosystem']);
  for (const expected of ['npm', 'github-actions'] as const) {
    if (ecosystems.filter((ecosystem) => ecosystem === expected).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['updates'],
        message: `repository needs exactly one ${expected} update entry`,
      });
    }
  }
});

const ChangesetsConfigSchema = z.object({
  $schema: z.literal('https://unpkg.com/@changesets/config/schema.json'),
  changelog: z.tuple([
    z.literal('@changesets/changelog-github'),
    z.object({ repo: z.literal('LeXwDeX/SpecGit') }).strict(),
  ]),
  commit: z.literal(false),
  fixed: z.array(StringList),
  linked: z.array(StringList),
  access: z.literal('public'),
  baseBranch: z.literal('main'),
  updateInternalDependencies: z.literal('patch'),
  ignore: StringList,
}).strict();

const CodeRabbitSchema = z.object({
  language: z.literal('en-US'),
  reviews: z.object({
    profile: z.enum(['chill', 'assertive']),
    high_level_summary: z.boolean(),
    auto_review: z.object({
      enabled: z.boolean(),
      drafts: z.boolean(),
      base_branches: z.array(NonEmpty).min(1),
    }).strict(),
  }).strict(),
}).strict();

export interface RepositoryMetadataConfigurations {
  issueConfig: string;
  issueForms: Array<{ file: string; text: string }>;
  issueTemplates: Array<{ file: string; text: string }>;
  dependabot: string;
  changesets: string;
  codeRabbit: string;
  gitignore: string;
  codeowners: string;
}

function yaml(text: string, file: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid YAML`, { cause: error });
  }
}

function json(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON`, { cause: error });
  }
}

function validateShape(schema: z.ZodType, value: unknown, file: string): void {
  const result = schema.safeParse(value);
  if (result.success) return;
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`${file}: invalid repository metadata configuration: ${details}`);
}

function validateLegacyIssueTemplate(text: string, file: string): void {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error(`${file}: legacy issue template frontmatter must start with ---.`);
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error(`${file}: legacy issue template frontmatter has no closing ---.`);
  const parsed = yaml(lines.slice(1, close).join('\n'), file);
  validateShape(LegacyIssueTemplateSchema, parsed, file);
  const template = LegacyIssueTemplateSchema.parse(parsed);
  validateIssueTemplatePolicy(template.title, template.labels.split(',').map((label) => label.trim()).filter(Boolean), file);
  if (lines.slice(close + 1).join('\n').trim().length === 0) {
    throw new Error(`${file}: legacy issue template body must not be empty.`);
  }
}

/** This repository runs English-title plus kind-label mode; templates must scaffold that exact contract. */
function validateIssueTemplatePolicy(title: string, labels: string[], file: string): void {
  const type = /^([a-z]+):\s/.exec(title)?.[1];
  if (type === undefined || !DELIVERY_TYPES.includes(type as (typeof DELIVERY_TYPES)[number])) {
    throw new Error(`${file}: title must begin with one supported delivery type and a colon.`);
  }
  if (/\p{Script=Han}/u.test(title)) {
    throw new Error(`${file}: the repository's English issue-template title must not contain Han characters.`);
  }
  if (labels.length !== 1 || labels[0] !== `kind::${type}`) {
    throw new Error(`${file}: the template must carry exactly one kind label matching its title type (kind::${type}).`);
  }
}

function validateManagedGitignore(text: string): void {
  text = text.replace(/\r\n/g, '\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.flatMap((line, index) => line.trim() === LOCAL_ASSET_IGNORE_START ? [index] : []);
  const end = lines.flatMap((line, index) => line.trim() === LOCAL_ASSET_IGNORE_END ? [index] : []);
  assert(hasManagedIgnoreRegion(text), '.gitignore must contain the SpecGit managed ignore region.');
  assert.equal(start.length, 1, '.gitignore must contain exactly one managed start marker.');
  assert.equal(end.length, 1, '.gitignore must contain exactly one managed end marker.');
  assert(start[0] < end[0], '.gitignore managed markers are out of order.');
  assert.equal(reconcileLocalAssetIgnore(text), text, '.gitignore managed region is stale or damaged.');
  const unsafe = lines.slice(end[0] + 1).find((line) => line.trim().startsWith('!'));
  assert.equal(unsafe, undefined, '.gitignore contains a negation after the managed region that can unshield local assets.');
}

function validateCodeowners(text: string): void {
  let hasDefault = false;
  for (const [index, raw] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    const [pattern, ...owners] = fields;
    assert(pattern !== undefined && !pattern.startsWith('!') && !/[\[\]#]/.test(pattern),
      `.github/CODEOWNERS:${index + 1}: invalid ownership pattern.`);
    assert(owners.length > 0, `.github/CODEOWNERS:${index + 1}: rule needs at least one owner.`);
    for (const owner of owners) {
      const validHandle = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)?$/.test(owner);
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner);
      assert(validHandle || validEmail, `.github/CODEOWNERS:${index + 1}: invalid owner ${owner}.`);
    }
    hasDefault ||= pattern === '*';
  }
  assert(hasDefault, '.github/CODEOWNERS must define a default * owner.');
}

/** Validate every configuration path deliberately admitted to metadata-only CI. */
export function validateRepositoryMetadataConfigurations(input: RepositoryMetadataConfigurations): void {
  validateShape(
    IssueConfigSchema,
    yaml(input.issueConfig, '.github/ISSUE_TEMPLATE/config.yml'),
    '.github/ISSUE_TEMPLATE/config.yml'
  );
  const formNames = new Set<string>();
  for (const form of input.issueForms) {
    if (!/^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(form.file)
      || form.file === '.github/ISSUE_TEMPLATE/config.yml') {
      throw new Error(`${form.file}: invalid issue-form path`);
    }
    if (formNames.has(form.file)) throw new Error(`${form.file}: duplicate issue-form input`);
    formNames.add(form.file);
    const parsed = yaml(form.text, form.file);
    validateShape(IssueFormSchema, parsed, form.file);
    const issueForm = IssueFormSchema.parse(parsed);
    validateIssueTemplatePolicy(issueForm.title, issueForm.labels, form.file);
  }
  const templateNames = new Set<string>();
  for (const template of input.issueTemplates) {
    if (!/^\.github\/ISSUE_TEMPLATE\/[^/]+\.md$/.test(template.file)) {
      throw new Error(`${template.file}: invalid legacy issue-template path`);
    }
    if (templateNames.has(template.file)) throw new Error(`${template.file}: duplicate legacy issue-template input`);
    templateNames.add(template.file);
    validateLegacyIssueTemplate(template.text, template.file);
  }
  validateShape(DependabotSchema, yaml(input.dependabot, '.github/dependabot.yml'), '.github/dependabot.yml');
  validateShape(ChangesetsConfigSchema, json(input.changesets, '.changeset/config.json'), '.changeset/config.json');
  validateShape(CodeRabbitSchema, yaml(input.codeRabbit, '.coderabbit.yaml'), '.coderabbit.yaml');
  validateManagedGitignore(input.gitignore);
  validateCodeowners(input.codeowners);
}

/** Repository checks use the product schemas; the no-CI adopter exception is not this repository's policy. */
export function validateDeliveryMetadata(input: { record: string; policy: string; ci: string; providers?: string }) {
  DeliveryBindingSchema.parse(parse(input.record));
  const policy = PolicySchema.parse(parse(input.policy));
  if (input.providers !== undefined) ProvidersSchema.parse(parse(input.providers));
  assert(policy.required_checks.includes('Required verification'), 'Repository policy must require Required verification.');
  const workflow = parse(input.ci) as { jobs?: Record<string, { name?: string; strategy?: { matrix?: { include?: Array<{ label?: string }> } } }> };
  const names = new Set<string>();
  for (const job of Object.values(workflow.jobs ?? {})) {
    if (job.name?.includes('${{ matrix.label }}')) {
      for (const entry of job.strategy?.matrix?.include ?? []) names.add(job.name.replace('${{ matrix.label }}', String(entry.label)));
    } else if (job.name) names.add(job.name);
  }
  for (const name of policy.required_checks) assert(names.has(name), `Required check ${name} is not produced by CI.`);
  return policy;
}

/** Compare bytes only: never run init/setup or repair files during verification. */
export async function validateGeneratedMetadata(root: string, language: PolicyLanguage) {
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(read('.github/workflows/specgit-accept.yml'), harnessWorkflowYaml(), 'Acceptance workflow differs from its generator.');
  assert(existsSync(path.join(root, 'AGENTS.md')), 'AGENTS.md is a required generated guidance surface.');
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    if (!existsSync(path.join(root, file))) continue;
    const content = read(file);
    const start = content.indexOf(BLOCK_START_MARKER);
    const end = content.indexOf(BLOCK_END_MARKER, start);
    assert(start >= 0 && end >= start, `${file} must contain its managed block.`);
    assert.equal(content.slice(start, end + BLOCK_END_MARKER.length), managedPromptBlock(language), `${file} managed guidance differs from its generator.`);
  }
  const desired = await buildAgentSurfaceDesiredState(root, 'all');
  for (const installed of desired.installed) {
    assert(existsSync(path.join(root, installed)), `${installed} is a required generated entry point.`);
  }
  for (const step of desired.steps) {
    if (step.kind !== 'write') continue;
    assert.equal(read(step.path), step.merge(null), `${step.path} differs from its generator.`);
  }
}
