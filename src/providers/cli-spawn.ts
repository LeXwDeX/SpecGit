import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

import type { SpawnFn } from '../kernel/spawn.js';

/**
 * Transport plumbing shared by the CLI provider adapters (`gh`, `glab`):
 * the spawn seam, Node-shebang command resolution, and diagnostic text
 * sanitization. Extracted from the GitHub adapter (#113 home) when the
 * GitLab adapter landed (#114) so both platforms resolve commands and
 * classify spawn failures identically; the GitHub module re-exports these
 * for import-path stability. The spawn contract types themselves live once
 * in the kernel (#185) and are re-exported here for stable import paths.
 */

export type { SpawnFn, SpawnOptions } from '../kernel/spawn.js';

const NODE_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?node/;

const shebangCache = new Map<string, boolean>();

/**
 * A CLI command that resolves to a Node script (#!…node shebang) cannot be
 * executed directly on Windows. Detect that case once per path and re-run it
 * through the current Node executable; native binaries are untouched.
 * Exported for tests that wrap the spawn seam and must mirror this behavior.
 */
export function resolveNodeScriptCommand(command: string): { command: string; scriptArgs: string[] } {
  if (command === 'gh' || command === 'glab' || command === '') return { command, scriptArgs: [] };
  let isNodeScript: boolean;
  const cached = shebangCache.get(command);
  if (cached === undefined) {
    isNodeScript = false;
    try {
      const fd = fs.openSync(command, 'r');
      try {
        const buf = Buffer.alloc(128);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        isNodeScript = NODE_SHEBANG.test(buf.subarray(0, read).toString('utf-8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      isNodeScript = false;
    }
    shebangCache.set(command, isNodeScript);
  } else {
    isNodeScript = cached;
  }
  return isNodeScript ? { command: process.execPath, scriptArgs: [command] } : { command, scriptArgs: [] };
}

export const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const resolved = resolveNodeScriptCommand(command);
    const child = execFile(
      resolved.command,
      [...resolved.scriptArgs, ...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        env: options.env,
        cwd: options.cwd,
        encoding: 'utf-8',
      },
      (error, stdout, stderr) => {
        if (error) {
          // Mirror promisify(execFile): keep captured output on the error so
          // the failure taxonomy can read err.stderr.
          const withOutput = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
          withOutput.stdout = stdout;
          withOutput.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr: stderr ?? '' });
        }
      }
    );
    // A child that exits before draining stdin raises EPIPE here; the
    // failure is already reported through the callback. stdin is always a
    // pipe unless stdio was customized, which this transport never does.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin ?? '');
    }
  });

const MAX_EMBEDDED_TEXT = 400;

/**
 * API-sourced text can carry ANSI cursor controls or hostile bytes; anything
 * embedded in a diagnostic is stripped and truncated before it reaches a
 * terminal.
 */
export function sanitizeApiText(text: string, maxLength: number = MAX_EMBEDDED_TEXT): string {
  const stripped = text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const flat = stripped.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}
