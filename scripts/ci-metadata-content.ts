import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { PolicySchema } from '../src/record/policy.js';
import { ProvidersSchema } from '../src/record/providers.js';
import { DeliveryBindingSchema } from '../src/record/schema.js';
import { buildAgentSurfaceDesiredState } from '../src/cli/agent-surface.js';
import { BLOCK_START_MARKER, BLOCK_END_MARKER, harnessWorkflowYaml, managedPromptBlock } from '../src/cli/harness-content.js';
import type { PolicyLanguage } from '../src/record/policy.js';

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
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    if (!existsSync(path.join(root, file))) continue;
    const content = read(file);
    const start = content.indexOf(BLOCK_START_MARKER);
    const end = content.indexOf(BLOCK_END_MARKER, start);
    assert(start >= 0 && end >= start, `${file} must contain its managed block.`);
    assert.equal(content.slice(start, end + BLOCK_END_MARKER.length), managedPromptBlock(language), `${file} managed guidance differs from its generator.`);
  }
  const desired = await buildAgentSurfaceDesiredState(root, 'all');
  for (const step of desired.steps) {
    if (step.kind !== 'write' || !existsSync(path.join(root, step.path))) continue;
    assert.equal(read(step.path), step.merge(null), `${step.path} differs from its generator.`);
  }
}
