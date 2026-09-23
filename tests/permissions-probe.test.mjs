import { describe, expect, it } from 'vitest';
import {
  permissionTarget,
  validatePermissionsRequest,
} from '../scripts/gates/permissions-fixture.mjs';

const directory = '/private/tmp';
const request = () => ({
  method: 'item/permissions/requestApproval',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    environmentId: 'local',
    cwd: directory,
    reason: 'Fixed test',
    permissions: {
      network: { enabled: true },
      fileSystem: { read: null, write: [permissionTarget(directory)] },
    },
  },
});

describe('Live permissions probe admission guards', () => {
  it('admits the fixed network plus file request in legacy and entry forms', () => {
    expect(validatePermissionsRequest(request(), directory).method).toBe(
      'item/permissions/requestApproval',
    );
    const entries = request();
    entries.params.permissions.fileSystem = {
      read: null,
      write: null,
      entries: [{ path: { type: 'path', path: permissionTarget(directory) }, access: 'write' }],
    };
    expect(validatePermissionsRequest(entries, directory).params.permissions.network.enabled).toBe(
      true,
    );
  });
  it('rejects broader, remote, or incomplete requests before phone approval', () => {
    for (const alter of [
      (r) => (r.params.permissions.network = null),
      (r) => (r.params.permissions.fileSystem = null),
      (r) => r.params.permissions.fileSystem.write.push('/private/tmp/another-file'),
      (r) => (r.params.permissions.fileSystem.read = [permissionTarget(directory)]),
      (r) => (r.params.permissions.fileSystem.globScanMaxDepth = 1),
      (r) =>
        (r.params.permissions.fileSystem.entries = [
          { path: { type: 'path', path: permissionTarget(directory) }, access: 'read' },
        ]),
      (r) => (r.params.cwd = '/private'),
      (r) => (r.params.environmentId = 'remote'),
      (r) => (r.method = 'item/commandExecution/requestApproval'),
    ]) {
      const changed = request();
      alter(changed);
      expect(() => validatePermissionsRequest(changed, directory)).toThrow();
    }
  });
});
