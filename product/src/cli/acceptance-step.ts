import { readFileSync } from 'node:fs';

export const GITLAB_ACCEPTANCE_PATH = '.gitlab/specgit-accept.mjs';
const marker = '// Managed by SpecGit: acceptance checkout adapter.\n';

/** One runtime source is embedded in both platforms' derived entry points. */
export function acceptanceScript(): string {
  return readFileSync(new URL('../harness-runtime/acceptance-checkout.mjs', import.meta.url), 'utf8')
    .replace(/\r\n?/g, '\n').trimEnd() + '\n\nif (process.argv[2] === \'--prepare-gitlab-event\') prepareGitlabEventBranch();\nelse await acceptanceMain();\n';
}

export function isSpecGitAcceptanceScript(content: string): boolean {
  return content.startsWith(marker);
}

export function acceptanceRunYaml(): string {
  return ["        run: |", "          node --input-type=module <<'SPECGIT_ACCEPTANCE'",
    ...acceptanceScript().trimEnd().split('\n').map((line) => line ? `          ${line}` : ''),
    '          SPECGIT_ACCEPTANCE'].join('\n');
}
