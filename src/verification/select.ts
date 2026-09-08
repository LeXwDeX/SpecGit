import YAML from 'yaml';
import { z } from 'zod';
import type { Policy } from '../record/policy.js';
import { DeliveryBindingSchema, ExecutionContextSchema } from '../record/schema.js';
import type { GitChange } from '../gitfacts/port.js';

export type VerificationChange = GitChange;

export interface VerificationPath {
  path: string;
  kind: 'record' | 'configured' | 'product';
  reason: string;
  checks: string[];
}

export interface VerificationSelection {
  requiredChecks: string[];
  paths: VerificationPath[];
}

const RecognizedBindingSchema = DeliveryBindingSchema.extend({
  context: z.union([ExecutionContextSchema.options[0].strict(), ExecutionContextSchema.options[1].strict()]),
  issueKinds: DeliveryBindingSchema.shape.issueKinds.unwrap().element.strict().array().optional(),
}).strict();

function recognizedBinding(content: string | null): boolean {
  if (content === null) return true; // A first binding has no previous file.
  try { return RecognizedBindingSchema.safeParse(YAML.parse(content)).success; }
  catch { return false; }
}

function matches(path: string, pattern: string): boolean {
  const parts = pattern.split('/');
  let expression = '^';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === '**') expression += index === parts.length - 1 ? '.+' : '(?:[^/]+/)*';
    else {
      expression += part.split('*').map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
      if (index < parts.length - 1) expression += '/';
    }
  }
  return new RegExp(expression + '$').test(path);
}

/** These inputs can change verification itself, even when a broad project rule matches. */
function criticalInput(path: string): boolean {
  return path.startsWith('.github/') || path.startsWith('.gitlab/') || path.startsWith('.ci/') || path === '.gitlab-ci.yml' ||
    path === 'spec_git/policy.yaml' || path === 'spec_git/providers.yaml' ||
    /(?:^|\/)(?:package\.json|(?:pnpm-lock|yarn\.lock|package-lock|npm-shrinkwrap|bun\.lockb?)(?:\.ya?ml|\.json)?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Dockerfile[^/]*|Makefile|tsconfig[^/]*\.json|(?:vite|vitest|jest|webpack)\.config\.[^/]+|\.node-version|\.nvmrc)$/.test(path);
}

/** Pure selection; callers must supply complete immutable Git evidence under approved policy. */
export function selectVerification(
  policy: Policy,
  changes: readonly VerificationChange[],
  binding?: { before: string | null; after: string | null },
): VerificationSelection {
  const required = new Set(policy.required_checks);
  const paths: VerificationPath[] = [];
  if (!policy.verification) return { requiredChecks: [...required], paths };
  const verification = policy.verification;
  for (const change of changes) {
    let selected: VerificationPath;
    const product = (reason: string): VerificationPath => ({ path: change.path, kind: 'product', reason, checks: verification.product_checks });
    if (change.status === 'D' || change.status === 'T' ||
        change.newMode !== '100644' ||
        (change.status !== 'A' && change.oldMode !== change.newMode)) {
      selected = product('deleted_or_mode_changed');
    } else if (criticalInput(change.path) || change.path === verification.gitlab_entry) {
      selected = product('verification_input');
    } else if (change.path === '.specgit.yaml') {
      selected = binding?.after !== null && binding !== undefined &&
        recognizedBinding(binding.before) && recognizedBinding(binding.after)
        ? { path: change.path, kind: 'record', reason: 'recognized_binding', checks: [] }
        : product('unrecognized_binding');
    } else {
      const rules = verification.rules.filter((rule) => rule.paths.some((pattern) => matches(change.path, pattern)));
      selected = rules.length === 0 ? product('unmatched_input') : {
        path: change.path, kind: 'configured', reason: 'approved_path_rule',
        checks: [...new Set(rules.flatMap((rule) => rule.checks))],
      };
    }
    paths.push(selected);
    selected.checks.forEach((name) => required.add(name));
  }
  return { requiredChecks: [...required], paths };
}
