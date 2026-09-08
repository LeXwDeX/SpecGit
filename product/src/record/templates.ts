import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { catalogFor } from '../i18n/language.js';
import type { Policy } from './policy.js';

export type TemplateKind = 'issue' | 'pr';
export interface TemplateContent {
  title: string;
  body: string;
  delivery?: string;
  issues?: number[];
}

/** Templates are policy data; supplied prose is substituted once and is never interpreted as a template. */
export function renderDeliveryTemplate(
  policy: Policy,
  kind: TemplateKind,
  content: TemplateContent,
): Evidence<{ title: string; body: string }> {
  const selected = policy.templates?.[kind];
  if (!selected) return ok({ title: content.title, body: content.body });
  const values: Record<string, string> = {
    title: content.title,
    summary: content.title.replace(/^[a-z]+:\s+/, ''),
    body: content.body,
    delivery: content.delivery ?? '',
    issues: (content.issues ?? []).map((n) => `#${n}`).join(', '),
  };
  for (const template of [selected.title ?? '{{title}}', selected.body]) {
    for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      if (!Object.hasOwn(values, match[1].trim())) return fail('template_variable_invalid',
        `Unsupported ${kind} template variable: ${match[1].trim()}.`,
        'Use title, summary, body, delivery or issues in project templates.');
    }
  }
  const render = (template: string) => template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, key: string) => values[key.trim()]);
  return ok({ title: render(selected.title ?? '{{title}}'), body: render(selected.body) });
}

/** Keep code as content evidence without treating examples as unfilled template variables. */
function proseForValidation(body: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  let codePresent = false;
  for (const line of body.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== undefined) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
        fence = undefined;
      } else if (line.trim() && !codePresent) {
        lines.push('[code evidence]');
        codePresent = true;
      }
    } else if (match) {
      fence = match[1];
      codePresent = false;
    } else {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/** Validate selected structural requirements; semantic adequacy remains review evidence. */
export function checkBodyConvention(policy: Policy, kind: TemplateKind, body: unknown): Evidence<true> {
  const explicit = policy.templates?.[kind]?.required_sections;
  if (policy.validation?.bodies !== true && explicit === undefined) return ok(true);
  if (typeof body !== 'string') return fail('body_evidence_missing', 'The forge did not provide the complete body.',
    'Retry after the issue or PR/MR body can be read.');
  const text = proseForValidation(body);
  const { scaffold } = catalogFor(policy.language ?? 'en');
  const headings = explicit ?? (kind === 'issue'
    ? [scaffold.issueWhy, scaffold.issueScope, scaffold.issueApproach, scaffold.issueAcceptance]
    : [scaffold.prWhy, scaffold.prWhat, scaffold.prEvidence, scaffold.prChecklist])
    .map((heading) => heading.replace(/^##\s+/, ''));
  const sections = new Map<string, string[]>();
  let section: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      if (!sections.has(section)) sections.set(section, []);
    } else if (section !== undefined) sections.get(section)!.push(line);
  }
  const missing = headings.filter((heading) => !(sections.get(heading.trim().toLowerCase()) ?? []).join('\n').trim());
  const placeholders = /^\s*(?:[-*]\s*)?(?:TODO|TBD|FIXME|待补充|待填写)\s*[.!。]?\s*$/imu.test(text) ||
    /\{\{\s*[^{}]+\s*\}\}/u.test(text) ||
    [scaffold.prWhyHint, scaffold.prWhatHint, scaffold.prEvidenceHint].some((hint) => text.split('\n').some((line) => line.trim() === hint.trim()));
  if (!text.trim() || missing.length > 0 || placeholders) return fail('body_content_incomplete',
    missing.length > 0 ? `Fill the required ${kind} sections: ${missing.join(', ')}.` : `Replace the unfilled ${kind} placeholders with delivery content.`,
    'Supply meaningful content using --body-file or --pr-body-file when creating work, or edit the existing remote body.');
  return ok(true);
}
