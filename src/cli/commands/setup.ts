/**
 * `specgit setup` — installs the agent entry points (commands/skills) for
 * the detected or requested tool. Complements `init`; idempotent. Since
 * #307 a re-run is the version-upgrade refresh: the selected surface is
 * converged in one reversible transaction (current entry points refreshed,
 * retired SpecGit-owned entries removed with proven ownership, unowned
 * candidates preserved and reported) — the filesystem mechanics live in
 * `agent-surface.ts` and the reconciler, not here.
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { bulletItem, errorDiagnostic, humanBuilder, type SetupOutcome } from '../output.js';
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
): Promise<SetupOutcome> {
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
    // #307: a removal candidate we could not prove ownership for is
    // preserved verbatim — surfaced, never silently dropped.
    const warnings = result.reconciled.preserved.map((entryPath) => ({
      severity: 'warning' as const,
      code: 'unowned_asset_preserved',
      message: `${entryPath} is not provably SpecGit-owned (no managed markers in its content); left untouched.`,
      fix: 'If it is a leftover SpecGit artifact, remove it manually; otherwise it is yours to keep.',
    }));
    return {
      exit: EXIT_SUCCESS,
      // #168: the installed asset set is structured data — expose it on the
      // machine surface instead of leaving agents to scrape the prose.
      // #307 adds the reconciliation report (created/updated/removed/
      // preserved) alongside, additively.
      assets: {
        tool: result.tool,
        installed: result.installed,
        reconciled: result.reconciled,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      human: humanBuilder()
        .line(text.setupTool(result.tool))
        .line(text.setupInstalled())
        .append(result.installed.map(bulletItem))
        // #307: convergence speaks for itself — removed owned entries and
        // preserved unowned ones are the upgrade decisions a user audits.
        .append(result.reconciled.removed.map((entryPath) => text.setupRemovedAsset(entryPath)))
        .append(
          result.reconciled.preserved.map((entryPath) => text.setupPreservedAsset(entryPath))
        )
        .build(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit: EXIT_UNKNOWN,
      errors: [errorDiagnostic('setup_write_failed', message)],
    };
  }
}
