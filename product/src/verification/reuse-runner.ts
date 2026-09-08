import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { ReuseInputs } from './reuse-inputs.js';
import type { ReuseProfile } from './reuse-profile.js';
import { materializeReuseSnapshot } from './reuse-snapshot.js';

// cross-spawn supplies Windows executable resolution with Node's spawn interface.
const crossSpawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess = createRequire(import.meta.url)('cross-spawn');

/** The driver observes installed tools before stripping its environment for business commands. */
export function readVerificationTool(root: string, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const error = () => reject(new Error('Verification toolchain observation failed'));
    const timer = setTimeout(() => { child.kill(); error(); }, 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { child.kill(); error(); }
      else chunks.push(chunk);
    });
    child.stderr?.resume();
    child.once('error', () => { clearTimeout(timer); error(); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) error();
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  log?: (chunk: string) => void;
  timeoutMs?: number;
}

/** Event metadata and authentication stay in the CI driver; commands receive only their declared inputs. */
export async function executeVerificationCommands(
  root: string, commands: string[][], variables: Record<string, string>, options: CommandOptions = {},
): Promise<Evidence<{ executed: number }>> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'specgit-verification-home-'));
  try {
    const source = options.env ?? process.env;
    const inherited = Object.fromEntries(Object.entries(source).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
    const env: NodeJS.ProcessEnv = { ...inherited, ...variables, HOME: home, USERPROFILE: home,
      TMPDIR: home, TMP: home, TEMP: home, CI: 'true', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    let executed = 0;
    for (const args of commands) {
      const success = await new Promise<boolean>((resolve) => {
        const child = crossSpawn(args[0], args.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 20 * 60_000);
        const log = options.log ?? ((chunk: string) => { process.stderr.write(chunk); });
        child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString('utf8')));
        child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString('utf8')));
        child.once('error', () => { clearTimeout(timer); resolve(false); });
        child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 && !timedOut); });
      });
      if (!success) return fail('verification_command_failed', `Verification command ${executed + 1} failed; later commands were not executed.`);
      executed += 1;
    }
    return ok({ executed });
  } finally { await rm(home, { recursive: true, force: true }); }
}

/** The business directory has no ancestor Git repository and contains only verified committed files. */
export async function executeNormalizedVerification(
  root: string, inputs: ReuseInputs, profile: ReuseProfile, options: CommandOptions = {},
): Promise<Evidence<{ executed: number }>> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'specgit-verification-snapshot-'));
  try {
    const snapshot = path.join(temporary, 'work');
    const prepared = await materializeReuseSnapshot(root, inputs, snapshot);
    if (!prepared.ok) return prepared;
    return await executeVerificationCommands(snapshot, profile.commands, profile.environment, options);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
