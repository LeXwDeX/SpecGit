/**
 * `specgit setup` — installs the agent entry points (commands/skills) for
 * the detected or requested tool. Complements `init`; idempotent.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, type CommandOutcome } from '../output.js';
import type { CommandContext } from '../types.js';
import {
  detectSetupTool,
  writeAgentSurface,
  type SetupTool,
} from '../agent-surface.js';
import { catalogFor, commandLanguage } from '../language.js';

export interface SetupOptions {
  tool?: string;
  json?: boolean;
}

const TOOLS: ReadonlySet<string> = new Set(['opencode', 'generic', 'all']);

export async function runSetup(
  options: SetupOptions,
  ctx: CommandContext
): Promise<CommandOutcome> {
  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic(rootEv.code, rootEv.message, rootEv.fix ? { fix: rootEv.fix } : {})],
    };
  }
  const root = rootEv.value;

  const language = await commandLanguage(ctx, root);
  const { human: text } = catalogFor(language);

  let tool: SetupTool;
  if (options.tool !== undefined) {
    if (!TOOLS.has(options.tool)) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic('setup_tool_invalid', `Unknown tool "${options.tool}".`, {
            fix: 'Pass --tool opencode | generic | all, or omit to auto-detect.',
          }),
        ],
      };
    }
    tool = options.tool as SetupTool;
  } else {
    tool = await detectSetupTool(root);
  }

  try {
    const result = await writeAgentSurface(root, tool);
    return {
      exit: EXIT_SUCCESS,
      human: [
        text.setupTool(result.tool),
        text.setupInstalled(),
        ...result.installed.map((p) => `  - ${p}`),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('setup_write_failed', message)],
    };
  }
}
