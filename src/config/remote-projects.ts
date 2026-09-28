import { z } from 'zod';
import { remotePermissionsSchema } from './project-policy.js';

// A local grant: remote messages supply a name, never a path or permissions.
export const remoteProjectCreationSchema = z.strictObject({
  enabled: z.boolean(),
  root: z.string().max(4096),
  permissions: remotePermissionsSchema,
});
export const defaultRemoteProjectCreation = () => ({
  enabled: false,
  root: '',
  permissions: { mode: 'disabled' as const, networkAccess: false },
});
