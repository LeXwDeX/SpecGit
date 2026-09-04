/**
 * The closing-reference grammar, parameterized per provider (#115).
 *
 * `github` (the default) is GitHub's closing-keyword grammar, unchanged.
 * `gitlab` is GitLab's default closing pattern, pinned at v19.2
 * (docs/evidence/gitlab-19.2.md, ledger rows 12-14): 16 keyword forms in
 * 4 families — close/closes/closed/closing, fix/fixes/fixed/fixing,
 * resolve/resolves/resolved/resolving, implement/implements/implemented/
 * implementing — initial-case or lowercase (all-caps never matches), an
 * optional colon, an optional issue(s) word, comma/`and` multi-reference
 * continuations, and the row-13 reference forms: local `#<iid>`,
 * cross-project `<full_path>#<iid>` (nested group paths anchored at docs
 * level), and full `https://<host>/<project_full_path>/-/issues/<iid>`
 * URLs. Work-item URLs, bracket refs, and external-tracker keys are
 * excluded by the pin.
 */
export type ClosingRefsDialect = 'github' | 'gitlab';

/** The repository whose issue numbers a scoped parse may return. */
export interface ClosingRefScope {
  projectPath: string;
  /** Forge web host, including its declared non-default port. */
  host?: string;
}

const GITHUB_CLOSING_REF_PATTERN =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+(?:#(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(\d+))/gi;

// GitLab's default closing pattern, transcribed from the pinned doc
// regex: keyword, optional colon, one or more spaces, an optional
// issue(s) word, then one or more references separated by comma/`and`
// continuations. Continuation whitespace may cross a line break: the
// pinned doc example closes a URL reference written on the next line.
const GITLAB_KEYWORD =
  '(?:[Cc]los(?:e[sd]?|ing)|[Ff]ix(?:e[sd]|ing)?|[Rr]esolv(?:e[sd]?|ing)|[Ii]mplement(?:s|ed|ing)?)';
const GITLAB_REF =
  '(?:https:\\/\\/\\S+\\/-\\/issues\\/(\\d+)|([A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)+)#(\\d+)|#(\\d+))';
const GITLAB_CONTINUATION = '(?:\\s*,?\\s+and\\s+|\\s*,?\\s*)';
const GITLAB_CLOSING_PHRASE = new RegExp(
  `\\b${GITLAB_KEYWORD}(:?) +(?:issues? +)?${GITLAB_REF}(?:${GITLAB_CONTINUATION}(?:issues? +)?${GITLAB_REF})*`,
  'g'
);
const GITLAB_REF_TOKEN = new RegExp(GITLAB_REF, 'g');

/**
 * GitHub's markdown-aware auto-close ignores closing keywords inside fenced
 * code blocks (``` or ~~~), so the parser must strip them before matching.
 * An unclosed fence hides the rest of the body, as GitHub renders it.
 */
function stripFencedCodeBlocks(body: string): string {
  const lines = body.split('\n');
  let fence: { char: string; length: number } | null = null;
  return lines
    .map((line) => {
      const open = fence;
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open === null) {
        if (match) {
          fence = { char: match[1][0], length: match[1].length };
          return '';
        }
        return line;
      }
      if (
        match !== null &&
        match[1][0] === open.char &&
        match[1].length >= open.length &&
        match[2].trim() === ''
      ) {
        fence = null;
      }
      return '';
    })
    .join('\n');
}

function referenceMatchesScope(
  scope: ClosingRefScope,
  projectPath: string | undefined,
  issueUrl: string | undefined
): boolean {
  if (issueUrl !== undefined) {
    if (scope.host === undefined) return false;
    try {
      const url = new URL(issueUrl);
      const expected = new URL(`https://${scope.host}`);
      if (url.origin !== expected.origin || url.username !== '' || url.password !== '') return false;
      projectPath = decodeURIComponent(url.pathname)
        .replace(/^\//, '')
        .replace(/\/(?:-\/)?issues\/\d+$/i, '');
    } catch {
      return false;
    }
  }
  // Bare #n is relative to the body repository; qualified references
  // retain their project identity until this comparison (#375).
  return projectPath === undefined || projectPath.toLowerCase() === scope.projectPath.toLowerCase();
}

interface ClosingReference {
  number: number;
  projectPath?: string;
  issueUrl?: string;
}

function closingReferences(body: string, dialect: ClosingRefsDialect): ClosingReference[] {
  const refs: ClosingReference[] = [];
  const searchable = stripFencedCodeBlocks(body);
  if (dialect === 'gitlab') {
    for (const phrase of searchable.matchAll(GITLAB_CLOSING_PHRASE)) {
      for (const ref of phrase[0].matchAll(GITLAB_REF_TOKEN)) {
        // Group map: 1 = URL iid, 3 = full-path iid (2 is the path itself),
        // 4 = local iid — same shape as the GitHub extraction.
        const number = ref[1] ?? ref[3] ?? ref[4];
        const issueUrl = ref[1] !== undefined ? ref[0] : undefined;
        if (number !== undefined) {
          refs.push({ number: Number(number), projectPath: ref[2], issueUrl });
        }
      }
    }
    return refs;
  }
  for (const match of searchable.matchAll(GITHUB_CLOSING_REF_PATTERN)) {
    const number = match[1] ?? match[3] ?? match[4];
    const issueUrl = match[4] !== undefined
      ? match[0].slice(match[0].toLowerCase().indexOf('https://'))
      : undefined;
    if (number !== undefined) {
      refs.push({ number: Number(number), projectPath: match[2], issueUrl });
    }
  }
  return refs;
}

/**
 * Pure parser over a PR body. The historical two-argument numeric API
 * is unchanged; acceptance supplies the optional repository scope.
 */
export function parseClosingRefs(
  body: string,
  dialect: ClosingRefsDialect = 'github',
  scope?: ClosingRefScope
): Set<number> {
  return new Set(closingReferences(body, dialect)
    .filter((ref) => scope === undefined || referenceMatchesScope(scope, ref.projectPath, ref.issueUrl))
    .map((ref) => ref.number));
}

/** Automation refuses body references that could close unrelated issues. */
export function hasUnboundClosingRefs(
  body: string,
  dialect: ClosingRefsDialect,
  scope: ClosingRefScope,
  issues: readonly number[]
): boolean {
  const bound = new Set(issues);
  return closingReferences(body, dialect).some((ref) =>
    !bound.has(ref.number) || !referenceMatchesScope(scope, ref.projectPath, ref.issueUrl));
}
