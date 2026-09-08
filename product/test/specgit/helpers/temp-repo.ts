import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function makeTempDir(prefix = 'specgit-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function isolatedGitEnv(tempDir: string): NodeJS.ProcessEnv {
  const emptyConfig = path.join(tempDir, 'gitconfig-empty');
  if (!fs.existsSync(emptyConfig)) {
    fs.writeFileSync(emptyConfig, '');
  }
  return {
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_AUTHOR_NAME: 'SpecGit Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'SpecGit Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
  };
}

export function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function initRepo(
  tempDir: string,
  options: { branch?: string } = {}
): { root: string; env: NodeJS.ProcessEnv } {
  const root = path.join(tempDir, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const env = isolatedGitEnv(tempDir);
  git(root, ['init', '-b', options.branch ?? 'main'], env);
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(root, ['add', 'README.md'], env);
  git(root, ['commit', '-m', 'initial'], env);
  return { root, env };
}

export function commitFile(
  root: string,
  rel: string,
  content: string,
  env?: NodeJS.ProcessEnv
): string {
  const filePath = path.join(root, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  git(root, ['add', rel], env ?? {});
  git(root, ['commit', '-m', `update ${rel}`], env ?? {});
  return git(root, ['rev-parse', 'HEAD'], env ?? {}).trim();
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
