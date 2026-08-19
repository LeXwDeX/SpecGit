/**
 * `specgit` — delivery binding and acceptance harness.
 *
 * The execution context is a git branch or worktree; a delivery binds linked
 * GitHub issues and one pull request; acceptance is derived fail-closed from
 * real git, PR, and check evidence. Spec/task artifacts are not inputs.
 *
 * Output contract: `--json` puts exactly one JSON document on stdout and all
 * human text on stderr. Exit codes: 0 success/accepted · 1 rejected with
 * complete evidence · 2 usage error · 3 fail-closed unknown.
 */

import { Command, CommanderError } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { runAccept } from './commands/accept.js';
import { runBind } from './commands/bind.js';
import { runDoctor } from './commands/doctor.js';
import { runFinish } from './commands/finish.js';
import { runInit } from './commands/init.js';
import { runSetup } from './commands/setup.js';
import { runIssue } from './commands/issue.js';
import { runPr } from './commands/pr.js';
import { runStatus } from './commands/status.js';
import { runUnbind } from './commands/unbind.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from './exit-codes.js';
import {
  emitInterrupted,
  errorDiagnostic,
  finishOutcome,
  sanitize,
  type CommandOutcome,
} from './output.js';
import type { CliIO, CommandContext } from './types.js';
import { createDefaultContext, readPackageJson } from './wiring.js';

export type ContextResolution =
  | { ctx: CommandContext }
  | { failure: ReturnType<typeof errorDiagnostic> };

export type ContextResolver = () => Promise<ContextResolution>;

/**
 * The public command registry (#69): ten commands. `setup` is public;
 * `bind`/`unbind`/`accept` are automation aliases. Contract tests pin this
 * list against help output and the generated agent surface.
 */
export const COMMAND_NAMES = [
  'init',
  'setup',
  'issue',
  'pr',
  'finish',
  'bind',
  'unbind',
  'status',
  'accept',
  'doctor',
];

type CommandRun = (options: Record<string, unknown>, ctx: CommandContext) => Promise<CommandOutcome>;

function isPromptCancel(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string };
  return candidate?.name === 'ExitPromptError' || candidate?.code === 'ERR_USE_AFTER_EXIT';
}

function unexpectedOutcome(error: unknown): CommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exit: EXIT_UNKNOWN,
    errors: [errorDiagnostic('unexpected_error', message)],
    human: [`Error: ${sanitize(message)}`],
  };
}

function detectCommand(argv: string[]): string {
  const positional = argv.slice(2).find((token) => !token.startsWith('-'));
  return positional && COMMAND_NAMES.includes(positional) ? positional : 'specgit';
}

function usageOutcome(code: string, message: string): CommandOutcome {
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(code, message, {
        fix: 'Run "specgit --help" for the supported commands and flags.',
      }),
    ],
  };
}

export function createProgram(
  resolve: ContextResolver,
  io: CliIO,
  version: string,
  result: { exit: number },
  argv: string[]
): Command {
  const program = new Command();

  program
    .name('specgit')
    .description(
      'Delivery binding and acceptance harness: bind a branch or worktree to GitHub issues and one PR, then derive acceptance from real git, PR, and CI evidence.'
    )
    .version(version)
    .exitOverride()
    .configureOutput({
      writeOut: (text: string) => {
        for (const line of text.split('\n')) {
          io.stdout(line);
        }
      },
      writeErr: (text: string) => {
        for (const line of text.split('\n')) {
          io.stderr(line);
        }
      },
    })
    .option('--json', 'Output as JSON (stdout carries exactly one JSON document)')
    .addHelpText(
      'after',
      [
        '',
        'Environment:',
        '  SPECGIT_GH             Path to the gh executable (default: gh on PATH).',
        '  SPECGIT_GH_TIMEOUT_MS  Per-call gh timeout in milliseconds (default: 15000).',
        '',
        'Exit codes: 0 success/accepted · 1 rejected with complete evidence ·',
        '2 usage error · 3 fail-closed unknown. Ctrl-C at an interactive prompt',
        'exits 130 — the one interruption exception, outside the JSON envelope:',
        'stdout stays empty and "Interrupted." goes to stderr.',
      ].join('\n')
    );

  // Commander passes (…positional, options, Command); option-only
  // commands receive just (options, Command). The last argument is
  // always the Command; optional extractors fold positionals into the
  // options object a run function expects.
  const wrap = (
    name: string,
    run: CommandRun,
    extractOptions?: (rest: unknown[]) => Record<string, unknown>
  ) => {
    return async (...rest: unknown[]) => {
      const command = rest[rest.length - 1] as Command;
      const allOpts = command.optsWithGlobals() as Record<string, unknown>;
      const json = allOpts.json === true;
      const opts: Record<string, unknown> = extractOptions
        ? { ...extractOptions(rest), json: allOpts.json }
        : (rest[0] as Record<string, unknown>) ?? {};

      const resolution = await resolve();
      if ('failure' in resolution) {
        result.exit = finishOutcome(
          io,
          name,
          version,
          { exit: EXIT_UNKNOWN, errors: [resolution.failure] },
          json
        );
        return;
      }

      try {
        const outcome = await run(opts, resolution.ctx);
        result.exit = finishOutcome(io, name, version, outcome, json);
      } catch (error) {
        if (isPromptCancel(error)) {
          result.exit = emitInterrupted(io);
          return;
        }
        result.exit = finishOutcome(io, name, version, unexpectedOutcome(error), json);
      }
    };
  };

  const collect = (value: string, previous: string[]): string[] => [...previous, value];

  program
    .command('init')
    .description('Create spec_git/policy.yaml with the required CI check names and generate the harness')
    .option('--required-check <name>', 'Required check name; repeatable', collect, [])
    .option('--force', 'Rebuild spec_git/policy.yaml even when it already exists')
    .option('--no-detect', 'Skip auto-detection; require explicit --required-check')
    .option('--gitlab-host <hostname>', 'Declare a self-hosted GitLab host (bare hostname matching the origin)')
    .option('--protect', 'Enable branch protection + auto-merge without asking')
    .option('--no-protect', 'Skip the branch-protection probe and warning entirely')
    .option('--json', 'Output as JSON')
    .action(wrap('init', runInit as CommandRun));

  program
    .command('setup')
    .description('Install agent entry points: commands for opencode, portable skills for other tools')
    .option('--tool <tool>', 'opencode | generic | all (default: auto-detect)')
    .option('--json', 'Output as JSON')
    .action(wrap('setup', runSetup as CommandRun));

  program
    .command('issue')
    .description(
      'One-command delivery bootstrap: create/reuse issues, branch, draft PR, record — resumable'
    )
    .argument('[titles...]', 'Issue titles to create (quoted) or existing issue numbers to reuse')
    .option('--json', 'Output as JSON')
    .action(
      wrap('issue', runIssue as CommandRun, (rest) => ({
        titles: (rest[0] as string[]) ?? [],
        ...((rest[1] as Record<string, unknown>) ?? {}),
      }))
    );

  program
    .command('pr')
    .description('Repair the PR binding: auto-discover by head branch, or bind an explicit PR')
    .argument('[ref]', 'Pull request number or URL; omit to auto-discover by head branch')
    .option('--json', 'Output as JSON')
    .action(
      wrap('pr', runPr as CommandRun, (rest) => ({
        ref: rest[0] as string | undefined,
        ...((rest[1] as Record<string, unknown>) ?? {}),
      }))
    );

  program
    .command('finish')
    .description('Evidence verdict for the delivery (same evaluation as accept; the CI gate)')
    .option('--json', 'Output as JSON')
    .action(wrap('finish', runFinish as CommandRun));

  program
    .command('bind')
    .description(
      'Script alias: write or update .specgit.yaml; the execution context is taken from live git'
    )
    .option('--issue <n>', 'GitHub issue number or issue URL; repeatable, merged', collect, [])
    .option('--pr <ref>', 'Pull request number or URL (replaces)')
    .option('--delivery <kebab-id>', 'Delivery id (first bind only)')
    .option('--json', 'Output as JSON')
    .action(wrap('bind', runBind as CommandRun));

  program
    .command('unbind')
    .description('Script alias: delete .specgit.yaml (the policy is untouched)')
    .option('-y, --yes', 'Delete without confirmation')
    .option('--json', 'Output as JSON')
    .action(wrap('unbind', runUnbind as CommandRun));

  program
    .command('status')
    .description('Local evidence only: record, state, live context, drift, origin (no network)')
    .option('--json', 'Output as JSON')
    .action(wrap('status', runStatus as CommandRun));

  program
    .command('accept')
    .description(
      'Script/CI alias of finish: the same evidence verdict (automation surface)'
    )
    .option('--json', 'Output as JSON')
    .action(wrap('accept', runAccept as CommandRun));

  program
    .command('doctor')
    .description('Probe git, repository, origin, gh, and policy')
    .option('--json', 'Output as JSON')
    .action(wrap('doctor', runDoctor as CommandRun));

  program.action(() => {
    const json = argv.includes('--json');
    result.exit = finishOutcome(
      io,
      detectCommand(argv),
      version,
      usageOutcome('no_command', 'No command given.'),
      json
    );
  });

  return program;
}

export async function runCliWith(
  argv: string[],
  ctx: CommandContext,
  resolve?: ContextResolver
): Promise<number> {
  const result = { exit: EXIT_SUCCESS };
  const resolver: ContextResolver = resolve ?? (async () => ({ ctx }));
  const program = createProgram(resolver, ctx.io, ctx.version, result, argv);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        return EXIT_SUCCESS;
      }
      const json = argv.includes('--json');
      result.exit = finishOutcome(
        ctx.io,
        detectCommand(argv),
        ctx.version,
        usageOutcome('usage_error', error.message),
        json
      );
      return result.exit;
    }
    const json = argv.includes('--json');
    result.exit = finishOutcome(
      ctx.io,
      detectCommand(argv),
      ctx.version,
      unexpectedOutcome(error),
      json
    );
  }

  return result.exit;
}

export async function runMain(argv: string[] = process.argv): Promise<number> {
  const io: CliIO = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };

  let version = '0.0.0';
  try {
    version = readPackageJson().version;
  } catch {
    // Fallback version keeps --help/--version usable with a broken manifest.
  }

  let cached: CommandContext | undefined;
  const resolve: ContextResolver = async () => {
    cached ??= createDefaultContext();
    return { ctx: cached };
  };

  const result = { exit: EXIT_SUCCESS };
  const program = createProgram(resolve, io, version, result, argv);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        return EXIT_SUCCESS;
      }
      const json = argv.includes('--json');
      return finishOutcome(io, detectCommand(argv), version, usageOutcome('usage_error', error.message), json);
    }
    const json = argv.includes('--json');
    return finishOutcome(io, detectCommand(argv), version, unexpectedOutcome(error), json);
  }

  return result.exit;
}

export function runCli(argv: string[] = process.argv): void {
  void runMain(argv).then((code) => {
    process.exitCode = code;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
