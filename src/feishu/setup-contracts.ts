import { z } from 'zod';

// One manifest drives registration and the offline batch-import tutorial.
export const FEISHU_SETUP_MANIFEST = {
  scopes: {
    tenant: [
      'im:message.p2p_msg:readonly',
      'im:message:send_as_bot',
      'im:message.history:readonly',
    ],
    user: [] as string[],
  },
  events: ['im.message.receive_v1'],
  callbacks: ['card.action.trigger'],
};
export const BIND_PREFIX = '/connector-bind';
export const isBindingCommand = (text: string) => /^\s*\/connector-bind(?:\s|$)/i.test(text);
export const appIdentitySchema = z.object({
  appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
  appSecret: z.string().min(1).max(256),
});
export const bindingSchema = z.object({
  tenantKey: z.string().min(1).max(256),
  allowedOpenId: z.string().regex(/^ou_[a-zA-Z0-9]+$/),
  testChatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
});
export type FeishuBinding = z.infer<typeof bindingSchema>;
export const checkItemSchema = z.object({
  status: z.enum(['pending', 'passed', 'failed', 'skipped']),
  message: z.string(),
});
export const feishuCheckSchema = z.object({
  status: z.enum(['checking', 'passed', 'failed', 'skipped', 'changed']),
  checkedAt: z.number().nullable(),
  credentials: checkItemSchema,
  history: checkItemSchema,
  websocket: checkItemSchema,
});
export type FeishuCheckResult = z.infer<typeof feishuCheckSchema>;
export const unchecked = (status: FeishuCheckResult['status'] = 'skipped'): FeishuCheckResult => ({
  status,
  checkedAt: null,
  credentials: { status: 'pending', message: '尚未检查' },
  history: { status: 'pending', message: '尚未检查' },
  websocket: { status: 'pending', message: '尚未检查' },
});
export const feishuFieldsSchema = z.object({
  appId: z.string().max(256),
  tenantKey: z.string().max(256),
  allowedOpenId: z.string().max(256),
  testChatId: z.string().max(256),
});
export const flowEditorSchema = z.object({
  revision: z.string().uuid(),
  mode: z.enum(['create', 'existing']),
  step: z.number().int().min(1).max(4),
  name: z.string().max(60),
  fields: feishuFieldsSchema,
  encryptedSecret: z.string(),
  scannerOpenId: z.string().optional(),
  platformConfirmed: z.boolean(),
});
export type FeishuFlowDraft = Omit<
  z.infer<typeof flowEditorSchema>,
  'encryptedSecret' | 'scannerOpenId'
> & { hasSecret: boolean };
export type FeishuSetupState = {
  draft?: FeishuFlowDraft | null;
  connectionExpiresAt?: number | null;
  operationId: string | null;
  phase:
    | 'idle'
    | 'authorizing'
    | 'pending'
    | 'binding'
    | 'confirming'
    | 'bound'
    | 'checking'
    | 'complete'
    | 'cancelled'
    | 'expired'
    | 'error';
  message: string;
  appId: string | null;
  hasPending: boolean;
  qr: { url: string; expiresAt: number } | null;
  bindingCommand: { text: string; expiresAt: number } | null;
  candidate: FeishuBinding | null;
  connected: boolean;
  check: FeishuCheckResult;
  tutorial: number[];
};
export const setupActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('begin'),
    mode: z.enum(['create', 'existing']),
    intent: z.enum(['replace', 'credentials', 'binding', 'resume']),
  }),
  z.strictObject({
    kind: z.literal('edit'),
    revision: z.string().uuid(),
    fields: feishuFieldsSchema,
    secret: z.string().max(256),
    name: z.string().max(60),
  }),
  z.strictObject({ kind: z.literal('step'), step: z.number().int().min(1).max(4) }),
  z.strictObject({ kind: z.enum(['connect', 'suspend', 'flow-bind', 'flow-check', 'flow-skip']) }),
  z.strictObject({
    kind: z.literal('register'),
    mode: z.enum(['create', 'existing']),
    name: z.string().trim().min(1).max(60),
    appId: z
      .string()
      .regex(/^cli_[a-zA-Z0-9]+$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.enum(['load', 'cancel', 'bind', 'confirm', 'check', 'skip', 'use-existing']),
  }),
  z.strictObject({
    kind: z.literal('tutorial'),
    steps: z.array(z.number().int().min(0).max(5)).max(6),
  }),
]);
export type FeishuSetupAction = z.infer<typeof setupActionSchema>;
export const officialEntrySchema = z.enum([
  'console',
  'credentials',
  'bot',
  'permissions',
  'events',
  'publish',
  'registration',
  'authorization',
]);
export type OfficialEntry = z.infer<typeof officialEntrySchema>;
export function officialUrl(entry: OfficialEntry, appId?: string): string {
  if (entry === 'registration')
    return 'https://github.com/larksuite/node-sdk/blob/main/README.zh.md#一键创建应用';
  const root =
    appId && /^cli_[a-zA-Z0-9]+$/.test(appId)
      ? `https://open.feishu.cn/app/${appId}`
      : 'https://open.feishu.cn/app';
  const suffix = {
    console: '',
    credentials: '/baseinfo',
    bot: '/bot',
    permissions: '/auth',
    events: '/event',
    publish: '/version',
    authorization: '',
  };
  return root + (appId ? suffix[entry] : '');
}
export function assertAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname)
  )
    throw new Error('不支持的飞书授权地址');
  return url.href;
}
