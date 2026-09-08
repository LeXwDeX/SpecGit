import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { parseReuseTree, reuseGitEnvironment, reuseTreeDigest, type ReuseInputs, type ReuseTreeEntry } from './reuse-inputs.js';
import { recognizedBinding } from './select.js';

const exec = promisify(execFile);
const maximumBytes = 128 * 1024 * 1024;
const unavailable = () => fail<ReuseTreeEntry[]>('verification_snapshot_unavailable',
  'The normalized execution snapshot could not be verified.',
  'Execute verification normally; an incomplete or modified snapshot cannot grant reuse.');
const blobDigest = (bytes: Buffer, length: number) => createHash(length === 64 ? 'sha256' : 'sha1')
  .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** One bounded binary subprocess; per-file Git processes would dominate Windows startup. */
async function readBlobs(root: string, ids: string[]): Promise<Map<string, Buffer>> {
  const distinct = [...new Set(ids)];
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'cat-file', '--batch'], {
      env: reuseGitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Snapshot Git timeout')); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumBytes) { child.kill(); reject(new Error('Snapshot is too large')); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Snapshot Git failed'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(distinct.map((id) => `${id}\n`).join(''));
  });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const id of distinct) {
    const end = output.indexOf(10, offset);
    if (end < offset) throw new Error('Missing object header');
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(output.subarray(offset, end).toString('ascii'));
    if (!match || match[1] !== id) throw new Error('Wrong object');
    const size = Number(match[2]);
    offset = end + 1;
    if (!Number.isSafeInteger(size) || offset + size >= output.length || output[offset + size] !== 10) throw new Error('Incomplete object');
    const bytes = output.subarray(offset, offset + size);
    if (blobDigest(bytes, id.length) !== id) throw new Error('Wrong object bytes');
    blobs.set(id, bytes);
    offset += size + 1;
  }
  if (offset !== output.length) throw new Error('Unexpected object output');
  return blobs;
}

/** The manifest stays outside the business snapshot and is bound by the native input digest. */
export async function materializeReuseSnapshot(root: string, inputs: ReuseInputs, destination: string): Promise<Evidence<ReuseTreeEntry[]>> {
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inputs.checkoutSha)) return unavailable();
    const raw = await exec('git', ['-C', root, 'ls-tree', '-r', '-z', '--full-tree', inputs.checkoutSha], {
      env: reuseGitEnvironment(), timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const entries = parseReuseTree(raw.stdout);
    if (!entries) return unavailable();
    const selected = entries.filter((entry) => entry.path !== '.specgit.yaml');
    if (reuseTreeDigest(selected) !== inputs.checkoutTreeDigest) return unavailable();
    const blobs = await readBlobs(root, entries.map((entry) => entry.blob));
    const binding = entries.find((entry) => entry.path === '.specgit.yaml');
    if (binding && (binding.mode !== '100644' || !recognizedBinding(blobs.get(binding.blob)!.toString('utf8')))) return unavailable();
    await mkdir(destination); // Refuse an existing destination, including links and nonempty trees.
    for (const entry of selected) {
      const target = path.join(destination, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, blobs.get(entry.blob)!, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      if (process.platform !== 'win32') await chmod(target, entry.mode === '100755' ? 0o755 : 0o644);
    }
    return verifyReuseSnapshot(destination, inputs.checkoutTreeDigest, selected);
  } catch { return unavailable(); }
}

/** Verify before dependency installation or execution introduces derived files. */
export async function verifyReuseSnapshot(root: string, expectedDigest: string, manifest: ReuseTreeEntry[]): Promise<Evidence<ReuseTreeEntry[]>> {
  try {
    if (!Array.isArray(manifest) || manifest.length > 10_000) return unavailable();
    const raw = manifest.map(({ mode, blob, path }) => `${mode} blob ${blob}\t${path}\0`).join('');
    const entries = parseReuseTree(raw);
    if (!entries || entries.some((entry) => entry.path === '.specgit.yaml') || reuseTreeDigest(entries) !== expectedDigest) return unavailable();
    const files = new Set<string>();
    const directories = new Set<string>();
    for (const entry of entries) {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    }
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) return unavailable();
    const visit = async (relative: string): Promise<void> => {
      for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (item.isSymbolicLink()) throw new Error('Links are not supported');
        if (item.isDirectory() && directories.has(name)) await visit(name);
        else if (item.isFile()) files.add(name);
        else throw new Error('Unexpected snapshot input');
      }
    };
    await visit('');
    if (files.size !== entries.length) return unavailable();
    let total = 0;
    for (const entry of entries) {
      if (!files.has(entry.path)) return unavailable();
      const target = path.join(root, entry.path);
      const stat = await lstat(target);
      total += stat.size;
      if (!stat.isFile() || stat.isSymbolicLink() || total > maximumBytes ||
          (process.platform !== 'win32' && Boolean(stat.mode & 0o111) !== (entry.mode === '100755'))) return unavailable();
      const bytes = await readFile(target);
      if (blobDigest(bytes, entry.blob.length) !== entry.blob) return unavailable();
    }
    return ok(entries);
  } catch { return unavailable(); }
}
