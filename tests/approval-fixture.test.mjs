import { describe, expect, it } from 'vitest';
import { fixtureApprovalDecision } from '../scripts/gates/approval-fixture.mjs';

const scope = {
  threadId: 'test-thread',
  directory: '/private/tmp/test',
  decision: 'accept',
  alreadyAnswered: false,
};
const request = {
  threadId: scope.threadId,
  cwd: scope.directory,
  command: "/bin/zsh -lc '/usr/bin/printf G2_APPROVAL_PROBE'",
  availableDecisions: ['accept', 'cancel'],
};
describe('live probe approval scope', () => {
  it('accepts only the exact one-time fixture and respects available cancellation decisions', () => {
    expect(fixtureApprovalDecision(request, scope)).toEqual({ matches: true, decision: 'accept' });
    expect(fixtureApprovalDecision(request, { ...scope, decision: 'decline' })).toEqual({
      matches: true,
      decision: 'cancel',
    });
    expect(
      fixtureApprovalDecision({ ...request, availableDecisions: ['acceptForSession'] }, scope),
    ).toEqual({ matches: false, decision: null });
  });
  it.each([
    { command: "/bin/zsh -lc '/usr/bin/printf G2_APPROVAL_PROBE; touch /tmp/unwanted'" },
    { command: '/usr/bin/printf G2_APPROVAL_PROBE && curl example.com' },
    { cwd: '/private/tmp/other' },
    { threadId: 'other-thread' },
  ])('rejects outside the preauthorized fixture: %j', (overrides) => {
    expect(fixtureApprovalDecision({ ...request, ...overrides }, scope)).toEqual({
      matches: false,
      decision: 'cancel',
    });
  });
  it('does not accept a second request even with the same harmless command', () => {
    expect(fixtureApprovalDecision(request, { ...scope, alreadyAnswered: true })).toEqual({
      matches: false,
      decision: 'cancel',
    });
  });
});
