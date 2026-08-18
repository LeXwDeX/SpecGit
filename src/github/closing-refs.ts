const CLOSING_REF_PATTERN =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+(?:#(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(\d+))/gi;

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

/**
 * Pure parser over a PR body: extracts issue numbers closed by GitHub closing
 * keywords. No network, no provider calls.
 */
export function parseClosingRefs(body: string): Set<number> {
  const refs = new Set<number>();
  if (!body) {
    return refs;
  }
  const searchable = stripFencedCodeBlocks(body);
  for (const match of searchable.matchAll(CLOSING_REF_PATTERN)) {
    const number = match[1] ?? match[3] ?? match[4];
    if (number !== undefined) {
      refs.add(Number(number));
    }
  }
  return refs;
}
