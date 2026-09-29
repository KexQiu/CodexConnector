import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defaultRemoteProjectCreation } from '../config/remote-projects.js';
import { privateDirectory, readPrivate, writeJson } from '../service/files.js';
import { credentialsSchema, type FeishuCredentials } from '../feishu/credentials.js';
import { appIdentitySchema } from '../feishu/setup-contracts.js';
import baseline from '../runtime-baseline.json' with { type: 'json' };
import { desktopSettingsSchema, type DesktopSettings } from './contracts.js';
import { legacySettingsSchema, profileId, type LegacySettings } from './legacy.js';
export { profileId } from './legacy.js';

export type SecretCipher = { encrypt(value: string): string; decrypt(value: string): string };
const recordSchema = z.strictObject({
  version: z.literal(1),
  revision: z.string().uuid(),
  profileId: z.string().regex(/^[a-f0-9]{24}$/),
  settings: desktopSettingsSchema,
  encryptedSecret: z.string(),
  legacy: legacySettingsSchema.optional(),
});
export type DesktopRecord = z.infer<typeof recordSchema>;
export function defaultSettings(): DesktopSettings {
  return {
    codexBinary: baseline.codexBinary,
    feishu: { appId: '', tenantKey: '', allowedOpenId: '', testChatId: '' },
    projects: [],
    projectless: { enabled: true },
    maxConcurrentTasks: 1,
    remoteProjectCreation: defaultRemoteProjectCreation(),
    hiddenProjectRoots: [],
  };
}
export class DesktopVault {
  constructor(
    readonly root: string,
    private readonly cipher: SecretCipher,
  ) {
    privateDirectory(root);
    this.recoverFeishuCommit();
  }
  private recoverFeishuCommit() {
    const path = join(this.root, 'feishu-commit.json');
    if (!existsSync(path)) return;
    const commit = z
      .object({ version: z.literal(1), active: recordSchema, draft: recordSchema.nullable() })
      .parse(JSON.parse(readPrivate(path)));
    for (const record of [commit.active, commit.draft])
      if (record && record.profileId !== profileId(record.settings))
        throw new Error('配置提交身份校验失败');
    privateDirectory(this.dataDir(commit.active));
    writeJson(join(this.root, 'active.json'), commit.active);
    const draftPath = join(this.root, 'draft.json');
    if (commit.draft) writeJson(draftPath, commit.draft);
    else if (existsSync(draftPath)) unlinkSync(draftPath);
    unlinkSync(path);
  }
  applyFeishu(
    fields: DesktopSettings['feishu'],
    encryptedSecret: string,
    defaults = defaultSettings(),
  ) {
    this.recoverFeishuCommit();
    const active = this.read('active');
    const draft = this.read('draft');
    const make = (settings: DesktopSettings): DesktopRecord => {
      const next = { ...settings, feishu: fields };
      const identity = profileId(next);
      return {
        version: 1,
        revision: randomUUID(),
        profileId: identity,
        settings: next,
        encryptedSecret,
        ...(active?.legacy && active.profileId === identity ? { legacy: active.legacy } : {}),
      };
    };
    const next = make(active?.settings ?? defaults);
    const rebased = draft ? make(draft.settings) : null;
    // Write-ahead record makes the active/draft pair recoverable after interruption.
    writeJson(join(this.root, 'feishu-commit.json'), {
      version: 1,
      active: next,
      draft:
        rebased && JSON.stringify(rebased.settings) !== JSON.stringify(next.settings)
          ? rebased
          : null,
    });
    this.recoverFeishuCommit();
  }
  read(kind: 'active' | 'draft'): DesktopRecord | null {
    this.recoverFeishuCommit();
    const path = join(this.root, `${kind}.json`);
    if (!existsSync(path)) return null;
    const record = recordSchema.parse(JSON.parse(readPrivate(path)));
    if (record.profileId !== profileId(record.settings)) throw new Error('配置身份校验失败');
    return record;
  }
  dataDir(record: DesktopRecord) {
    return join(this.root, 'profiles', record.profileId);
  }
  credentials(settings: DesktopSettings, replacement = ''): FeishuCredentials {
    return credentialsSchema.parse({
      ...settings.feishu,
      appSecret: replacement || this.decryptFor(settings),
    });
  }
  appCredentials(settings: DesktopSettings, replacement = '') {
    return appIdentitySchema.parse({
      appId: settings.feishu.appId,
      appSecret: replacement || this.decryptFor(settings),
    });
  }
  private decryptFor(settings: DesktopSettings) {
    const encrypted = this.encryptedFor(settings);
    return encrypted ? this.cipher.decrypt(encrypted) : '';
  }
  private encryptedFor(settings: DesktopSettings) {
    for (const kind of ['draft', 'active'] as const) {
      const record = this.read(kind);
      if (record?.settings.feishu.appId === settings.feishu.appId && record.encryptedSecret)
        return record.encryptedSecret;
    }
    return '';
  }
  prepare(settings: DesktopSettings, replacement = '', imported?: LegacySettings): DesktopRecord {
    const parsed = desktopSettingsSchema.parse(settings);
    // Ordinary edits can reuse ciphertext without prompting Keychain or decrypting.
    const encryptedSecret = replacement
      ? this.cipher.encrypt(replacement)
      : this.encryptedFor(parsed);
    const identity = profileId(parsed);
    const active = this.read('active');
    const legacy = imported ?? (active?.profileId === identity ? active.legacy : undefined);
    if (legacy && legacy.profileId !== identity) throw new Error('导入扩展的会话身份不匹配');
    return {
      version: 1,
      revision: randomUUID(),
      profileId: identity,
      settings: parsed,
      encryptedSecret,
      ...(legacy ? { legacy } : {}),
    };
  }
  write(kind: 'active' | 'draft', record: DesktopRecord) {
    this.recoverFeishuCommit();
    const parsed = recordSchema.parse(record);
    if (kind === 'active') privateDirectory(this.dataDir(parsed));
    // Config and encrypted secret share one atomic snapshot; no half-written reference.
    writeJson(join(this.root, `${kind}.json`), parsed);
    if (kind === 'active') {
      const draft = join(this.root, 'draft.json');
      if (existsSync(draft)) unlinkSync(draft);
    }
  }
}
