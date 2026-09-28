import { FeishuApiError } from '../feishu/api.js';

/** Only known diagnostics are safe to publish; arbitrary errors can contain credentials. */
export function gatewayErrorMessage(error: unknown): string {
  const known: Record<string, string> = {
    'Stop the existing worker before migrating':
      '数据库升级被旧 worker 运行锁阻止，请停止服务后重新启动 App。',
    'Stop the existing Gateway before migrating':
      '数据库升级被旧 Gateway 运行锁阻止，请停止服务后重新启动 App。',
    'Gateway migration checksum mismatch': '数据库迁移校验不一致，请保留数据并检查应用版本。',
    'Unsupported Gateway database schema version': '数据库版本不受当前应用支持，请使用兼容版本。',
    飞书长连接未就绪: '飞书长连接未就绪，请检查网络和飞书事件订阅配置。',
    '缺少飞书会话历史读取权限（99991672），请开通 im:message.history:readonly 并发布生效':
      '缺少飞书会话历史读取权限，请开通 im:message.history:readonly 并发布生效。',
  };
  if (error instanceof Error && Object.hasOwn(known, error.message)) return known[error.message]!;
  if (error instanceof FeishuApiError)
    return `飞书接口连接失败（HTTP ${error.httpStatus}，错误码 ${error.apiCode ?? '不可用'}），请在飞书连接页面检查凭据、权限和网络。`;
  return '网关启动或运行失败（gateway_unavailable），请停止连接后检查配置和日志再重试。';
}
