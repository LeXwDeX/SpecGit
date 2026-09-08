import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { isGitLabJobName } from '../providers/gitlab/job-name.js';

const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
const localPath = z.string().max(300).regex(/^[A-Za-z0-9_.\/-]+$/).refine((value) =>
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git'));
/** Derived workflows cannot occupy authoritative declarations or local integration storage. */
export const ReuseWorkflowPathSchema = localPath.refine((value) =>
  /\.ya?ml$/.test(value) && value !== '.specgit.yaml' &&
  !/^(?:spec_git|\.specgit[^/]*|\.agents|\.codex|\.claude|\.opencode)(?:\/|$)/i.test(value),
{ message: 'Keep generated verification workflows outside declarations and local integration storage.' });
const command = z.array(z.string().max(4000).refine((value) => !/[\u0000\r\n]/.test(value))).min(1).max(100)
  .refine(([binary]) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(binary) &&
    !['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'pwsh', 'powershell'].includes(binary.toLowerCase()),
  { message: 'Use executable/argument arrays; shell evaluation is not part of the reusable recipe.' });
const environment = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine((key) =>
  !/^(?:CI(?:_|$)|GIT|GLAB|NODE_OPTIONS$|PATH$|HOME$|USERPROFILE$|SHELL$|COMSPEC$|SYSTEMROOT$|WINDIR$|TEMP$|TMP$|LD_|DYLD_)/.test(key) &&
  !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/.test(key)), z.string().max(1000).refine((value) => !/[\u0000\r\n]/.test(value)));

/** Opt-in verification only. Readiness, binding and current request checks always execute. */
export const ReuseProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60),
  check: z.string().min(1).max(200).refine((value) => value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/^SpecGit (?:(?:Acceptance|Completion)$|(?:prepare|dispatch|original|reused|uncached|not applicable) \/)/.test(value),
  { message: 'Use a public verification check name distinct from native SpecGit evidence jobs.' }),
  max_age_seconds: z.number().int().min(60).max(86400),
  node: version, pnpm: version,
  runtime: z.union([
    z.object({ package: z.string().regex(/^specgit@[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/), lockfile: localPath }).strict(),
    z.object({ archive: localPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), lockfile: localPath }).strict(),
  ]),
  commands: z.array(command).min(1).max(30),
  fresh_commands: z.array(command).max(30),
  environment: environment.default({}),
  github: z.object({
    runner: z.enum(['ubuntu-24.04', 'windows-2025', 'macos-15']),
    entry: z.string().regex(/^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/),
  }).strict().optional(),
  gitlab: z.object({
    image: z.string().max(300).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/),
    entry: ReuseWorkflowPathSchema, tags: z.array(z.string().min(1).max(100)).max(10),
    bootstrap: z.array(command).max(10).default([]),
  }).strict().optional(),
}).strict().refine((value) => value.github !== undefined || value.gitlab !== undefined,
  { message: 'Declare at least one fixed provider integration.' })
  .refine((value) => value.gitlab === undefined || isGitLabJobName(value.check),
    { path: ['check'], message: 'Use an executable GitLab job name, not a hidden job or CI configuration key.' })
  .refine((value) => {
    const inputs = [value.runtime.lockfile, ...('archive' in value.runtime ? [value.runtime.archive] : [])];
    const entries = [value.github?.entry, value.gitlab?.entry].filter((entry): entry is string => entry !== undefined);
    return entries.every((entry) => inputs.every((input) =>
      input !== entry && !input.startsWith(entry + '/') && !entry.startsWith(input + '/')));
  }, { message: 'Generated workflows must not overlap their runtime inputs.' });

export type ReuseProfile = z.infer<typeof ReuseProfileSchema>;
export interface ReuseEnvironmentFacts {
  platform: string; arch: string; node: string; pnpm: string; image: string; imageVersion: string;
  git: string; systemDigest: string;
}

export function reuseEnvironment(profile: ReuseProfile, platform: 'github' | 'gitlab', facts: ReuseEnvironmentFacts): Evidence<{ digest: string }> {
  const unavailable = () => fail<{ digest: string }>('verification_environment_unproven',
    'The actual runtime does not prove the approved reusable environment.',
    'Execute verification; unknown or changed runner/toolchain inputs cannot grant reuse.');
  const parsed = ReuseProfileSchema.safeParse(profile);
  if (!parsed.success || facts.node !== profile.node || facts.pnpm !== profile.pnpm ||
      !['linux', 'darwin', 'win32'].includes(facts.platform) || !['x64', 'arm64'].includes(facts.arch) ||
      !/^git version [0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9. ()-]*)$/.test(facts.git) || !/^[a-f0-9]{64}$/.test(facts.systemDigest)) return unavailable();
  if (platform === 'github') {
    const images = { 'ubuntu-24.04': ['linux', 'ubuntu24'], 'windows-2025': ['win32', 'win25'], 'macos-15': ['darwin', 'macos15'] };
    if (!profile.github || facts.platform !== images[profile.github.runner][0] ||
        facts.image !== images[profile.github.runner][1] || !/^[0-9]+(?:\.[0-9]+)+$/.test(facts.imageVersion)) return unavailable();
  } else if (!profile.gitlab || facts.platform !== 'linux' || facts.image !== profile.gitlab.image) return unavailable();
  return ok({ digest: createHash('sha256').update(JSON.stringify({ version: 1, provider: platform, ...facts,
    environment: Object.fromEntries(Object.entries(parsed.data.environment).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex') });
}
