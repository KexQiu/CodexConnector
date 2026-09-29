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
  flowEditorSchema,
  type FeishuSetupAction,
  type FeishuSetupState,
  type FeishuBinding,
} from '../feishu/setup-contracts.js';
import { credentialsSchema } from '../feishu/credentials.js';
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
  editor: flowEditorSchema.nullable().optional(),
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
  private sessionId: string | null = null;
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
    if (this.disk.editor) {
      const editor = this.disk.editor;
      try {
        return createHash('sha256')
          .update(
            JSON.stringify(
              credentialsSchema.parse({
                ...editor.fields,
                appSecret: editor.encryptedSecret
                  ? this.cipher.decrypt(editor.encryptedSecret)
                  : '',
              }),
            ),
          )
          .digest('hex');
      } catch {
        return '';
      }
    }
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
      draft: this.disk.editor
        ? (() => {
            const { encryptedSecret, ...editor } = this.disk.editor;
            delete editor.scannerOpenId;
            return { ...editor, hasSecret: !!encryptedSecret };
          })()
        : null,
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
    if (value.operationId === this.sessionId) {
      if (value.kind === 'connected') this.update({ connected: value.connected });
      if (value.kind === 'session-closed') {
        this.sessionId = null;
        this.update({ connected: false, connectionExpiresAt: null, bindingCommand: null });
      }
      return;
    }
    if (value.operationId !== this.state.operationId || !this.job) return;
    if (value.kind === 'qr') this.update({ qr: { url: value.url, expiresAt: value.expiresAt } });
    else if (value.kind === 'binding')
      this.update({ bindingCommand: { text: value.text, expiresAt: value.expiresAt } });
    else if (value.kind === 'connected') this.update({ connected: value.connected });
    else if (value.kind === 'status') this.update({ message: value.message });
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
      connected: this.sessionId ? this.state.connected : false,
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
          message:
            phase === 'binding' && code === 'setup:expired_token'
              ? '绑定指令已过期，请重新生成。配置连接仍可继续使用。'
              : (errors[code] ?? '配置未完成。请检查网络、应用权限及本机是否有其他连接，再重试。'),
        });
      })
      .finally(() => {
        if (generation === this.generation) {
          this.job = undefined;
          this.update({
            ...(this.sessionId ? {} : { connected: false }),
            bindingCommand: null,
            qr: null,
            operationId: null,
          });
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
    this.sessionId = null;
    this.update({
      connectionExpiresAt: null,
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
  private editor() {
    if (!this.disk.editor) throw new Error('请先开始飞书配置');
    return this.disk.editor;
  }
  private saveEditor() {
    this.editor().revision = randomUUID();
    this.save();
    this.refresh();
  }
  private pair() {
    const editor = this.editor();
    return appIdentitySchema.parse({
      appId: editor.fields.appId,
      appSecret: editor.encryptedSecret ? this.cipher.decrypt(editor.encryptedSecret) : '',
    });
  }
  private async connectEditor() {
    this.requireStopped();
    const operationId = randomUUID();
    this.sessionId = operationId;
    try {
      const result = await this.backend.invoke<{
        expiresAt: number;
        connected: boolean;
        operationId: string;
      }>('setupConnect', { operationId, credentials: this.pair() });
      this.sessionId = result.operationId;
      this.update({
        connected: result.connected,
        connectionExpiresAt: result.expiresAt,
        appId: this.editor().fields.appId,
      });
    } catch (error) {
      this.sessionId = null;
      throw error;
    }
  }
  finish(revision: string, defaults: DesktopSettings) {
    this.requireStopped();
    if (this.job || this.sessionId) throw new Error('请先结束配置连接');
    const editor = this.editor();
    if (editor.revision !== revision) throw new Error('配置已更新，请重试保存');
    this.pair();
    bindingSchema.parse(editor.fields);
    this.vault.applyFeishu(editor.fields, editor.encryptedSecret, defaults);
    this.disk.editor = null;
    this.disk.pending = null;
    this.save();
    this.update({ phase: 'complete', message: '飞书配置已保存，连接仍需手动启动。' });
  }
  async finishConnection() {
    await this.cancel();
  }
  private async flowAction(action: FeishuSetupAction): Promise<FeishuSetupState | undefined> {
    if (action.kind === 'begin') {
      await this.cancel();
      if (action.intent === 'resume' && this.disk.editor) return this.snapshot();
      const current = this.settings();
      const pending = action.intent === 'resume' ? this.disk.pending : null;
      const preserve = action.intent !== 'replace';
      const fields = pending
        ? {
            appId: pending.appId,
            tenantKey: '',
            allowedOpenId: '',
            testChatId: '',
            ...pending.binding,
          }
        : preserve
          ? current.feishu
          : defaultSettings().feishu;
      let encryptedSecret = pending?.encryptedSecret ?? '';
      if (!encryptedSecret && preserve) {
        const record = this.vault.read('draft') ?? this.vault.read('active');
        if (record?.settings.feishu.appId === fields.appId)
          encryptedSecret = record.encryptedSecret;
      }
      this.disk.editor = {
        revision: randomUUID(),
        mode: action.mode,
        step: action.intent === 'binding' ? 3 : pending ? (pending.binding ? 4 : 2) : 1,
        name: 'CodexConnector',
        fields,
        encryptedSecret,
        platformConfirmed: preserve && !!this.vault.read('active') && !pending,
        ...(pending?.scannerOpenId ? { scannerOpenId: pending.scannerOpenId } : {}),
      };
      this.save();
      this.update({
        phase: 'idle',
        appId: fields.appId || null,
        candidate: null,
        message: '填写内容会自动保存在本机。',
      });
      return this.snapshot();
    }
    if (action.kind === 'edit') {
      if (this.job || this.sessionId) throw new Error('请先返回上一步或结束当前连接再修改');
      const editor = this.editor();
      if (action.revision !== editor.revision) throw new Error('配置已更新，请重新打开本步骤');
      const changedApp = action.fields.appId !== editor.fields.appId;
      const hadIdentity = !!editor.fields.appId;
      editor.fields = { ...action.fields };
      editor.name = action.name;
      if (changedApp) {
        if (hadIdentity)
          editor.fields = {
            appId: action.fields.appId,
            tenantKey: '',
            allowedOpenId: '',
            testChatId: '',
          };
        editor.encryptedSecret = '';
        delete editor.scannerOpenId;
        editor.platformConfirmed = false;
      }
      if (action.secret) editor.encryptedSecret = this.cipher.encrypt(action.secret);
      this.saveEditor();
      return this.snapshot();
    }
    if (action.kind === 'suspend') {
      await this.cancel();
      return this.snapshot();
    }
    if (action.kind === 'connect') {
      await this.connectEditor();
      return this.snapshot();
    }
    if (action.kind === 'step') {
      const editor = this.editor();
      if (action.step > 1) this.pair();
      if (action.step === 4) bindingSchema.parse(editor.fields);
      if (action.step === 3 && editor.step === 2) editor.platformConfirmed = true;
      if (action.step < editor.step) await this.cancel();
      else if (action.step === 4 && this.job) {
        ++this.generation;
        await this.backend.invoke('setupPauseBinding');
        await this.job;
        this.job = undefined;
        this.update({ operationId: null, bindingCommand: null });
      }
      editor.step = action.step;
      this.saveEditor();
      this.update({ phase: 'idle', candidate: null });
      return this.snapshot();
    }
    if (action.kind === 'flow-bind') {
      this.requireStopped();
      ++this.generation;
      await this.backend.invoke('setupPauseBinding');
      await this.job;
      this.job = undefined;
      await this.connectEditor();
      const editor = this.editor();
      return this.launch(
        'binding',
        {
          kind: 'bind',
          credentials: this.pair(),
          reuseSetup: true,
          ...(editor.scannerOpenId ? { scannerOpenId: editor.scannerOpenId } : {}),
        },
        (raw) => {
          const binding = bindingSchema.parse(raw);
          if (editor.scannerOpenId) {
            editor.fields = { appId: editor.fields.appId, ...binding };
            this.saveEditor();
            this.update({ phase: 'bound', message: '已确认单聊，点击下一步继续。' });
          } else
            this.update({
              phase: 'confirming',
              candidate: binding,
              message: '请确认这是你的账号与单聊。',
            });
        },
      );
    }
    if (action.kind === 'confirm' && this.disk.editor) {
      if (!this.state.candidate) throw new Error('没有待确认的绑定');
      const editor = this.editor();
      editor.fields = { appId: editor.fields.appId, ...this.state.candidate };
      this.saveEditor();
      this.update({ phase: 'bound', candidate: null, message: '绑定已确认。' });
      return this.snapshot();
    }
    if (action.kind === 'flow-skip') {
      await this.cancel();
      this.disk.check = { fingerprint: this.fingerprint(), result: unchecked() };
      this.save();
      this.update({ phase: 'complete', message: '未进行检查，可直接保存配置。' });
      return this.snapshot();
    }
    if (action.kind === 'flow-check') {
      this.requireStopped();
      const editor = this.editor();
      const credentials = { ...this.pair(), ...bindingSchema.parse(editor.fields) };
      const fingerprint = this.fingerprint();
      return this.launch('checking', { kind: 'check', credentials }, (raw) => {
        const result = feishuCheckSchema.parse(raw);
        this.disk.check = { fingerprint, result };
        this.save();
        this.update({
          phase: 'complete',
          message:
            result.status === 'passed' ? '基础连接检查通过' : '检查未通过，请修复或跳过检查。',
        });
      });
    }
    return undefined;
  }
  async action(action: FeishuSetupAction): Promise<FeishuSetupState> {
    if (action.kind === 'load') return this.snapshot();
    const flow = await this.flowAction(action);
    if (flow) return flow;
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
      if (
        action.mode === 'create' &&
        (this.disk.editor?.encryptedSecret || (!this.disk.editor && this.disk.pending))
      )
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
        if (this.disk.editor) {
          const editor = this.disk.editor;
          editor.fields = {
            appId: result.appId,
            tenantKey: '',
            allowedOpenId: '',
            testChatId: '',
            ...(binding?.success ? binding.data : {}),
          };
          editor.encryptedSecret = this.disk.pending.encryptedSecret;
          if (result.scannerOpenId) editor.scannerOpenId = result.scannerOpenId;
          editor.step = 2;
          editor.revision = randomUUID();
        }
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
