import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gatewayConfigSchema } from '../config/schema.js';
import type { DesktopSettings } from './contracts.js';

// Imported extensions stay in the main/backend snapshot, outside renderer-editable settings.
export const legacySettingsSchema = z.strictObject({
  profileId: z.string().regex(/^[a-f0-9]{24}$/),
  service: gatewayConfigSchema.shape.service,
  notify: gatewayConfigSchema.shape.notify,
});
export type LegacySettings = z.infer<typeof legacySettingsSchema>;
export function profileId(settings: DesktopSettings) {
  return createHash('sha256').update(JSON.stringify(settings.feishu)).digest('hex').slice(0, 24);
}
export function legacyConfigFor(settings: DesktopSettings, legacy?: LegacySettings) {
  if (!legacy) return {};
  if (legacy.profileId !== profileId(settings))
    throw new Error('导入扩展只允许用于原飞书身份与会话');
  return { service: legacy.service, notify: legacy.notify };
}
