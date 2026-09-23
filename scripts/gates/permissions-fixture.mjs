import { join } from 'node:path';
import { parseInteraction } from '../../src/tasks/interaction-policy.ts';

export const permissionTarget = (directory) => join(directory, 'm4-permission.txt');

export function permissionsPrompt(directory, cancel = false) {
  return `This is a harmless test of the request_permissions tool and client-side partial approval. Call request_permissions exactly once. Request network access and file write permission only for ${JSON.stringify(permissionTarget(directory))}. Use reason "M4 权限子集测试，只申请权限，不执行网络或文件操作". Do not request read permissions or other paths. Do not use any other tool, read files or personal data, write files, execute commands, or access the network. Wait for the actual tool response, then report the permission result in one short sentence prefixed with ${cancel ? 'M4_PERMISSIONS_CANCELLED' : 'M4_PERMISSIONS_SUBSET_OK'} and stop. A partial or empty grant is expected; do not retry or ask again.`;
}

/** Require the exact harmless mixed request before showing any phone approval. */
export function validatePermissionsRequest(request, directory) {
  const parsed = parseInteraction(request.method, request.params, directory);
  if (parsed.method !== 'item/permissions/requestApproval' || parsed.params.cwd !== directory)
    throw new Error('Expected a permission request in the test directory');
  const p = parsed.params.permissions;
  if (p.network?.enabled !== true || !p.fileSystem)
    throw new Error('Expected both network and file permissions');
  const fs = p.fileSystem;
  if (fs.read?.length || fs.globScanMaxDepth !== undefined)
    throw new Error('Unexpected file read or glob permissions');
  const writes = [...(fs.write ?? [])];
  for (const entry of fs.entries ?? []) {
    if (entry.access !== 'write') throw new Error('Unexpected file entry access');
    writes.push(entry.path.path);
  }
  if (!writes.length || writes.some((path) => path !== permissionTarget(directory)))
    throw new Error('Expected only the fixed test file');
  return parsed;
}
