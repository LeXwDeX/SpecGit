import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { SpawnFn } from '../kernel/spawn.js';
import { recognizedBinding } from './select.js';

const execFileAsync = promisify(execFile);
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = /^[a-f0-9]{64}$/;

export interface ReuseTreeEntry { path: string; mode: '100644' | '100755'; blob: string }

export function reuseGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
}

export function reuseTreeDigest(entries: ReuseTreeEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries.map(({ mode, blob, path }) => `${mode} blob ${blob}\t${path}`))).digest('hex');
}

/** Portable regular files only; ambiguous checkout names cannot grant reuse. */
export function parseReuseTree(raw: string): ReuseTreeEntry[] | null {
  const rows = raw === '' ? [] : raw.split('\0');
  if (rows.length && rows.pop() !== '') return null;
  const entries: ReuseTreeEntry[] = [];
  const names = new Map<string, string>();
  const files = new Set<string>();
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(row);
    if (!match) return null;
    const [, mode, blob, path] = match;
    if (/[\\\p{Cc}\p{Cf}\uFFFD<>:"|?*]/u.test(path) || path.normalize('NFC') !== path ||
        path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
          part.toLowerCase() === '.git' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
    const components = path.split('/');
    let prefix = '';
    for (let i = 0; i < components.length; i++) {
      prefix += (i ? '/' : '') + components[i];
      const identity = prefix.toLowerCase();
      // Keep both case spelling and file/directory role unambiguous on Windows/macOS.
      const tag = `${prefix}${i < components.length - 1 ? '/' : ''}`;
      if (names.has(identity) && names.get(identity) !== tag) return null;
      names.set(identity, tag);
    }
    if (files.has(path)) return null;
    files.add(path);
    entries.push({ mode: mode as ReuseTreeEntry['mode'], blob, path });
  }
  return entries;
}

export interface ReuseInputIdentity {
  sourceSha: string;
  checkoutSha: string;
  baseSha: string;
  policySha: string;
  recipeDigest: string;
  environmentDigest: string;
}

export interface ReuseInputs extends ReuseInputIdentity {
  sourceTreeDigest: string;
  checkoutTreeDigest: string;
  digest: string;
}

const spawn: SpawnFn = async (command, args, options) => execFileAsync(command, args, {
  cwd: options.cwd, env: options.env, timeout: options.timeoutMs,
  maxBuffer: options.maxBuffer, encoding: 'utf8',
});

/**
 * Input comparison for the normalized snapshot recipe, never a reuse verdict.
 * The recipe must hide Git metadata, binding data and undeclared event inputs
 * from the business process. Native execution provenance is verified separately.
 */
export async function collectReuseInputs(
  root: string,
  identity: ReuseInputIdentity,
  options: { env?: NodeJS.ProcessEnv; spawnImpl?: SpawnFn } = {},
): Promise<Evidence<ReuseInputs>> {
  const unavailable = () => fail<ReuseInputs>('verification_reuse_inputs_unavailable',
    'Complete immutable inputs for the normalized verification recipe could not be established.',
    'Execute the applicable verification commands; incomplete input evidence cannot grant reuse.');
  if (![identity.sourceSha, identity.checkoutSha, identity.baseSha, identity.policySha].every((sha) => objectId.test(sha)) ||
      !digest.test(identity.recipeDigest) || !digest.test(identity.environmentDigest)) return unavailable();
  const execute = options.spawnImpl ?? spawn;
  const git = async (args: string[]) => (await execute('git', ['-C', root, ...args], {
    timeoutMs: 10_000, maxBuffer: 1024 * 1024,
    env: reuseGitEnvironment(options.env),
  })).stdout;
  try {
    for (const sha of new Set([identity.sourceSha, identity.checkoutSha, identity.baseSha, identity.policySha])) {
      if ((await git(['cat-file', '-t', sha])).trim() !== 'commit') return unavailable();
    }
    const trees = new Map<string, string>();
    for (const sha of new Set([identity.sourceSha, identity.checkoutSha])) {
      const raw = await git(['ls-tree', '-r', '-z', '--full-tree', sha]);
      const entries = parseReuseTree(raw);
      if (!entries) return unavailable();
      const normalized: ReuseTreeEntry[] = [];
      for (const entry of entries) {
        const { mode, blob, path } = entry;
        if (path === '.specgit.yaml') {
          if (mode !== '100644' || !recognizedBinding(await git(['cat-file', 'blob', blob]))) return unavailable();
          continue;
        }
        normalized.push(entry);
      }
      trees.set(sha, reuseTreeDigest(normalized));
    }
    const sourceTreeDigest = trees.get(identity.sourceSha)!;
    const checkoutTreeDigest = trees.get(identity.checkoutSha)!;
    const value = {
      version: 1, sourceTreeDigest, checkoutTreeDigest,
      baseSha: identity.baseSha, policySha: identity.policySha,
      recipeDigest: identity.recipeDigest, environmentDigest: identity.environmentDigest,
    };
    return ok({ ...identity, sourceTreeDigest, checkoutTreeDigest,
      digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  } catch { return unavailable(); }
}
