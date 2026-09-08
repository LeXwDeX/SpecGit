import type { PrFact } from '../github/port.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { DeliveryBinding } from '../record/schema.js';
import type { ScopeDeclaration, ScopeMember } from './declaration.js';
import { observeHistoricalDelivery, readHistoricalBinding, type HistoricalDelivery, type HistoricalDependencies, type HistoricalObservation } from './historical-delivery.js';

export interface ScopeDiagnostic { code: string; message: string; fix?: string }
export interface MemberAssessment extends ScopeMember {
  state: 'completed' | 'incomplete' | 'open' | 'unbound' | 'closed_without_delivery' | 'ambiguous' | 'unknown';
  delivery?: HistoricalDelivery;
  diagnostics: ScopeDiagnostic[];
}
export interface ScopeAssessment {
  name: string;
  state: 'completed' | 'ready_to_close' | 'incomplete' | 'unknown';
  parent: { issue: number; state: 'open' | 'closed' | 'unknown' };
  members: MemberAssessment[];
  diagnostics: ScopeDiagnostic[];
}

/** A scope selects required work; each member's result still comes from delivery evidence. */
export async function assessScope(scope: ScopeDeclaration, deps: HistoricalDependencies): Promise<ScopeAssessment> {
  const bindings = new Map<number, Promise<Evidence<DeliveryBinding | null>>>();
  const deliveries = new Map<number, Promise<HistoricalObservation>>();
  const requestIdentities = new Map<number, string>();
  const members: MemberAssessment[] = [];
  const parent = await deps.forge.getIssue(deps.repo, scope.parent);
  const parentValid = parent.ok && parent.value.number === scope.parent && !parent.value.pullRequest;
  const diagnostics: ScopeDiagnostic[] = parentValid ? [] : [parent.ok
    ? { code: 'scope_parent_invalid', message: 'The declared parent was not confirmed as an issue.' } : parent];
  for (const member of scope.required) {
    const result: MemberAssessment = { ...member, state: 'unknown', diagnostics: [] };
    const unavailable = (error: ScopeDiagnostic) => { result.diagnostics.push(error); members.push(result); };
    const issue = await deps.forge.getIssue(deps.repo, member.issue);
    if (!issue.ok) { unavailable(issue); continue; }
    if (issue.value.number !== member.issue || issue.value.pullRequest) {
      unavailable({ code: 'scope_issue_invalid', message: 'The required member was not confirmed as an issue.' }); continue;
    }
    const candidates: Evidence<PrFact[]> = member.request === undefined
      ? await deps.forge.listIssuePullRequests(deps.repo, member.issue)
      : await deps.forge.getPr(deps.repo, member.request).then((pr) => pr.ok
        ? pr.value.number === member.request ? ok([pr.value]) : fail('scope_request_mismatch', 'The provider returned another request.') : pr);
    if (!candidates.ok) { unavailable(candidates); continue; }
    const matches: Array<{ request: PrFact; binding: DeliveryBinding }> = [];
    for (const request of [...new Map(candidates.value.map((pr) => [pr.number, pr])).values()]) {
      const identity = JSON.stringify(request);
      const previous = requestIdentities.get(request.number);
      if (previous !== undefined && previous !== identity) {
        result.diagnostics.push({ code: 'scope_request_changed', message: `Request #${request.number} changed between member observations. Retry with fresh evidence.` });
        continue;
      }
      requestIdentities.set(request.number, identity);
      if (request.baseBranch !== member.target || request.state === 'closed') continue;
      let pending = bindings.get(request.number);
      if (!pending) { pending = readHistoricalBinding(request, deps); bindings.set(request.number, pending); }
      const binding = await pending;
      if (!binding.ok) { result.diagnostics.push(binding); continue; }
      if (binding.value?.issues.includes(member.issue)) matches.push({ request, binding: binding.value });
    }
    if (result.diagnostics.length) { members.push(result); continue; }
    if (matches.length === 0) {
      result.state = issue.value.state === 'open' ? 'unbound' : 'closed_without_delivery';
      result.diagnostics.push({ code: 'scope_delivery_missing', message: `Issue #${member.issue} has no proven delivery into '${member.target}'.`,
        fix: 'Bind and complete the required delivery; select its request in the approved scope if discovery cannot identify it.' });
    } else if (matches.length > 1) {
      result.state = 'ambiguous';
      result.diagnostics.push({ code: 'scope_delivery_ambiguous', message: `Several bound requests claim issue #${member.issue}: ${matches.map((match) => match.request.number).join(', ')}.`,
        fix: 'Select the intended request in the scope declaration and merge that declaration into the remote default branch.' });
    } else {
      const { request, binding } = matches[0];
      if (request.state !== 'merged') result.state = 'open';
      else if (issue.value.state === 'open') {
        result.state = 'incomplete';
        result.diagnostics.push({ code: 'scope_closure_pending', message: `Issue #${member.issue} remains open.` });
      }
      else {
        let pending = deliveries.get(request.number);
        if (!pending) { pending = observeHistoricalDelivery(request, binding, deps); deliveries.set(request.number, pending); }
        const observed = await pending;
        result.state = observed.state;
        if (observed.state === 'completed') result.delivery = observed.delivery;
        else result.diagnostics.push(observed.diagnostic);
      }
    }
    members.push(result);
  }
  const unknown = !parentValid || members.some((member) => ['unknown', 'ambiguous'].includes(member.state));
  const allCompleted = members.every((member) => member.state === 'completed');
  return { name: scope.name, parent: { issue: scope.parent, state: parentValid && parent.ok ? parent.value.state : 'unknown' },
    state: unknown ? 'unknown' : !allCompleted ? 'incomplete' : parent.ok && parent.value.state === 'closed' ? 'completed' : 'ready_to_close',
    members, diagnostics };
}
