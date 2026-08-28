/**
 * `specgit issue [<title-or-number> ...]` — the one-command delivery
 * bootstrap: create/reuse N issues (one issue = one independently
 * verifiable WHY), create the branch `<type>/<first#>-<slug>`, open a
 * draft PR whose body is the deterministic scaffold rendered from the
 * bound issues (#87), write `.specgit.yaml`, commit and push. Re-runs
 * resume: every completed step is detected from the record and the live
 * branch, so a failure between steps heals on the next invocation with
 * the same arguments.
 *
 * Exactly-once discipline (issue #65): replacement arguments are
 * validated before any destructive side effect; the record is rewritten
 * after every issue so partial state is durable; and every remote side
 * effect carries an idempotency marker — the record itself, an open
 * issue's exact title (disambiguated by the deterministic scaffold body
 * on same-title collisions, #77), or the open PR for the head branch —
 * so a retry adopts what already exists instead of duplicating a WHY.
 * An idempotency marker that cannot name exactly one remote object is
 * drift the human resolves: `issue_title_ambiguous`, never a silent
 * adoption.
 *
 * The CLI is non-interactive: no arguments and no record is a usage
 * error (exit 2). With a live record, no arguments is a pure resume; a
 * record whose PR merged is completed history — no-args resume is a
 * usage error naming the way forward, and validated replacement
 * arguments re-bootstrap in its place (#75).
 *
 * Delivery naming (#246): the branch is always issue number + semantic
 * name (`<type>/<issue>-<slug>`), and bootstrap never invents a name. When
 * the title yields no ASCII slug, an interactive session is asked for
 * a kebab-case delivery name; anything else is a usage error naming
 * `--delivery <slug>`. Once recorded, resume reuses the name without
 * asking again.
 *
 * Structure (#177): `runIssue` is orchestration only; the readable,
 * individually testable steps live in named sub-functions —
 * `resolveMergedRecord` (read-only mergedness probe), `validateResumeArgs`
 * (positional resume validation), and `createOrAdoptIssues` (the issue
 * creation loop with durable per-issue record writes). The tail chain —
 * checkout, binding commit, push, PR binding, final record commit,
 * push — is the ordered step list of the DeliveryBootstrap module
 * (#278, ./bootstrap.ts).
 */

import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { deriveBindingState, resolveExecutionContext } from '../gates.js';
import { errorDiagnostic, humanBuilder, issueList, sanitize, type IssueOutcome } from '../output.js';
import { commandLanguage, catalogFor } from '../language.js';
import { isKebabId, KEBAB_ID_FIX, parseNumericRef, RECORD_FILENAME } from '../../record/schema.js';
import type { PolicyLanguage } from '../../record/policy.js';
import { DELIVERY_TYPES } from '../../tags/catalog.js';
import type { CommandContext, DeliveryBinding, Evidence, GitFacts, RepoRef } from '../types.js';
import type { OpenIssueFact } from '../../github/port.js';
import { BOOTSTRAP_STEPS, passthrough, recordWriteFailure, runBootstrapSteps } from './bootstrap.js';
import {
  applyDeliveryTags,
  validateExplicitTags,
  type ResolvedTagSelection,
} from './tagging.js';
import { inspectGeneratedAssets, type GeneratedAssetsReport } from '../asset-drift.js';

export interface IssueOptions {
  titles?: string[];
  json?: boolean;
  /** Explicit semantic delivery name (#246); wins over the title slug. */
  delivery?: string;
  /**
   * Raw `--tags` value (#330): comma-separated tag slugs. Defined ⇔
   * explicit selection mode (strict); undefined ⇔ inferred mode, which
   * applies only the title-linked `kind::<type>` candidate best-effort.
   */
  tags?: string;
}

/**
 * Conventional-commit types accepted as the `<type>` of the branch
 * name. Re-exported from the tags catalog (#330), which is the single
 * source of truth (#174): the validator below, the `specgit issue
 * --help` text, the usage-error fix, and the specgit-issue skill all
 * render from this list — the same list names the seeded `kind::` axis,
 * so a title's inferred tag always has a home.
 */
export const ISSUE_TITLE_TYPES = DELIVERY_TYPES;

const BRANCH_TYPES = new Set<string>(ISSUE_TITLE_TYPES);

const CONVENTIONAL_PREFIX = /^([a-z]+):\s+(.*)$/s;
export const ISSUE_TYPE_LIST = ISSUE_TITLE_TYPES.join(', ');

export function parseIssueTitle(title: string): { type: string; cleanTitle: string } {
  const match = CONVENTIONAL_PREFIX.exec(title.trim());
  if (match && BRANCH_TYPES.has(match[1])) {
    return { type: match[1], cleanTitle: match[2].trim() };
  }
  return { type: 'feat', cleanTitle: title.trim() };
}

/** First usage error among the titles, or null when every title conforms. Titles may be in any language (#118). */
export function validateIssueTitles(
  args: string[]
): { code: string; message: string; fix: string } | null {
  for (const arg of args) {
    if (parseNumericRef(arg) !== null || !arg) continue;
    const match = CONVENTIONAL_PREFIX.exec(arg.trim());
    if (!match || !BRANCH_TYPES.has(match[1])) {
      return {
        code: 'issue_type_invalid',
        message: `Issue title '${sanitize(arg)}' must start with a known <type>: prefix.`,
        fix: `Prefix the title with one of: ${ISSUE_TYPE_LIST}. Example: specgit issue "feat: add login".`,
      };
    }
  }
  return null;
}

/**
 * Kebab slug from the first three ASCII words of the title (#118: the
 * defined non-ASCII behavior). Any non-ASCII character in the title
 * yields '' — a mixed title's incidental ASCII words would make a
 * garbage slug, so slugging is all-or-nothing on ASCII-only titles.
 * An empty result is a naming gap the caller surfaces (#246): an
 * interactive session is asked for a name, a scripted one gets a usage
 * error naming `--delivery <slug>`. Never a silent `issue<N>`.
 */
export function slugifyTitle(title: string): string {
  if (!/^[\x20-\x7E]*$/.test(title)) {
    return '';
  }
  const words = title.match(/[A-Za-z0-9]+/g) ?? [];
  return words
    .slice(0, 3)
    .map((word) => word.toLowerCase())
    .join('-');
}

/** The interactive delivery-name prompt is bounded; EOF or exhaustion is a refusal, never a hang (#246). */
const DELIVERY_NAME_PROMPT_ATTEMPTS = 3;

/**
 * Default prompt transport (#246): the same prompt stack the init
 * command uses, writing to stderr so stdout keeps its parse-surface
 * contract. Returns the trimmed answer, or null on EOF/interrupt.
 */
async function terminalDeliveryNamePrompt(message: string): Promise<string | null> {
  try {
    const { input } = await import('@inquirer/prompts');
    const answer = await input({ message }, { output: process.stderr });
    return answer.trim();
  } catch {
    return null;
  }
}

/** The usage error for a delivery whose name cannot be resolved (#246). */
function deliveryNameRequiredError(reason: string): IssueOutcome {
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(
        'issue_delivery_name_required',
        `The delivery name could not be resolved: ${reason}`,
        {
          fix: 'Name the delivery explicitly — specgit issue <title-or-number> --delivery <slug> (kebab-case ASCII, e.g. add-login) — or use an ASCII issue title.',
        }
      ),
    ],
  };
}

/**
 * Delivery-name resolution (#246), in precedence order: an explicit
 * `--delivery` flag (the operator already named it) → the kebab slug of
 * the first ASCII title → an interactive prompt → a usage error. The
 * former silent `issue<N>` fallback is gone: a nameless delivery is a
 * gap the operator resolves, never one bootstrap papers over.
 *
 * Exported for the #246 naming tests: the precedence and prompt loop
 * are pure given the injected transport.
 */
export async function resolveDeliveryName(deps: {
  cleanTitle: string;
  override?: string;
  interactive: boolean;
  prompt: (message: string) => Promise<string | null>;
  promptText: string;
  retryText: string;
}): Promise<{ name: string } | IssueOutcome> {
  if (deps.override !== undefined) {
    return { name: deps.override };
  }
  const slug = slugifyTitle(deps.cleanTitle);
  if (slug && isKebabId(slug)) {
    return { name: slug };
  }
  if (!deps.interactive) {
    return deliveryNameRequiredError('the title yields no ASCII slug and no explicit name was given.');
  }
  for (let attempt = 0; attempt < DELIVERY_NAME_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = await deps.prompt(attempt === 0 ? deps.promptText : deps.retryText);
    if (answer === null) {
      break;
    }
    if (isKebabId(answer)) {
      return { name: answer };
    }
  }
  return deliveryNameRequiredError('no valid kebab-case name was entered.');
}

function issueBody(title: string, language: PolicyLanguage = 'en'): string {
  const { scaffold } = catalogFor(language);
  return [
    scaffold.issueWhy,
    title,
    '',
    scaffold.issueScope,
    '',
    scaffold.issueAcceptance,
    scaffold.issueAcceptanceLine,
    '',
  ].join('\n');
}

/**
 * Resolve a same-title collision (#77): an exact open-title match is
 * adoptable only when it is unambiguous — a single candidate, or a sole
 * candidate carrying this tool's deterministic scaffold body (the body a
 * specgit-created issue has, which an unrelated human issue with the
 * same title does not). Unresolvable collisions return null: the caller
 * surfaces a usage diagnostic instead of binding an issue that could be
 * unrelated. Never silent, never a guess.
 */
function disambiguateAdoption(
  arg: string,
  candidates: OpenIssueFact[],
  language: PolicyLanguage
): { candidate: OpenIssueFact } | { ambiguous: true } | { create: true } {
  if (candidates.length === 0) {
    return { create: true };
  }
  const unambiguous =
    candidates.length === 1 ? candidates : candidates.filter((c) => c.body === issueBody(arg, language));
  if (unambiguous.length === 1) {
    return { candidate: unambiguous[0] };
  }
  return { ambiguous: true };
}

function adoptionAmbiguousError(arg: string, candidates: OpenIssueFact[]): IssueOutcome {
  const listing = candidates.map((c) => `  #${c.number} ${c.title ?? arg}`).join('\n');
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(
        'issue_title_ambiguous',
        `Multiple open issues have the title '${sanitize(arg)}':\n${listing}`,
        {
          fix: `Adopt one explicitly by number (specgit issue <number>), or rename the unrelated issue so titles are unique, then re-run.`,
        }
      ),
    ],
  };
}

function recordSummary(record: DeliveryBinding): Record<string, unknown> {
  return {
    version: record.version,
    delivery: record.delivery,
    context: record.context,
    issues: record.issues,
    ...(record.pr !== undefined ? { pr: record.pr } : {}),
  };
}

/**
 * First title (non-numeric) argument in a consumed prefix: the argument
 * that produced the delivery's name. Deterministic from the arguments
 * alone, so a resumed run re-derives the same delivery and branch.
 */
function firstTitleArg(prefix: string[]): string | null {
  for (const arg of prefix) {
    if (arg && parseNumericRef(arg) === null) {
      return arg;
    }
  }
  return null;
}

function driftError(message: string): IssueOutcome {
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic('issue_resume_drift', message, {
        fix: 'Re-run with the original arguments (or none) to resume, or run "specgit unbind --yes" to start a new delivery.',
      }),
    ],
  };
}

/**
 * Usage validation for arguments that would create issues: non-empty and
 * conventionally typed. Runs before any side effect so invalid arguments
 * can never delete a record or create an issue.
 */
function validateArgsForCreation(args: string[]): IssueOutcome | null {
  for (const arg of args) {
    if (!arg && parseNumericRef(arg) === null) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic('issue_title_empty', 'Issue titles must not be empty.', {
            fix: 'Pass a non-empty quoted title, e.g. specgit issue "feat: add login".',
          }),
        ],
      };
    }
  }
  const invalid = validateIssueTitles(args);
  if (invalid) {
    return {
      exit: EXIT_USAGE,
      errors: [errorDiagnostic(invalid.code, invalid.message, { fix: invalid.fix })],
    };
  }
  return null;
}

/**
 * The #339 harness-currency gate: a bootstrap may only bind a delivery
 * under generated assets this CLI version produced. Returns the refusal
 * outcome when a surface is PROVEN stale, missing, or conflicting — the
 * fix rides the surface's own repair command — and null whenever the
 * environment cannot answer (probe throws) or reports no proven drift.
 * Read-only by construction; never a network call.
 */
async function harnessCurrencyGate(args: {
  root: string;
  ctx: CommandContext;
  facts: GitFacts;
}): Promise<IssueOutcome | null> {
  let report: GeneratedAssetsReport;
  try {
    const policyEv = await args.ctx.record.readPolicy(args.root);
    report = await inspectGeneratedAssets({ root: args.root, ctx: args.ctx, policy: policyEv, facts: args.facts });
  } catch {
    return null;
  }
  // Blocking drift is PROVEN and dangerous; absence is not. A surface
  // every asset of which is missing is a fresh adopt (nothing to be stale
  // against) — bootstrap proceeds. A surface with any stale/conflicting
  // asset, or only PARTIALLY present, was generated by some other state of
  // the world and must be refreshed before it binds a delivery.
  const drifted = report.surfaces.filter((surface) => {
    const states = surface.assets.map((asset) => asset.state);
    if (states.length === 0) {
      return false;
    }
    if (states.some((state) => state === 'stale' || state === 'conflict')) {
      return true;
    }
    const missing = states.filter((state) => state === 'missing').length;
    return missing > 0 && missing < states.length;
  });
  if (drifted.length === 0) {
    return null;
  }
  const fix = drifted.find((surface) => surface.fix !== undefined)?.fix ?? 'specgit init --force';
  const names = drifted.map((surface) => surface.surface).join(', ');
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(
        'harness_stale',
        `Generated harness assets are stale or conflicting for this CLI version (surfaces: ${names}).`,
        { fix: `Refresh them, then re-run this command: ${fix}. Probe the details with 'specgit doctor'.` }
      ),
    ],
  };
}

export async function runIssue(
  options: IssueOptions,
  ctx: CommandContext
): Promise<IssueOutcome> {
  const args = (options.titles ?? []).map((value) => value.trim());

  // #246: an explicit delivery name is validated like any other
  // argument — before any discovery or side effect.
  const deliveryOverride = options.delivery?.trim();
  if (
    options.delivery !== undefined &&
    (deliveryOverride === undefined || deliveryOverride === '' || !isKebabId(deliveryOverride))
  ) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic(
          'issue_delivery_name_invalid',
          `--delivery '${sanitize(options.delivery ?? '')}' is not a valid delivery name.`,
          { fix: `${KEBAB_ID_FIX} Example: specgit issue <title-or-number> --delivery add-login.` }
        ),
      ],
    };
  }

  const rootEv = await ctx.discoverRoot(ctx.cwd);
  if (!rootEv.ok) {
    return passthrough(rootEv);
  }
  const root = rootEv.value;

  const facts = await ctx.git.facts(root);
  const contextEv = resolveExecutionContext(facts);
  if (!contextEv.ok) {
    return passthrough(contextEv);
  }

  if (!facts.originUrl) {
    return {
      exit: EXIT_UNKNOWN,
      errors: [
        errorDiagnostic('no_origin', 'No origin remote is configured.', {
          fix: 'Add a GitHub origin: git remote add origin <url>.',
        }),
      ],
    };
  }
  const repoEv = await ctx.parseRepoRef(facts.originUrl);
  if (!repoEv.ok) {
    return passthrough(repoEv);
  }

  // Presentation language (#118): policy-driven, fail-open, never a
  // verdict input. Resolved once; every generated body and human line
  // below renders through it.
  const language = await commandLanguage(ctx, root);
  const { human } = catalogFor(language);

  const existingRead = await ctx.record.readRecord(root);
  if (!existingRead.ok && existingRead.code !== 'record_missing') {
    return passthrough(existingRead);
  }

  // #339: the harness is the contract the agent reads — bind no new
  // delivery under assets generated by an older CLI version. Proven
  // staleness refuses before any forge contact; an uninspectable or
  // merely-unknown environment never blocks (status and doctor own drift
  // visibility), and absent assets keep the fresh-adopt flow working.
  const gate = await harnessCurrencyGate({ root, ctx, facts });
  if (gate !== null) {
    return gate;
  }

  const mergedEv = await resolveMergedRecord(ctx, repoEv.value, existingRead.ok ? existingRead : null);
  if ('exit' in mergedEv) {
    return mergedEv;
  }
  let existing = mergedEv.existing;

  // A merged record has nothing to resume: no-args resume would re-run
  // the branch/commit/push steps and resurrect the head branch GitHub
  // auto-deleted on merge. End the lifecycle decision before any side
  // effect, naming the way forward (#75).
  if (existing !== null && existing.ok && mergedEv.merged && args.length === 0) {
    return mergedDeliveryError(existing.value);
  }

  // Validate arguments BEFORE any destructive side effect, scoped to what
  // those arguments would actually do:
  //  - fresh bootstrap: every argument is validated (today's contract);
  //  - merged-record replacement: validated before the record is deleted;
  //  - live resume: arguments are resume keys, not titles-to-create —
  //    only the still-unconsumed arguments of a partial record, the ones
  //    that would create issues, are validated.
  // Invalid or absent arguments never delete or mutate the record.
  if (existing === null) {
    if (args.length === 0) {
      return {
        exit: EXIT_USAGE,
        errors: [
          errorDiagnostic('issue_args_required', 'specgit issue needs at least one issue.', {
            fix: 'Pass one or more quoted issue titles to create, or existing issue numbers to reuse, e.g. specgit issue "feat: add login".',
          }),
        ],
      };
    }
    const invalidFresh = validateArgsForCreation(args);
    if (invalidFresh) {
      return invalidFresh;
    }
  }

  // Replace a merged record only with validated replacement arguments.
  if (existing !== null && existing.ok && mergedEv.merged && args.length > 0) {
    const invalidReplacement = validateArgsForCreation(args);
    if (invalidReplacement) {
      return invalidReplacement;
    }
    await ctx.record.deleteRecord(root);
    existing = null;
  }

  // Resume: the record is the durable step marker; the arguments map
  // onto it positionally, and the resolution names where creation (if
  // any) continues.
  const liveRecord = existing !== null && existing.ok ? existing.value : null;
  const resumed = liveRecord !== null;
  const resume = liveRecord !== null ? validateResumeArgs(liveRecord, args) : null;
  if (resume !== null && 'exit' in resume) {
    return resume;
  }
  const startIndex = resume !== null ? resume.startIndex : 0;

  // #330: explicit --tags resolves BEFORE any issue is created — a typo
  // in the selection must never leave a created issue behind. The pool
  // probe here is a read; its snapshot travels into the apply step.
  const rawTags = options.tags?.split(',').map((token) => token.trim()).filter((t) => t !== '');
  let tagPre: ResolvedTagSelection | undefined;
  if (rawTags !== undefined && rawTags.length > 0) {
    const validated = await validateExplicitTags({
      ctx,
      root,
      repo: repoEv.value,
      language,
      tokens: [...rawTags],
    });
    if ('exit' in validated) {
      return validated;
    }
    tagPre = validated.pre;
  }

  // #246: naming is interactive only on a real terminal — a `--json`
  // run keeps stdout a pure parse surface, so it never prompts.
  const interactive = options.json !== true && ctx.stdinIsTTY;

  const created = await createOrAdoptIssues({
    ctx,
    root,
    repo: repoEv.value,
    language,
    context: contextEv.value,
    record: liveRecord,
    args,
    startIndex,
    firstTitle: resume !== null ? resume.firstTitle : null,
    deliveryOverride,
    interactive,
  });
  if ('exit' in created) {
    return created;
  }
  let record = created.record;
  const firstTitle = created.firstTitle;

  // #330: the tag step runs after every bound issue is durable in the
  // record — created, adopted, or resumed alike — and before the PR
  // chain, so the traceability story lands in one invocation. The
  // inferred candidate is the title's `<type>` on the kind axis; an
  // explicit --tags replaces it wholesale (already pre-validated above).
  const inferredSlug =
    rawTags !== undefined || firstTitle === null
      ? null
      : `kind::${parseIssueTitle(firstTitle).type}`;
  const tagging = await applyDeliveryTags({
    ctx,
    root,
    repo: repoEv.value,
    language,
    issues: record.issues,
    requested: rawTags === undefined ? undefined : [...rawTags],
    inferredSlug,
    ...(tagPre !== undefined ? { pre: tagPre } : {}),
  });
  if ('exit' in tagging) {
    return tagging;
  }

  // #278: the tail chain is data — the DeliveryBootstrap module's
  // ordered steps (checkout → commit binding → push head → bind PR →
  // commit record → push). Each step carries its precondition and
  // resume marker, so a re-run from any partial state converges;
  // reordering is a change to BOOTSTRAP_STEPS, reviewable as such.
  const chained = await runBootstrapSteps(BOOTSTRAP_STEPS, {
    ctx,
    root,
    repo: repoEv.value,
    language,
    record,
    firstTitle,
    facts,
  });
  if ('exit' in chained) {
    return chained;
  }
  record = chained.record;

  const target = record.context.branch;

  // #330: one summary line when tags were part of this run; skipped runs
  // stay silent so the quick bootstrap's stderr keeps its old shape.
  const builder = humanBuilder()
    .line(human.issueHeader(resumed, record.delivery))
    .line(human.issueBranch(target))
    .line(human.issueIssues(issueList(record.issues)));
  if (tagging.status === 'applied' || tagging.seeded.length > 0 || tagging.applied.length > 0) {
    builder.line(
      human.issueTags(
        tagging.applied.join(', '),
        tagging.seeded.length > 0 ? tagging.seeded.join(', ') : null
      )
    );
  }
  return {
    exit: EXIT_SUCCESS,
    state: deriveBindingState(record),
    record: recordSummary(record),
    human: builder
      .line(human.issuePr(record.pr as number | string))
      .line(human.issueRecorded(RECORD_FILENAME))
      .build(),
  };
}

/**
 * Read-only mergedness probe (#75): a record whose PR already merged is
 * completed history, not an active delivery. Provider failures keep the
 * existing record (fail-closed — never guess merged): resuming on a guess
 * of "not merged" could re-push the branch GitHub deleted on merge.
 * `pr_not_found` is the one exception (#284): it is a fact, not a probe
 * failure — a bound PR that does not exist on this platform can never
 * merge, so the lifecycle is terminal like a merged one (a mirror
 * repository's record names the other platform's PR number).
 */
async function resolveMergedRecord(
  ctx: CommandContext,
  repo: RepoRef,
  existing: Evidence<DeliveryBinding> | null
): Promise<IssueOutcome | { existing: Evidence<DeliveryBinding> | null; merged: boolean }> {
  if (existing === null || !existing.ok || existing.value.pr === undefined) {
    return { existing, merged: false };
  }
  const prEv = await ctx.gh.getPr(repo, existing.value.pr);
  if (!prEv.ok) {
    if (prEv.code === 'pr_not_found') {
      return { existing, merged: true };
    }
    return passthrough(prEv);
  }
  return { existing, merged: prEv.value.state === 'merged' };
}

/** The no-args refusal for a record whose PR is terminal: merged or absent (#75, #284). */
function mergedDeliveryError(record: DeliveryBinding): IssueOutcome {
  return {
    exit: EXIT_USAGE,
    errors: [
      errorDiagnostic(
        'issue_delivery_merged',
        `Delivery '${record.delivery}' has no live pull request (PR #${record.pr} is merged or does not exist on this platform); there is nothing to resume.`,
        {
          fix: 'Start the next delivery with replacement arguments, e.g. specgit issue "feat: next why", or run "specgit unbind --yes" to clear the terminal record.',
        }
      ),
    ],
  };
}

/**
 * Resume validation (#177 extraction): map replacement arguments onto a
 * live record positionally. Every recorded issue is a consumed argument;
 * numeric arguments are verifiable against the binding, and creation
 * continues only from a partial record without a PR. Any mismatch is
 * drift, refused with zero side effects.
 */
function validateResumeArgs(
  record: DeliveryBinding,
  args: string[]
): IssueOutcome | { startIndex: number; firstTitle: string | null } {
  const issues = [...record.issues];
  if (args.length === 0) {
    return { startIndex: issues.length, firstTitle: null };
  }
  if (args.length < issues.length) {
    return driftError(
      `This checkout already carries delivery '${record.delivery}' with ${record.issues.length} bound issue(s); the ${args.length} argument(s) do not match.`
    );
  }
  if (args.length === issues.length) {
    // Numeric arguments are verifiable and must be bound already. Title
    // arguments cannot be matched to numbers post-creation; the count
    // check above is their guard, and a complete record never creates.
    for (const arg of args) {
      const number = parseNumericRef(arg);
      if (number !== null && !record.issues.includes(number)) {
        return driftError(
          `Argument '${sanitize(arg)}' is not among the issues bound to delivery '${record.delivery}'.`
        );
      }
    }
    return { startIndex: issues.length, firstTitle: null };
  }
  // Partial continuation (issues ⊂ args) is only possible while the
  // bootstrap is incomplete: no PR recorded yet. A record with a PR
  // bound is a complete delivery — a finished bootstrap never creates
  // issues, so surplus arguments are drift, refused with zero side
  // effects before any probe or create.
  if (record.pr !== undefined) {
    return driftError(
      `This checkout already carries the complete delivery '${record.delivery}' with ${record.issues.length} bound issue(s) and PR #${record.pr}; the ${args.length} argument(s) do not match.`
    );
  }
  // Partial record (issues ⊂ args): the first issues.length arguments
  // were consumed by the previous run — numeric ones are verified
  // positionally — and creation continues from there.
  for (let i = 0; i < issues.length; i += 1) {
    const number = parseNumericRef(args[i]);
    if (number !== null && number !== issues[i]) {
      return driftError(
        `Argument '${sanitize(args[i])}' is not among the issues bound to delivery '${record.delivery}'.`
      );
    }
  }
  const firstTitle = firstTitleArg(args.slice(0, issues.length));
  // The remaining arguments will create issues: validate them before
  // any side effect.
  const invalidRemaining = validateArgsForCreation(args.slice(issues.length));
  if (invalidRemaining) {
    return invalidRemaining;
  }
  return { startIndex: issues.length, firstTitle };
}

/**
 * The issue creation loop (#177 extraction): for every unconsumed
 * argument, reuse the number, adopt an unambiguous same-title open issue
 * (#77), or create fresh — then persist the record after every issue so
 * any failure heals on the next invocation without re-creating. The
 * delivery name is resolved once before any remote side effect (#246);
 * a resume keeps the recorded name.
 *
 * Exported for the #216 guard test: the function proves its own null-record
 * precondition with an explicit runtime guard instead of a type assertion.
 */
export async function createOrAdoptIssues(deps: {
  ctx: CommandContext;
  root: string;
  repo: RepoRef;
  language: PolicyLanguage;
  context: DeliveryBinding['context'];
  record: DeliveryBinding | null;
  args: string[];
  startIndex: number;
  firstTitle: string | null;
  /** Explicit `--delivery` name; wins over the title slug (#246). */
  deliveryOverride?: string;
  /** Real-terminal session: the naming gap may be asked (#246). */
  interactive?: boolean;
  /** Injectable prompt transport; defaults to the terminal prompt (#246). */
  promptDeliveryName?: (message: string) => Promise<string | null>;
}): Promise<IssueOutcome | { record: DeliveryBinding; firstTitle: string | null }> {
  const { ctx, root, repo, language, context } = deps;
  const issues = deps.record !== null ? [...deps.record.issues] : [];
  let record: DeliveryBinding | null = deps.record;
  let firstTitle = deps.firstTitle;

  // #246: resolve the delivery name BEFORE any remote side effect — a
  // nameless bootstrap is a usage error and must never leave a created
  // issue behind. Precedence: the recorded name on resume (never ask
  // twice) → explicit `--delivery` → the ASCII title slug → an
  // interactive prompt → a usage error naming the explicit flag.
  let delivery: string;
  if (deps.record !== null) {
    delivery = deps.record.delivery;
  } else {
    const { human } = catalogFor(language);
    const titleArg = firstTitleArg(deps.args);
    const cleanTitle = titleArg !== null ? parseIssueTitle(titleArg).cleanTitle : '';
    const resolved = await resolveDeliveryName({
      cleanTitle,
      override: deps.deliveryOverride,
      interactive: deps.interactive === true,
      prompt: deps.promptDeliveryName ?? terminalDeliveryNamePrompt,
      promptText: human.deliveryNamePrompt(),
      retryText: human.deliveryNameRetry(),
    });
    if ('exit' in resolved) {
      return resolved;
    }
    delivery = resolved.name;
  }

  // Remotely discoverable idempotency marker for issue creation: an open
  // issue whose title exactly matches a pending title argument is that
  // argument's issue — a previous run created it but failed to record it
  // (lost response, crash, or failed record write). Adopt it instead of
  // duplicating the WHY. One title-carrying scan of the open issues
  // (#77) replaces the former per-issue probe fan-out, so the probe cost
  // is bounded by pages, not by the open-issue count. Probe failures
  // fail closed: never guess.
  const remaining = deps.args.slice(deps.startIndex);
  const adoptable = new Map<string, OpenIssueFact[]>();
  if (remaining.some((arg) => parseNumericRef(arg) === null)) {
    const openEv = await ctx.gh.getOpenIssues(repo);
    if (!openEv.ok) {
      return passthrough(openEv);
    }
    for (const fact of openEv.value) {
      if (typeof fact.title === 'string' && fact.title) {
        const bucket = adoptable.get(fact.title) ?? [];
        bucket.push(fact);
        adoptable.set(fact.title, bucket);
      }
    }
  }

  for (let i = deps.startIndex; i < deps.args.length; i += 1) {
    const arg = deps.args[i];
    let number: number;
    const reuseNumber = parseNumericRef(arg);
    if (reuseNumber !== null) {
      number = reuseNumber;
    } else {
      // Same-title adoption is disambiguated, never silent (#77): an
      // exact title match binds only when it is unambiguous — one
      // candidate, or a sole candidate carrying the deterministic
      // scaffold body. An issue already bound in this run is not a
      // candidate again; a repeated title argument creates fresh.
      const bucket = adoptable.get(arg) ?? [];
      const unbound = bucket.filter((c) => !issues.includes(c.number));
      const resolved = disambiguateAdoption(arg, unbound, language);
      if ('ambiguous' in resolved) {
        return adoptionAmbiguousError(arg, unbound);
      }
      if ('candidate' in resolved) {
        bucket.splice(bucket.indexOf(resolved.candidate), 1);
        number = resolved.candidate.number;
      } else {
        const created = await ctx.gh.createIssue(repo, arg, issueBody(arg, language));
        if (!created.ok) {
          return passthrough(created);
        }
        number = created.value.number;
      }
      if (firstTitle === null) {
        firstTitle = arg;
      }
    }
    issues.push(number);

    // Durable resumable state: rewrite the record after every issue so
    // any failure heals on the next invocation without re-creating.
    const { type } =
      firstTitle !== null ? parseIssueTitle(firstTitle) : { type: 'feat' };
    const branch = `${type}/${issues[0]}-${delivery}`;
    record = {
      version: 1,
      delivery,
      context: { ...context, branch },
      issues: [...issues],
    };
    try {
      await ctx.record.writeRecord(root, record);
    } catch (error) {
      return recordWriteFailure(error);
    }
  }

  // #216: the loop above assigns `record` on every iteration, so it stays
  // null only when no iteration ran (no unconsumed arguments). runIssue's
  // pre-validation makes that path unreachable in production — but this
  // function proves the precondition explicitly instead of asserting it.
  if (record === null) {
    return {
      exit: EXIT_USAGE,
      errors: [
        errorDiagnostic('issue_args_required', 'specgit issue needs at least one issue.', {
          fix: 'Pass one or more quoted issue titles to create, or existing issue numbers to reuse, e.g. specgit issue "feat: add login".',
        }),
      ],
    };
  }
  return { record, firstTitle };
}
