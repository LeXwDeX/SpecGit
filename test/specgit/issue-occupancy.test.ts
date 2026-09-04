import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/acceptance/evaluate.js';
import { ok, fail } from '../../src/kernel/evidence.js';
import { makeGitFacts, makeGitPort, sampleBinding, samplePolicy } from '../specgit-cli/helpers.js';
import { makeCheckRun, makePrFact, MockForgeProvider } from './helpers/mock-forge.js';

const sha = 'a'.repeat(40);
const pr = makePrFact({ headSha: sha });
const competitor = makePrFact({ number: 43, headSha: sha, headBranch: pr.headBranch, draft: true });
function input(provider: MockForgeProvider) {
  return { root: ok('/repo'), record: ok(sampleBinding()), policy: ok(samplePolicy({ required_checks: ['CI'] })),
    git: makeGitPort(makeGitFacts({ headSha: sha })), gh: provider };
}

describe('live issue occupancy at acceptance', () => {
  it('rejects a manually bound delivery when another active request closes the same issue, even on the same head name', async () => {
    const provider = new MockForgeProvider({ pr: ok(pr), issuePullRequests: () => ok([pr, competitor]), checkRuns: ok([makeCheckRun('CI')]) });
    const result = await evaluate(input(provider));
    expect(result.exitCode).toBe(1);
    expect(result.gates.find((gate) => gate.id === 'pr')?.failures).toMatchObject([{ code: 'issue_already_claimed', detail: [{ issue: 123, pullRequests: [{ number: 43 }] }] }]);
  });

  it('rechecks after an earlier acceptance so a later concurrent claim cannot reuse stale evidence', async () => {
    let competing = false;
    const provider = new MockForgeProvider({ pr: ok(pr), issuePullRequests: () => ok(competing ? [pr, competitor] : [pr]), checkRuns: ok([makeCheckRun('CI')]) });
    expect((await evaluate(input(provider))).exitCode).toBe(0);
    competing = true;
    expect((await evaluate(input(provider))).exitCode).toBe(1);
    expect(provider.calls.filter((call) => call.startsWith('listIssuePullRequests:'))).toHaveLength(2);
  });

  it('preserves unavailable or truncated occupancy as unknown rather than unclaimed', async () => {
    const provider = new MockForgeProvider({ pr: ok(pr), issuePullRequests: () => fail('evidence_truncated', 'Related requests were truncated.') });
    const result = await evaluate(input(provider));
    expect(result.exitCode).toBe(3);
    expect(result.gates.find((gate) => gate.id === 'pr')?.failures).toMatchObject([{ code: 'issue_occupancy_unknown' }]);
  });
});
