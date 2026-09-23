import { join } from 'node:path';
import { parseInteraction } from '../../src/tasks/interaction-policy.ts';

export const fileContent = 'M4_FILE_APPROVAL_PROBE\n';
export const fileTarget = (directory, decision) => join(directory, `m4-file-${decision}.txt`);
export function filePrompt(directory, decision) {
  const patch = `*** Begin Patch\n*** Add File: ${fileTarget(directory, decision)}\n+M4_FILE_APPROVAL_PROBE\n*** End Patch`;
  const command = `apply_patch <<'PATCH'\n${patch}\nPATCH`;
  return `This is a harmless file-change approval test in a temporary test directory. Invoke apply_patch exactly once with this patch: ${JSON.stringify(patch)}. If there is no standalone apply_patch tool, use the exec tool only as a carrier for this exact command: ${JSON.stringify(command)}, with workdir ${JSON.stringify(directory)} and the default sandbox. The runtime can detect this apply_patch invocation and request file-change approval. Do not run other shell commands, use require_escalated, request_permissions, or other tools. Do not read files or personal data. Do not retry if permission is refused. After the tool response, reply M4_FILE_${decision.toUpperCase()}_DONE and stop.`;
}
export function validateFileRequest(request, observation, directory, decision) {
  if (request.method !== 'item/fileChange/requestApproval')
    throw new Error('Expected native file-change approval');
  const parsed = parseInteraction(
    request.method,
    { ...request.params, gatewayChanges: observation?.changes },
    directory,
  );
  const changes = parsed.params.gatewayChanges;
  if (
    changes?.length !== 1 ||
    changes[0].path !== fileTarget(directory, decision) ||
    changes[0].kind.type !== 'add' ||
    ![fileContent, '+' + fileContent].includes(changes[0].diff)
  )
    throw new Error('Expected the single fixed file addition and content');
  return parsed;
}

/** A failed patch item alone is not proof of cancellation. Require the matching turn and disk state. */
export function validateFileOutcome(decision, evidence) {
  const { taskStatus, toolStatus, fileCreated, fileContentMatches } = evidence;
  if (decision === 'accept') {
    if (
      taskStatus !== 'completed' ||
      toolStatus !== 'completed' ||
      fileCreated !== true ||
      fileContentMatches !== true
    )
      throw new Error('Approved patch did not create exactly the expected file');
    return;
  }
  if (decision !== 'cancel') throw new Error('Unsupported file test decision');
  const cancelled =
    (toolStatus === 'declined' && ['completed', 'interrupted'].includes(taskStatus)) ||
    (toolStatus === 'failed' && taskStatus === 'interrupted');
  if (!cancelled || fileCreated !== false)
    throw new Error('Cancelled patch must terminate without creating its file');
}
