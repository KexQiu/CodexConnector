import { randomBytes } from 'node:crypto';
import {
  EventDispatcher,
  WSClient,
  registerApp,
  defaultHttpInstance,
} from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { acquireFeishuSetupLock } from './app-lock.js';
import { FeishuApi, FeishuApiError } from './api.js';
import { credentialsSchema, silentLogger } from './credentials.js';
import {
  appIdentitySchema,
  assertAuthorizationUrl,
  bindingSchema,
  BIND_PREFIX,
  FEISHU_SETUP_MANIFEST,
  unchecked,
  type FeishuBinding,
  type FeishuCheckResult,
} from './setup-contracts.js';

export const setupBackendInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('register'),
    operationId: z.string().uuid(),
    mode: z.enum(['create', 'existing']),
    name: z.string().min(1).max(60),
    appId: z
      .string()
      .regex(/^cli_[a-zA-Z0-9]+$/)
      .optional(),
  }),
  z.object({
    kind: z.literal('bind'),
    operationId: z.string().uuid(),
    credentials: appIdentitySchema,
    scannerOpenId: z.string().optional(),
    reuseSetup: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('check'),
    operationId: z.string().uuid(),
    credentials: credentialsSchema,
    reuseConnection: z.boolean().default(false),
  }),
]);
export type SetupProgressValue =
  | { kind: 'qr'; url: string; expiresAt: number }
  | { kind: 'status'; message: string }
  | { kind: 'binding'; text: string; expiresAt: number }
  | { kind: 'connected'; connected: boolean }
  | { kind: 'session-closed' };
export type SetupProgress = SetupProgressValue & { operationId: string };
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new Error(signal.reason === 'deadline' ? 'setup:expired_token' : 'setup:cancelled'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}
export function acceptBinding(
  raw: unknown,
  appId: string,
  command: string,
  expiresAt: number,
  scannerOpenId?: string,
): FeishuBinding | null {
  if (Date.now() >= expiresAt) return null;
  const event = z
    .object({
      app_id: z.literal(appId),
      tenant_key: z.string(),
      sender: z.object({
        sender_type: z.literal('user'),
        sender_id: z.object({ open_id: z.string() }),
      }),
      message: z.object({
        chat_type: z.literal('p2p'),
        chat_id: z.string(),
        message_type: z.literal('text'),
        content: z.string().max(4096),
      }),
    })
    .safeParse(raw);
  if (!event.success) return null;
  const e = event.data;
  if (scannerOpenId && e.sender.sender_id.open_id !== scannerOpenId) return null;
  try {
    if (z.object({ text: z.string() }).parse(JSON.parse(e.message.content)).text.trim() !== command)
      return null;
    return bindingSchema.parse({
      tenantKey: e.tenant_key,
      allowedOpenId: e.sender.sender_id.open_id,
      testChatId: e.message.chat_id,
    });
  } catch {
    return null;
  }
}

/** No task store, Codex transport, outbound messages or cards are constructed here. */
export class FeishuSetupBackend {
  private session:
    | {
        id: string;
        credentials: z.infer<typeof appIdentitySchema>;
        expiresAt: number;
        connected: boolean;
        close: () => void;
        timer: ReturnType<typeof setTimeout>;
        binding?: {
          command: string;
          expiresAt: number;
          scannerOpenId?: string;
          accept: (value: FeishuBinding) => void;
        };
      }
    | undefined;
  openSession(raw: unknown) {
    const input = z
      .object({ operationId: z.string().uuid(), credentials: appIdentitySchema })
      .parse(raw);
    if (
      this.session &&
      JSON.stringify(this.session.credentials) === JSON.stringify(input.credentials)
    )
      return {
        expiresAt: this.session.expiresAt,
        connected: this.session.connected,
        operationId: this.session.id,
      };
    if (this.current) throw new Error('请先结束当前配置操作');
    this.closeSession();
    const expiresAt = Date.now() + 30 * 60_000;
    const session: NonNullable<FeishuSetupBackend['session']> = (this.session = {
      id: input.operationId,
      credentials: input.credentials,
      expiresAt,
      connected: false,
      close: () => {},
      timer: setTimeout(() => this.closeSession(), 30 * 60_000),
    });
    const dispatcher = new EventDispatcher({ logger: silentLogger }).register({
      'im.message.receive_v1': (raw: unknown) => {
        const binding = this.session?.binding;
        if (this.session !== session || !binding) return;
        const accepted = acceptBinding(
          raw,
          input.credentials.appId,
          binding.command,
          binding.expiresAt,
          binding.scannerOpenId,
        );
        if (accepted) {
          delete this.session.binding;
          binding.accept(accepted);
        }
      },
    });
    try {
      session.close = this.socket(input.credentials, dispatcher, (event) => {
        if (this.session !== session) return;
        if (event.kind === 'connected') session.connected = event.connected;
        this.progress({ ...event, operationId: session.id });
      });
    } catch (error) {
      this.closeSession();
      throw error;
    }
    return { expiresAt, connected: session.connected, operationId: session.id };
  }
  closeSession() {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    clearTimeout(session.timer);
    session.close();
    this.progress({ kind: 'session-closed', operationId: session.id });
    if (session.binding) this.current?.controller.abort();
  }
  private current: { id: string; controller: AbortController; done: Promise<unknown> } | undefined;
  constructor(
    private readonly progress: (value: SetupProgress) => void,
    private readonly connected: () => boolean = () => false,
    private readonly options: {
      fetcher?: typeof fetch;
      socket?: (
        credentials: z.infer<typeof appIdentitySchema>,
        dispatcher: EventDispatcher,
        emit: (value: SetupProgressValue) => void,
      ) => () => void;
    } = {},
  ) {}
  run(raw: unknown): Promise<unknown> {
    const input = setupBackendInput.parse(raw);
    if (this.current) throw new Error('配置流程仍在进行，请先取消');
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort('deadline'),
      input.kind === 'check' ? 30_000 : input.kind === 'bind' ? 300_000 : 660_000,
    );
    const emit = (event: SetupProgressValue) => {
      if (!controller.signal.aborted) this.progress({ ...event, operationId: input.operationId });
    };
    const done = this.perform(input, controller, emit).finally(() => {
      clearTimeout(deadline);
      if (this.current?.id === input.operationId) this.current = undefined;
    });
    this.current = { id: input.operationId, controller, done };
    return done;
  }
  async cancel(closeSession = true) {
    const current = this.current;
    current?.controller.abort();
    await current?.done.catch(() => {});
    if (closeSession) this.closeSession();
  }
  private async perform(
    input: z.infer<typeof setupBackendInput>,
    controller: AbortController,
    emit: (value: SetupProgressValue) => void,
  ): Promise<unknown> {
    const signal = controller.signal;
    if (input.kind === 'register') {
      this.closeSession();
      if (input.mode === 'existing' && !input.appId) throw new Error('请选择需要补配的 App ID');
      const release = input.appId ? acquireFeishuSetupLock(input.appId) : undefined;
      let regionalMismatch = false;
      // registerApp's AbortSignal stops polling, but the SDK begin request needs its
      // own cancellation and timeout to let the backend exit after parent death.
      const interceptor = defaultHttpInstance.interceptors.request.use((request) => {
        if (request.url?.endsWith('/oauth/v1/app/registration'))
          request.signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        return request;
      });
      try {
        const result = await abortable(
          registerApp({
            ...(input.mode === 'create' ? { createOnly: true } : { appId: input.appId! }),
            appPreset: { name: input.name, desc: '个人 Codex 飞书连接' },
            addons: {
              preset: false,
              scopes: FEISHU_SETUP_MANIFEST.scopes,
              events: { items: { tenant: FEISHU_SETUP_MANIFEST.events } },
              callbacks: { items: FEISHU_SETUP_MANIFEST.callbacks },
            },
            source: 'codexconnector',
            signal,
            onQRCodeReady: ({ url, expireIn }) => {
              if (signal.aborted) return;
              try {
                emit({
                  kind: 'qr',
                  url: assertAuthorizationUrl(url),
                  expiresAt: Date.now() + expireIn * 1000,
                });
              } catch {
                controller.abort();
              }
            },
            onStatusChange: ({ status }) => {
              if (status === 'domain_switched') {
                regionalMismatch = true;
                controller.abort();
                return;
              }
              emit({
                kind: 'status',
                message:
                  status === 'slow_down'
                    ? '平台限流，已降低轮询频率，请稍候'
                    : '等待飞书授权；若平台要求审批，请完成审批后继续',
              });
            },
          }),
          signal,
        );
        if (input.mode === 'existing' && result.client_id !== input.appId)
          throw new Error('setup:identity');
        if (result.user_info?.tenant_brand === 'lark') throw new Error('setup:region');
        return {
          ...appIdentitySchema.parse({ appId: result.client_id, appSecret: result.client_secret }),
          ...(result.user_info?.open_id ? { scannerOpenId: result.user_info.open_id } : {}),
        };
      } catch (error) {
        if (regionalMismatch) throw new Error('setup:region');
        if (signal.aborted)
          throw new Error(signal.reason === 'deadline' ? 'setup:expired_token' : 'setup:cancelled');
        const code = z.object({ code: z.string() }).safeParse(error);
        if (code.success && ['access_denied', 'expired_token'].includes(code.data.code))
          throw new Error(`setup:${code.data.code}`);
        if (error instanceof Error && /^setup:/.test(error.message)) throw error;
        throw new Error('setup:network'); // Never surface SDK/Axios bodies, request config or secrets.
      } finally {
        defaultHttpInstance.interceptors.request.eject(interceptor);
        release?.();
      }
    }
    if (input.kind === 'bind') {
      const expiresAt = Date.now() + 300_000;
      const command = `${BIND_PREFIX} ${randomBytes(24).toString('base64url')}`;
      let accept!: (binding: FeishuBinding) => void;
      let consumed = false;
      const result = new Promise<FeishuBinding>((resolve) => {
        accept = resolve;
      });
      const dispatcher = new EventDispatcher({ logger: silentLogger }).register({
        'im.message.receive_v1': (raw: unknown) => {
          if (consumed || signal.aborted) return;
          const binding = acceptBinding(
            raw,
            input.credentials.appId,
            command,
            expiresAt,
            input.scannerOpenId,
          );
          if (binding) {
            consumed = true;
            accept(binding);
          }
        },
      });
      emit({ kind: 'binding', text: command, expiresAt });
      const session = input.reuseSetup ? this.session : undefined;
      if (
        input.reuseSetup &&
        (!session || JSON.stringify(session.credentials) !== JSON.stringify(input.credentials))
      )
        throw new Error('配置连接已失效，请重新连接');
      if (session)
        session.binding = {
          command,
          expiresAt,
          accept,
          ...(input.scannerOpenId ? { scannerOpenId: input.scannerOpenId } : {}),
        };
      const close = session
        ? () => {
            delete session.binding;
          }
        : this.socket(input.credentials, dispatcher, emit);
      try {
        return await abortable(result, signal);
      } finally {
        close();
      }
    }
    const result = unchecked('checking');
    const api = new FeishuApi(input.credentials, this.options.fetcher ?? fetch, signal);
    const fail = (key: 'credentials' | 'history' | 'websocket', error: unknown) => {
      result[key] = {
        status: 'failed',
        message:
          error instanceof FeishuApiError
            ? `接口未通过（${error.apiCode ?? error.httpStatus}）。请核对凭据、权限和发布状态。`
            : signal.aborted
              ? '检查已取消或超过 30 秒'
              : '长连接不可用，请检查网络、其他连接及后台长连接设置',
      };
    };
    try {
      await api.prepare();
      result.credentials = { status: 'passed', message: '访问凭证获取成功' };
    } catch (error) {
      fail('credentials', error);
    }
    if (result.credentials.status === 'passed' && !signal.aborted) {
      try {
        await api.checkHistory(input.credentials.testChatId);
        result.history = { status: 'passed', message: '单聊历史读取接口可用' };
      } catch (error) {
        fail('history', error);
      }
      if (!signal.aborted) {
        try {
          let reusedSetup = false;
          if (input.reuseConnection) {
            if (!this.connected()) throw new Error('连接不在线');
          } else if (
            this.session &&
            JSON.stringify(this.session.credentials) ===
              JSON.stringify({
                appId: input.credentials.appId,
                appSecret: input.credentials.appSecret,
              })
          ) {
            reusedSetup = true;
            const session = this.session;
            await abortable(
              new Promise<void>((resolve, reject) => {
                const poll = setInterval(() => {
                  if (this.session !== session || signal.aborted) {
                    clearInterval(poll);
                    reject(new Error('配置连接已关闭'));
                  } else if (session.connected) {
                    clearInterval(poll);
                    resolve();
                  }
                }, 50);
              }),
              signal,
            );
          } else {
            let ready!: () => void;
            const wait = new Promise<void>((resolve) => {
              ready = resolve;
            });
            const close = this.socket(
              input.credentials,
              new EventDispatcher({ logger: silentLogger }),
              (event) => {
                if ('connected' in event && event.connected) ready();
              },
            );
            try {
              await abortable(wait, signal);
            } finally {
              close();
            }
          }
          result.websocket = {
            status: 'passed',
            message: input.reuseConnection
              ? '已复用当前在线长连接'
              : reusedSetup
                ? '已复用配置长连接，保存或离开配置时关闭'
                : '临时长连接握手成功，已关闭',
          };
        } catch (error) {
          fail('websocket', error);
        }
      }
    }
    for (const key of ['credentials', 'history', 'websocket'] as const)
      if (result[key].status === 'pending')
        result[key] = { status: 'skipped', message: '前置检查未通过或检查已取消' };
    result.status = (['credentials', 'history', 'websocket'] as const).every(
      (key) => result[key].status === 'passed',
    )
      ? 'passed'
      : 'failed';
    result.checkedAt = Date.now();
    return result satisfies FeishuCheckResult;
  }
  private socket(
    credentials: z.infer<typeof appIdentitySchema>,
    dispatcher: EventDispatcher,
    emit: (value: SetupProgressValue) => void,
  ) {
    if (this.options.socket) return this.options.socket(credentials, dispatcher, emit);
    const release = acquireFeishuSetupLock(credentials.appId);
    let closed = false;
    const ws = new WSClient({
      ...credentials,
      logger: silentLogger,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      onReady: () => {
        if (!closed) emit({ kind: 'connected', connected: true });
      },
      onReconnected: () => {
        if (!closed) emit({ kind: 'connected', connected: true });
      },
      onReconnecting: () => emit({ kind: 'connected', connected: false }),
      onError: () => emit({ kind: 'connected', connected: false }),
    });
    ws.start({ eventDispatcher: dispatcher }).catch(() => {});
    return () => {
      closed = true;
      ws.close({ force: true });
      release();
    };
  }
}
