import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { DEFAULT_TAG_CATALOG } from '../tags/catalog.js';
import type { Policy } from './policy.js';

const HAN = /\p{Script=Han}/u;

/** A deterministic title character rule, not natural-language classification. */
export function checkTitleConvention(policy: Policy, title: unknown): Evidence<true> {
  if (policy.validation?.titles !== true) return ok(true);
  if (typeof title !== 'string' || title.trim() === '') {
    return fail('title_evidence_missing', 'The forge did not provide a nonempty title for project-rule validation.',
      'Retry once the issue or PR/MR title is available from the forge.');
  }
  const language = policy.language ?? 'en';
  const valid = language === 'en' ? !HAN.test(title) : HAN.test(title);
  if (valid) return ok(true);
  return fail('title_language_mismatch', language === 'en'
    ? 'The project requires English titles: Han characters are not allowed.'
    : 'The project requires Chinese titles: include at least one Han character; technical names may remain in English.',
  'Edit the remote issue or PR/MR title to follow the project language, then re-run specgit finish.');
}

/** The selected vocabulary is policy evidence; the mutable repository pool cannot expand it. */
export function checkLabelConvention(policy: Policy, labels: unknown): Evidence<true> {
  const mode = policy.validation?.labels ?? 'off';
  if (mode === 'off') return ok(true);
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    return fail('issue_labels_unavailable', 'The forge did not provide the complete issue label set.',
      'Retry once the issue labels are available from the forge.');
  }
  const names = [...new Set(labels as string[])];
  const kinds = new Set(DEFAULT_TAG_CATALOG.map((tag) => tag.name));
  const allowed = new Set(policy.tags?.map((tag) => tag.name) ?? []);
  if (mode === 'kind') for (const name of kinds) allowed.add(name);
  const axes = new Set<string>();
  const conflict = names.some((name) => {
    const axis = name.includes('::') ? name.split('::')[0] : null;
    if (axis === null) return false;
    if (axes.has(axis)) return true;
    axes.add(axis);
    return false;
  });
  if (names.length === 0 || names.some((name) => !allowed.has(name)) || conflict ||
      (mode === 'kind' && names.filter((name) => kinds.has(name)).length !== 1)) {
    return fail('issue_labels_invalid', mode === 'kind'
      ? 'Each issue requires exactly one known kind:: label; other labels must be declared in policy tags, with at most one per axis.'
      : 'Each issue requires a label from policy tags; every applied label must be declared, with at most one per axis.',
    'Choose issue labels from the project policy and remove conflicting or undeclared labels, then re-run specgit finish.');
  }
  return ok(true);
}
