import { join } from 'node:path';
import { z } from 'zod';
import { DesktopFeishuSetup } from './feishu-setup.js';
import { resolveCodexBinary } from '../codex/binary.js';
import {
  assertAuthorizationUrl,
  FEISHU_SETUP_MANIFEST,
  officialUrl,
} from '../feishu/setup-contracts.js';
import { DesktopVault, defaultSettings, profileId, type SecretCipher } from './vault.js';
import {
  uiRequestSchema,
  type DesktopSnapshot,
  type DesktopStatus,
  type UiRequest,
} from './contracts.js';
import type { SetupProgress } from '../feishu/setup-backend.js';
import type { FeishuSetupState } from '../feishu/setup-contracts.js';

export interface NativeBackend {
  status: DesktopStatus;
  readonly connected: boolean;
  invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
  close(): Promise<void>;
  onSetup: ((value: SetupProgress) => void) | undefined;
}

/** Desktop orchestration shared with the verified gateway; native effects stay in Rust. */
export class NativeController {
  readonly vault: DesktopVault;
  readonly setup: DesktopFeishuSetup;
  constructor(
    readonly root: string,
    cipher: SecretCipher,
    readonly backend: NativeBackend,
    publish: (state: FeishuSetupState) => void,
  ) {
    this.vault = new DesktopVault(root, cipher);
    this.setup = new DesktopFeishuSetup(
      this.vault,
      cipher,
      {
        get status() {
          return backend.status;
        },
        invoke<T = unknown>(method: string, args?: unknown) {
          return backend.invoke<T>(method, args);
        },
      },
      publish,
    );
    backend.onSetup = (value) => this.setup.progress(value);
  }
  private async stopped() {
    if ((await this.backend.invoke<DesktopStatus>('status')).phase !== 'stopped')
      throw new Error('请先停止服务，再应用配置');
  }
  snapshot(): DesktopSnapshot {
    const active = this.vault.read('active');
    const shown = this.vault.read('draft') ?? active;
    const defaults = defaultSettings();
    defaults.codexBinary = resolveCodexBinary();
    const settings = shown?.settings ?? defaults;
    const binary = resolveCodexBinary(settings.codexBinary);
    return {
      revision: shown?.revision ?? null,
      settings: { ...settings, codexBinary: binary },
      ...(binary !== settings.codexBinary
        ? {
            codexPathNotice:
              '检测到 Codex 安装布局更新，已使用同一应用中的新入口。下次应用配置时保存新路径。',
          }
        : {}),
      activeSettings: active?.settings ?? null,
      hasDraft: Boolean(this.vault.read('draft')),
      configured: Boolean(active),
      hasSecret: Boolean(shown?.encryptedSecret),
      hasDesktopNotifications: Boolean(active?.legacy?.notify),
      dataDir: active ? this.vault.dataDir(active) : this.root,
      status: this.backend.status,
    };
  }
  async handle(request: UiRequest): Promise<unknown> {
    switch (request.method) {
      case 'feishuSetup':
        return this.setup.action(request.action);
      case 'applyFeishuSetup': {
        await this.stopped();
        await this.setup.finishConnection();
        const defaults = defaultSettings();
        defaults.codexBinary = resolveCodexBinary();
        this.setup.finish(request.revision, defaults);
        return this.snapshot();
      }
      case 'mergeFeishuSetup':
        this.setup.merge(request.revision);
        return this.snapshot();
      case 'load':
        return this.snapshot();
      case 'saveDraft':
        this.vault.write('draft', this.vault.prepare(request.settings, request.secret));
        this.setup.refresh();
        return this.snapshot();
      case 'apply': {
        await this.stopped();
        if (this.setup.snapshot().operationId || this.setup.snapshot().connectionExpiresAt)
          throw new Error('请先结束飞书配置连接或检查，再应用配置');
        const credentials = this.vault.credentials(request.settings, request.secret);
        const active = this.vault.read('active');
        const record = this.vault.prepare(request.settings, credentials.appSecret);
        await this.backend.invoke('validate', {
          settings: request.settings,
          credentials,
          legacy: record.legacy,
          ...(active ? { dataDir: this.vault.dataDir(active) } : {}),
        });
        this.vault.write('active', record);
        return this.snapshot();
      }
      case 'checkProjectless':
        return this.backend.invoke('projectlessCheck', request.binary);
      case 'checkCodex':
        return this.backend.invoke('doctor', request.binary);
      case 'checkFeishu': {
        try {
          return await this.backend.invoke(
            'feishuCheck',
            this.vault.credentials(request.settings, request.secret),
          );
        } catch (error) {
          if (error instanceof z.ZodError) {
            const labels: Record<string, string> = {
              appId: 'App ID',
              appSecret: 'App Secret',
              tenantKey: 'Tenant Key',
              allowedOpenId: '用户 Open ID',
              testChatId: '单聊 Chat ID',
            };
            throw new Error(
              `请检查以下字段：${error.issues.map((issue) => labels[String(issue.path[0])] ?? issue.path.join('.')).join('、')}`,
            );
          }
          throw error;
        }
      }
      case 'start': {
        if (this.setup.snapshot().operationId || this.setup.snapshot().connectionExpiresAt)
          throw new Error('请先结束飞书配置连接或检查，再启动正式服务');
        const active = this.vault.read('active');
        if (!active) throw new Error('请先应用配置');
        if (this.vault.read('draft')) throw new Error('存在未应用草稿，请先应用配置后启动');
        return this.backend.invoke('start', {
          settings: active.settings,
          dataDir: this.vault.dataDir(active),
          credentials: this.vault.credentials(active.settings),
          legacy: active.legacy,
        });
      }
      case 'stop':
        return this.backend.invoke<DesktopStatus>('stop');
      case 'discoverProjects':
        return this.backend.invoke('discoverProjects', {
          knownRoots: request.knownRoots,
          dataDir: join(this.root, 'profiles', profileId({ feishu: request.feishu })),
          feishu: request.feishu,
        });
      case 'logs': {
        const active = this.vault.read('active');
        return active ? this.backend.invoke('logs', this.vault.dataDir(active)) : [];
      }
      default:
        throw new Error('不支持的后台操作');
    }
  }
  effect(raw: unknown): { kind: 'open' | 'copy'; value: string } {
    const request = uiRequestSchema.parse(raw);
    if (request.method === 'openFeishu') {
      const state = this.setup.snapshot();
      if (request.entry === 'authorization') {
        if (!state.qr || state.qr.expiresAt <= Date.now())
          throw new Error('二维码已过期，请重新生成');
        return { kind: 'open', value: assertAuthorizationUrl(state.qr.url) };
      }
      return {
        kind: 'open',
        value: officialUrl(
          request.entry,
          state.draft?.fields.appId || state.appId || this.snapshot().settings.feishu.appId,
        ),
      };
    }
    if (request.method === 'copyFeishu') {
      const binding = this.setup.snapshot().bindingCommand;
      if (request.item === 'binding' && (!binding || binding.expiresAt <= Date.now()))
        throw new Error('绑定指令已过期，请重新绑定');
      return {
        kind: 'copy',
        value:
          request.item === 'permissions'
            ? JSON.stringify({ scopes: FEISHU_SETUP_MANIFEST.scopes }, null, 2)
            : request.item === 'events'
              ? [...FEISHU_SETUP_MANIFEST.events, ...FEISHU_SETUP_MANIFEST.callbacks].join('\n')
              : binding!.text,
      };
    }
    throw new Error('不支持的原生操作');
  }
  async close() {
    await this.setup.cancel();
    await this.backend.close();
  }
}
