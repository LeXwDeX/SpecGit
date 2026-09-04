/** Prepare an ephemeral approved-policy input for the read-only sibling-check waiter. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createDefaultContext } from '../cli/wiring.js';

export const WORKFLOW_POLICY_PROTOCOL = 1;

export async function prepareWorkflowPolicy(target: string): Promise<void> {
  const ctx = createDefaultContext();
  const root = await ctx.discoverRoot(ctx.cwd);
  if (!root.ok) throw new Error(root.message);
  const record = await ctx.record.readRecord(root.value);
  const resolved = await ctx.resolvePolicy(root.value, record);
  if (!resolved.ok) throw new Error(resolved.message);
  if (resolved.value.policy.required_checks.some((name) => name === 'SpecGit Acceptance' || name === 'SpecGit Completion')) {
    throw new Error('The policy cannot require its own acceptance or completion job as a sibling check.');
  }
  writeFileSync(target, YAML.stringify(resolved.value.policy), { mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.env.SPECGIT_WAIT_POLICY;
  (target ? prepareWorkflowPolicy(target) : Promise.reject(new Error('SPECGIT_WAIT_POLICY is required.')))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 3; });
}
