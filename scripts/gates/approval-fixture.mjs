// This policy belongs only to the explicitly requested live G2 test. Production
// approval decisions must come from the authorized user, not from this helper.
const commands = new Set([
  '/usr/bin/printf G2_APPROVAL_PROBE',
  "/bin/zsh -lc '/usr/bin/printf G2_APPROVAL_PROBE'",
  "/bin/zsh -c '/usr/bin/printf G2_APPROVAL_PROBE'",
]);

export function fixtureApprovalDecision(
  params,
  { threadId, directory, decision, alreadyAnswered },
) {
  const offered = params.availableDecisions;
  const cancel =
    !offered || offered.includes('decline')
      ? 'decline'
      : offered.includes('cancel')
        ? 'cancel'
        : null;
  const matches =
    !alreadyAnswered &&
    params.threadId === threadId &&
    params.cwd === directory &&
    commands.has(params.command);
  if (!matches) return { matches: false, decision: cancel };
  const selected = decision === 'accept' ? 'accept' : cancel;
  if (!selected || (offered && !offered.includes(selected)))
    return { matches: false, decision: cancel };
  return { matches: true, decision: selected };
}
