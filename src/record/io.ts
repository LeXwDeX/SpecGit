import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { RECORD_MISSING_FIX } from '../kernel/diagnostics.js';
import { PolicySchema, type Policy } from './policy.js';
import { ProvidersSchema, type Providers } from './providers.js';
import {
  POLICY_FILENAME,
  PROVIDERS_FILENAME,
  RECORD_FILENAME,
  SPEC_GIT_DIR,
  DeliveryBindingSchema,
  type DeliveryBinding,
} from './schema.js';

const fs = nodeFs.promises;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_DEADLINE_MS = 5000;
const LOCK_POLL_MS = 25;

export function recordPath(root: string): string {
  return path.join(root, RECORD_FILENAME);
}

export function policyDir(root: string): string {
  return path.join(root, SPEC_GIT_DIR);
}

export function policyPath(root: string): string {
  return path.join(policyDir(root), POLICY_FILENAME);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isMissingFile(error: unknown): boolean {
  return isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR');
}

function isUnsupportedSyncError(error: unknown): boolean {
  return (
    isNodeErrorCode(error, 'EINVAL') ||
    isNodeErrorCode(error, 'ENOTSUP') ||
    isNodeErrorCode(error, 'ENOSYS')
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireFileLock(lockPath: string): Promise<nodeFs.promises.FileHandle> {
  const lockDir = path.dirname(lockPath);
  await fs.mkdir(lockDir, { recursive: true });
  const deadline = Date.now() + LOCK_DEADLINE_MS;

  while (true) {
    try {
      const lock = await fs.open(lockPath, 'wx', PRIVATE_FILE_MODE);
      const token = `${process.pid}:${randomUUID()}`;
      try {
        await lock.writeFile(token, 'utf-8');
        try {
          await lock.sync();
        } catch (error) {
          if (!isUnsupportedSyncError(error)) {
            throw error;
          }
        }
      } catch (error) {
        await lock.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return lock;
    } catch (error) {
      if (!isNodeErrorCode(error, 'EEXIST')) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `SpecGit file lock is busy at ${lockPath}. Retry shortly; if this persists, delete the stale lock file.`
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

async function releaseFileLock(lock: nodeFs.promises.FileHandle, lockPath: string): Promise<void> {
  await lock.close().catch(() => undefined);
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
}

async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(lockPath);
  try {
    return await action();
  } finally {
    await releaseFileLock(lock, lockPath);
  }
}

function parseYamlObject(raw: string): Evidence<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    return fail(
      'invalid_yaml',
      `Not parseable as YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('invalid_shape', 'Expected a YAML mapping at the top level.');
  }

  return ok(parsed as Record<string, unknown>);
}

function zodIssuesMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the delivery-binding record. Unknown top-level keys parse-but-ignored
 * here; the writer preserves them on disk separately.
 */
export async function readRecord(root: string): Promise<Evidence<DeliveryBinding>> {
  let raw: string;
  try {
    raw = await fs.readFile(recordPath(root), 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) {
      return fail(
        'record_missing',
        `No delivery binding found at ${recordPath(root)}.`,
        RECORD_MISSING_FIX
      );
    }
    throw error;
  }

  const shape = parseYamlObject(raw);
  if (!shape.ok) {
    return fail('record_invalid', `Record is invalid: ${shape.message}`, 'Fix or recreate .specgit.yaml.');
  }

  const result = DeliveryBindingSchema.safeParse(shape.value);
  if (!result.success) {
    return fail(
      'record_invalid',
      `Record is invalid: ${zodIssuesMessage(result.error)}`,
      'Fix or recreate .specgit.yaml.'
    );
  }
  return ok(result.data);
}

/**
 * Writes the record, atomically and under a lock, preserving any unknown
 * top-level keys already present on disk.
 */
export async function writeRecord(root: string, binding: DeliveryBinding): Promise<void> {
  const target = recordPath(root);
  await withFileLock(`${target}.lock`, async () => {
    let existing: Record<string, unknown> = {};
    try {
      const shape = parseYamlObject(await fs.readFile(target, 'utf-8'));
      if (shape.ok) {
        existing = shape.value;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }

    const merged: Record<string, unknown> = {
      ...existing,
      version: binding.version,
      delivery: binding.delivery,
      context: binding.context,
      issues: binding.issues,
    };
    if (binding.pr === undefined) {
      delete merged.pr;
    } else {
      merged.pr = binding.pr;
    }
    // #338: unlike `pr`, an absent field leaves any on-disk value alone —
    // surgery writers (bind) that do not know about kinds must never drop
    // them; the bootstrap always writes the full map it owns.
    if (binding.issueKinds !== undefined) {
      merged.issueKinds = binding.issueKinds;
    }

    await writeFileAtomically(target, YAML.stringify(merged));
  });
}

export async function deleteRecord(root: string): Promise<void> {
  const target = recordPath(root);
  await withFileLock(`${target}.lock`, async () => {
    await fs.rm(target, { force: true });
  });
}

export async function readPolicy(root: string): Promise<Evidence<Policy>> {
  let raw: string;
  try {
    raw = await fs.readFile(policyPath(root), 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) {
      return fail(
        'policy_missing',
        `No policy found at ${policyPath(root)}.`,
        'Run "specgit init --required-check <name>" to declare the checks required for acceptance.'
      );
    }
    throw error;
  }

  const shape = parseYamlObject(raw);
  if (!shape.ok) {
    return fail('policy_invalid', `Policy is invalid: ${shape.message}`, 'Recreate spec_git/policy.yaml.');
  }

  const result = PolicySchema.safeParse(shape.value);
  if (!result.success) {
    return fail(
      'policy_invalid',
      `Policy is invalid: ${zodIssuesMessage(result.error)}`,
      'Recreate spec_git/policy.yaml.'
    );
  }
  return ok(result.data);
}

export async function writePolicy(root: string, policy: Policy): Promise<void> {
  const target = policyPath(root);
  await withFileLock(`${target}.lock`, async () => {
    await writeFileAtomically(target, YAML.stringify(policy));
  });
}

export function providersPath(root: string): string {
  return path.join(policyDir(root), PROVIDERS_FILENAME);
}

export async function readProviders(root: string): Promise<Evidence<Providers>> {
  let raw: string;
  try {
    raw = await fs.readFile(providersPath(root), 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) {
      return fail(
        'providers_missing',
        `No provider configuration found at ${providersPath(root)}.`,
        'Optional: declare a GitLab host, including gitlab.com, with "specgit init --gitlab-host <hostname>" before first init, or add --force in an initialized project.'
      );
    }
    throw error;
  }

  const shape = parseYamlObject(raw);
  if (!shape.ok) {
    return fail(
      'providers_invalid',
      `Provider configuration is invalid: ${shape.message}`,
      'Recreate spec_git/providers.yaml.'
    );
  }

  const result = ProvidersSchema.safeParse(shape.value);
  if (!result.success) {
    return fail(
      'providers_invalid',
      'Provider configuration is invalid: gitlab.host must be a bare hostname and unknown keys are rejected.',
      'Recreate spec_git/providers.yaml.'
    );
  }
  return ok(result.data);
}

/**
 * Write providers atomically and return the exact bytes committed by this call.
 * Rejection means this call did not commit target bytes: rename is the final
 * fallible write step, and lock release cannot reject after that commit.
 */
export async function writeProviders(root: string, providers: Providers): Promise<string> {
  const target = providersPath(root);
  const content = YAML.stringify(providers);
  await withFileLock(`${target}.lock`, async () => {
    await writeFileAtomically(target, content);
  });
  return content;
}
