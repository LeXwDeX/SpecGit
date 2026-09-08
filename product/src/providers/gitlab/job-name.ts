// GitLab CI top-level configuration keys do not create executable jobs.
const reservedKeys = new Set([
  'stages', 'include', 'workflow', 'default', 'variables', 'image',
  'services', 'before_script', 'after_script', 'cache', 'types', 'spec',
]);

export function isGitLabJobName(value: string): boolean {
  return !value.startsWith('.') && !reservedKeys.has(value);
}
