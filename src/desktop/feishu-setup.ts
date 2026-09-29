import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivate, writeJson } from '../service/files.js';
import {
  appIdentitySchema,
  bindingSchema,
  feishuCheckSchema,
  unchecked,
  type FeishuSetupAction,
  type FeishuSetupState,
  type FeishuBinding,
} from '../feishu/setup-contracts.js';
import type { SetupProgress } from '../feishu/setup-backend.js';
import type { DesktopSettings, DesktopStatus } from './contracts.js';
import { type DesktopVault, defaultSettings, type SecretCipher } from './vault.js';

const pendingSchema = z.object({
  appId: appIdentitySchema.shape.appId,
  encryptedSecret: z.string().min(1),
  scannerOpenId: z.string().optional(),
  binding: bindingSchema.optional(),
});
const diskSchema = z.object({
  version: z.literal(1),
  pending: pendingSchema.nullable(),
  tutorial: z.array(z.number().int().min(0).max(5)),
  check: z.object({ fingerprint: z.string(), result: feishuCheckSchema }).nullable(),
});
type Disk = z.infer<typeof diskSchema>;
type Transport = {
  invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
  status: DesktopStatus;
};
const errors: Record<string, string> = {
  'setup:access_denied': '授权已被拒绝，可以重新扫码或改用已有机器人。',
  'setup:expired_token': '二维码已过期，请重新生成。',
  'setup:cancelled': '操作已取消或已到有效期；已保存的应用信息仍可继续使用。',
  'setup:identity': '返回的 App ID 与指定应用不一致，未合入凭据。',
  'setup:region': '首版仅支持国内飞书，请使用飞书账号。',
  'setup:network': '无法完成授权，请检查网络后重试。若已在平台创建应用，请使用已有机器人入口。',
};
export class DesktopFeishuSetup {
  private disk: Disk;
  private state: FeishuSetupState;
  private job: Promise<void> | undefined;
  private generation = 0;
  private fingerprintCache: { source: string; value: string } | undefined;
  private readonly path: string;
  constructor(
    private readonly vault: DesktopVault,
    private readonly cipher: SecretCipher,
    private readonly backend: Transport,
    private readonly publish: (state: FeishuSetupState) => void,
  ) {
    this.path = join(vault.root, 'feishu-setup.json');
    this.disk = existsSync(this.path)
      ? diskSchema.parse(JSON.parse(readPrivate(this.path)))
      : { version: 1, pending: null, tutorial: [], check: null };
    this.state = {
      operationId: null,
      phase: this.disk.pending?.binding ? 'bound' : this.disk.pending ? 'pending' : 'idle',
      message: this.disk.pending
        ? '已恢复加密保存的应用信息，可继续配置。'
        : '选择一种方式连接飞书。',
      appId: this.disk.pending?.appId ?? null,
      hasPending: !!this.disk.pending,
      qr: null,
      bindingCommand: null,
      candidate: null,
      connected: false,
      check: unchecked(),
      tutorial: this.disk.tutorial,
    };
  }
  private settings() {
    return (this.vault.read('draft') ?? this.vault.read('active'))?.settings ?? defaultSettings();
  }
  private fingerprint() {
    const settings = this.settings();
    const record = this.vault.read('draft') ?? this.vault.read('active');
    const source = JSON.stringify([settings.feishu, record?.encryptedSecret]);
    if (this.fingerprintCache?.source === source) return this.fingerprintCache.value;
    try {
      const value = createHash('sha256')
        .update(JSON.stringify(this.vault.credentials(settings)))
        .digest('hex');
      this.fingerprintCache = { source, value };
      return value;
    } catch {
      return '';
    }
  }
  snapshot(): FeishuSetupState {
    const check =
      this.state.phase === 'checking'
        ? this.state.check
        : this.disk.check
          ? this.disk.check.fingerprint === this.fingerprint()
            ? this.disk.check.result
            : unchecked('changed')
          : unchecked();
    return {
      ...this.state,
      ...(this.state.phase === 'complete' && check.status === 'changed'
        ? { message: '配置已变更，待验证' }
        : {}),
      hasPending: !!this.disk.pending,
      check,
      tutorial: [...this.disk.tutorial],
    };
  }
  refresh() {
    this.publish(this.snapshot());
  }
  private save() {
    writeJson(this.path, this.disk);
  }
  private update(value: Partial<FeishuSetupState>) {
    this.state = { ...this.state, ...value };
    this.refresh();
  }
  progress(value: SetupProgress) {
    if (value.operationId !== this.state.operationId || !this.job) return;
    if (value.kind === 'qr') this.update({ qr: { url: value.url, expiresAt: value.expiresAt } });
    else if (value.kind === 'binding')
      this.update({ bindingCommand: { text: value.text, expiresAt: value.expiresAt } });
    else if (value.kind === 'connected') this.update({ connected: value.connected });
    else this.update({ message: value.message });
  }
  private requireStopped() {
    if (this.backend.status.phase !== 'stopped')
      throw new Error('请先在总览停止正式服务，再进行扫码配置或绑定。');
  }
  private launch(
    phase: 'authorizing' | 'binding' | 'checking',
    input: Record<string, unknown>,
    finish: (value: unknown) => void,
  ) {
    if (this.job) throw new Error('已有配置操作进行中，请先取消。');
    const operationId = randomUUID();
    const generation = ++this.generation;
    this.update({
      operationId,
      phase,
      qr: null,
      candidate: null,
      bindingCommand: null,
      connected: false,
      message:
        phase === 'authorizing'
          ? '正在向飞书申请授权二维码…'
          : phase === 'binding'
            ? '正在连接配置通道。请按教程保存长连接设置，再发送绑定指令。'
            : '正在进行基础连接检查，最长 30 秒。',
      ...(phase === 'checking' ? { check: unchecked('checking') } : {}),
    });
    this.job = this.backend
      .invoke('setupRun', { ...input, operationId })
      .then((value) => {
        if (generation !== this.generation) return;
        finish(value);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        const code = error instanceof Error ? error.message : '';
        this.update({
          phase: code === 'setup:expired_token' ? 'expired' : 'error',
          message: errors[code] ?? '配置未完成。请检查网络、应用权限及本机是否有其他连接，再重试。',
        });
      })
      .finally(() => {
        if (generation === this.generation) {
          this.job = undefined;
          this.update({ connected: false, bindingCommand: null, qr: null, operationId: null });
        }
      });
    return this.snapshot();
  }
  async cancel() {
    ++this.generation;
    const job = this.job;
    await this.backend.invoke('setupCancel');
    await job;
    this.job = undefined;
    this.update({
      operationId: null,
      phase: 'cancelled',
      message: '配置操作已取消，已获取的应用信息仍保留。',
      qr: null,
      bindingCommand: null,
      candidate: null,
      connected: false,
    });
  }
  private setBinding(binding: FeishuBinding) {
    if (!this.disk.pending) throw new Error('缺少待配置应用');
    this.disk.pending.binding = binding;
    this.save();
    this.update({
      phase: 'bound',
      candidate: null,
      message: '单聊绑定已保存，请将它合入当前草稿。',
    });
  }
  async action(action: FeishuSetupAction): Promise<FeishuSetupState> {
    if (action.kind === 'load') return this.snapshot();
    if (action.kind === 'tutorial') {
      this.disk.tutorial = [...new Set(action.steps)];
      this.save();
      this.refresh();
      return this.snapshot();
    }
    if (action.kind === 'cancel') {
      await this.cancel();
      return this.snapshot();
    }
    if (action.kind === 'skip') {
      await this.cancel();
      this.disk.check = { fingerprint: this.fingerprint(), result: unchecked() };
      this.save();
      this.update({
        phase: 'complete',
        message: '配置已保存，未验证。正式启动仍会检查必需权限与运行环境。',
      });
      return this.snapshot();
    }
    if (this.job) throw new Error('已有配置操作进行中，请先取消。');
    if (action.kind === 'register') {
      this.requireStopped();
      if (action.mode === 'create' && this.disk.pending)
        throw new Error('已有待配置应用，请继续配置或改用已有机器人入口，不重复创建。');
      if (action.mode === 'existing' && !action.appId) throw new Error('请先填写要补配的 App ID');
      this.cipher.encrypt('keychain-preflight');
      return this.launch('authorizing', { ...action }, (raw) => {
        const result = appIdentitySchema
          .extend({ scannerOpenId: z.string().optional() })
          .parse(raw);
        if (action.mode === 'existing' && result.appId !== action.appId)
          throw new Error('setup:identity');
        const existing = this.settings();
        const binding =
          existing.feishu.appId === result.appId ? bindingSchema.safeParse(existing.feishu) : null;
        this.disk.pending = {
          appId: result.appId,
          encryptedSecret: this.cipher.encrypt(result.appSecret),
          ...(result.scannerOpenId ? { scannerOpenId: result.scannerOpenId } : {}),
          ...(binding?.success ? { binding: binding.data } : {}),
        };
        this.save(); // Credentials are durable before any follow-up UI or connection.
        this.update({
          phase: binding?.success ? 'bound' : 'pending',
          appId: result.appId,
          message: '应用凭据已加密保存。请继续配置事件、发布应用并绑定单聊。',
        });
      });
    }
    if (action.kind === 'use-existing') {
      this.requireStopped();
      const settings = this.settings();
      const credentials = this.vault.appCredentials(settings);
      const binding = bindingSchema.safeParse(settings.feishu);
      this.disk.pending = {
        appId: credentials.appId,
        encryptedSecret: this.cipher.encrypt(credentials.appSecret),
        ...(binding.success ? { binding: binding.data } : {}),
      };
      this.save();
      this.update({
        appId: credentials.appId,
        phase: binding.success ? 'bound' : 'pending',
        message: binding.success ? '已保留原单聊绑定。' : '凭据已保存，请绑定单聊。',
      });
      return this.snapshot();
    }
    if (action.kind === 'bind') {
      this.requireStopped();
      if (!this.disk.pending) {
        const settings = this.settings();
        const credentials = this.vault.appCredentials(settings);
        this.disk.pending = {
          appId: credentials.appId,
          encryptedSecret: this.cipher.encrypt(credentials.appSecret),
        };
        this.save();
      }
      const pending = this.disk.pending;
      return this.launch(
        'binding',
        {
          kind: 'bind',
          credentials: {
            appId: pending.appId,
            appSecret: this.cipher.decrypt(pending.encryptedSecret),
          },
          ...(pending.scannerOpenId ? { scannerOpenId: pending.scannerOpenId } : {}),
        },
        (raw) => {
          const binding = bindingSchema.parse(raw);
          if (pending.scannerOpenId) this.setBinding(binding);
          else
            this.update({
              phase: 'confirming',
              candidate: binding,
              message: '请核对发送绑定指令的用户和单聊，确认后才会保存。',
            });
        },
      );
    }
    if (action.kind === 'confirm') {
      if (this.state.phase !== 'confirming' || !this.state.candidate)
        throw new Error('没有待确认的绑定');
      this.setBinding(this.state.candidate);
      return this.snapshot();
    }
    const settings = this.settings();
    const credentials = this.vault.credentials(settings);
    const fingerprint = this.fingerprint();
    const running = this.backend.status.phase !== 'stopped';
    const active = this.vault.read('active');
    if (
      running &&
      (!active ||
        JSON.stringify(this.vault.credentials(active.settings)) !== JSON.stringify(credentials))
    )
      throw new Error('当前服务使用不同配置，请先停止服务。');
    return this.launch(
      'checking',
      { kind: 'check', credentials, reuseConnection: running },
      (raw) => {
        const result = feishuCheckSchema.parse(raw);
        this.disk.check = { fingerprint, result };
        this.save();
        this.update({
          phase: 'complete',
          check: result,
          message:
            fingerprint !== this.fingerprint()
              ? '配置已变更，待验证'
              : result.status === 'passed'
                ? '基础连接检查通过'
                : '基础连接检查未通过，可按详情修复或跳过。',
        });
      },
    );
  }
  merge(expectedRevision: string | null) {
    this.requireStopped();
    if (this.job) throw new Error('请先结束当前配置操作');
    const pending = this.disk.pending;
    if (!pending?.binding) throw new Error('请先完成绑定或在高级配置填写身份信息。');
    const current = this.vault.read('draft') ?? this.vault.read('active');
    if ((current?.revision ?? null) !== expectedRevision)
      throw new Error('草稿已更新，请重新保存绑定。');
    const settings: DesktopSettings = {
      ...(current?.settings ?? defaultSettings()),
      feishu: { appId: pending.appId, ...pending.binding },
    };
    this.vault.write(
      'draft',
      this.vault.prepare(settings, this.cipher.decrypt(pending.encryptedSecret)),
    );
    this.disk.pending = null;
    this.save();
    this.update({
      phase: 'bound',
      message: '已合入草稿。可以检查连接，也可以跳过验证后应用配置。',
    });
  }
}
