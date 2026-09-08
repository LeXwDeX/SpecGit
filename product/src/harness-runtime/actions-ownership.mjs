/** @param {unknown} value @returns {value is number} */
function positiveIdentity(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** @param {unknown} app */
export function isGithubActionsApp(app) {
  return typeof app === 'object' && app !== null &&
    (('slug' in app && app.slug === 'github-actions') || ('id' in app && app.id === 15368));
}

/**
 * One ownership decision for the provider and embedded wait program.
 * Callers prove the head and list completeness before passing normalized rows.
 * Pending owners stay pending; callers decide which jobs must wait for them.
 * @template {import('./actions-ownership.mjs').ActionsWorkflow} T
 * @param {readonly T[]} workflows
 * @returns {import('./actions-ownership.mjs').ActionsOwnership<T>}
 */
export function createActionsOwnership(workflows) {
  /** @type {Map<string, T>} */
  const latest = new Map();
  /** @type {Map<number, T>} */
  const owners = new Map();
  const ids = new Set();
  for (const workflow of workflows) {
    const check = workflow.check;
    if (typeof workflow.key !== 'string' || !workflow.key ||
        !positiveIdentity(check.id) || !positiveIdentity(workflow.checkSuiteId) ||
        !positiveIdentity(workflow.runAttempt) || typeof check.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(check.startedAt)) || owners.has(workflow.checkSuiteId) ||
        ids.has(check.id) || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(check.status)) {
      throw new Error('GitHub returned incomplete or ambiguous Actions workflow ownership.');
    }
    owners.set(workflow.checkSuiteId, workflow);
    ids.add(check.id);
    const previous = latest.get(workflow.key);
    const started = Date.parse(check.startedAt);
    if (!previous || started > Date.parse(previous.check.startedAt ?? '') ||
        (started === Date.parse(previous.check.startedAt ?? '') && check.id > previous.check.id)) {
      latest.set(workflow.key, workflow);
    }
  }
  return {
    latest: [...latest.values()],
    currentFor(checkSuiteId) {
      if (!positiveIdentity(checkSuiteId)) {
        throw new Error('GitHub returned an Actions check without a check-suite identity.');
      }
      const owner = owners.get(checkSuiteId);
      if (!owner) throw new Error('The Actions check has no proven owning workflow run.');
      return latest.get(owner.key)?.check.id === owner.check.id ? owner : null;
    },
  };
}
