import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import { TaskError } from '../tasks/types.js';

export const credentialsSchema = z.object({
  appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
  appSecret: z.string().min(1).max(256),
  tenantKey: z.string().min(1),
  allowedOpenId: z.string().regex(/^ou_[a-zA-Z0-9]+$/),
  testChatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
});
export type FeishuCredentials = z.infer<typeof credentialsSchema>;
export function readCredentials(path: string): FeishuCredentials {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16_384
    )
      throw new Error();
    return credentialsSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } catch {
    throw new TaskError('飞书凭据必须为当前用户私有文件，且包含有效的五个字段');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function gatewayCredentials(config: GatewayConfig, supplied?: FeishuCredentials) {
  if (config.feishu.credentialsSource === 'desktop' && !supplied)
    throw new TaskError('桌面凭据仅可由 App 的私有进程通道提供');
  const credentials = supplied
    ? credentialsSchema.parse(supplied)
    : readCredentials(config.feishu.credentialsFile!);
  for (const field of ['appId', 'tenantKey', 'allowedOpenId'] as const)
    if (credentials[field] !== config.feishu[field])
      throw new TaskError('Gateway 与凭据中的身份不匹配');
  return credentials;
}
export const silentLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
