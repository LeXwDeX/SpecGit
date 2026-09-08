import type { GitPort } from '../gitfacts/port.js';
import type { readRecord } from '../record/io.js';
import type { bindingContextMismatch } from '../record/context-match.js';
export function withAcceptanceCheckout<T>(root: string, run: (checkout: string) => Promise<T>, dependencies: {
  readRecord: typeof readRecord;
  git: Pick<GitPort, 'facts'>;
  bindingContextMismatch: typeof bindingContextMismatch;
}): Promise<T>;
export function acceptanceMain(): Promise<void>;
export function prepareGitlabEventBranch(root?: string, env?: NodeJS.ProcessEnv): void;
