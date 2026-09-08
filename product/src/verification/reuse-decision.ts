import type { Evidence } from '../kernel/evidence.js';
import type { ReuseInputs } from './reuse-inputs.js';

export interface ReuseExecutionRef {
  repository: string;
  run: string;
  attempt: number;
  job: string;
}

export interface OriginalExecution {
  ref: ReuseExecutionRef;
  profile: string;
  sourceSha: string;
  recipeDigest: string;
  inputDigest: string;
  completedAt: string;
}

/** Adapters must prove the native original execution and its approved recipe. */
export interface ReuseExecutionPort {
  /** Complete provider window, descending run/job identity; preserve unknown/failed originals inside it. */
  candidates(repository: string, profile: string): Promise<Evidence<ReuseExecutionRef[]>>;
  original(ref: ReuseExecutionRef): Promise<Evidence<OriginalExecution>>;
}

export interface ReuseContext {
  repository: string;
  profile: { id: string; maxAgeSeconds: number } | null;
  inputs: ReuseInputs;
}

export type ReuseDecision =
  | { mode: 'execute'; reason: string }
  | { mode: 'reuse'; original: ReuseExecutionRef; completedAt: string; inputDigest: string };

const key = (ref: ReuseExecutionRef) => JSON.stringify([ref.repository, ref.run, ref.attempt, ref.job]);
const validRef = (ref: ReuseExecutionRef, repository: string) => ref.repository === repository &&
  /^[1-9][0-9]*$/.test(ref.run) && /^[1-9][0-9]*$/.test(ref.job) && Number.isSafeInteger(ref.attempt) && ref.attempt > 0;

/** A cache miss executes; neither a miss nor a reuse decision is acceptance. */
export async function decideVerificationReuse(input: {
  current: () => Promise<Evidence<ReuseContext>>;
  executions: ReuseExecutionPort;
  now: number;
}): Promise<ReuseDecision> {
  const execute = (reason: string): ReuseDecision => ({ mode: 'execute', reason });
  try {
    const initial = await input.current();
    if (!initial.ok) return execute('inputs_unavailable');
    const { repository, profile, inputs } = initial.value;
    if (!profile) return execute('reuse_disabled');
    if (![inputs.sourceSha, inputs.checkoutSha, inputs.baseSha, inputs.policySha].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) ||
        ![inputs.digest, inputs.sourceTreeDigest, inputs.checkoutTreeDigest, inputs.recipeDigest, inputs.environmentDigest].every((value) => /^[a-f0-9]{64}$/.test(value))) return execute('inputs_unavailable');
    if (!Number.isFinite(input.now) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id) ||
        !Number.isSafeInteger(profile.maxAgeSeconds) || profile.maxAgeSeconds < 60 || profile.maxAgeSeconds > 86400) return execute('profile_invalid');
    const candidates = await input.executions.candidates(repository, profile.id);
    if (!candidates.ok) return execute('candidates_unavailable');
    const refs = candidates.value;
    if (refs.length > 20 || refs.some((ref) => !validRef(ref, repository)) || new Set(refs.map(key)).size !== refs.length) return execute('candidates_ambiguous');
    for (const ref of refs) {
      const result = await input.executions.original(ref);
      if (!result.ok) return execute('original_execution_unavailable');
      const original = result.value;
      const completed = Date.parse(original.completedAt);
      if (key(original.ref) !== key(ref) || original.profile !== profile.id ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(original.sourceSha) ||
          original.recipeDigest !== inputs.recipeDigest || original.inputDigest !== inputs.digest ||
          !Number.isFinite(completed) || completed > input.now || input.now - completed >= profile.maxAgeSeconds * 1000) continue;
      const refreshed = await input.current();
      if (!refreshed.ok || JSON.stringify(refreshed.value) !== JSON.stringify(initial.value)) return execute('current_inputs_changed');
      return { mode: 'reuse', original: original.ref, completedAt: original.completedAt, inputDigest: original.inputDigest };
    }
    return execute('no_eligible_original_execution');
  } catch { return execute('reuse_evidence_unavailable'); }
}
