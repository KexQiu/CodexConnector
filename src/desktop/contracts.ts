import {
  setupActionSchema,
  officialEntrySchema,
  type FeishuSetupAction,
  type FeishuSetupState,
  type OfficialEntry,
} from '../feishu/setup-contracts.js';
import { z } from 'zod';
import {
  remoteProjectCreationSchema,
  defaultRemoteProjectCreation,
} from '../config/remote-projects.js';
import {
  hasOneProjectPolicy,
  maxConcurrentTasksSchema,
  projectAccessFields,
  type RemotePermissions,
} from '../config/project-policy.js';

const text = z.string().max(4096);
export const desktopSettingsSchema = z.strictObject({
  codexBinary: text,
  feishu: z.strictObject({ appId: text, tenantKey: text, allowedOpenId: text, testChatId: text }),
  projectless: z.strictObject({ enabled: z.boolean() }).optional(),
  maxConcurrentTasks: maxConcurrentTasksSchema,
  remoteProjectCreation: remoteProjectCreationSchema.default(defaultRemoteProjectCreation),
  hiddenProjectRoots: z.array(text).max(500).default([]),
  projects: z
    .array(
      z
        .strictObject({ key: text, name: text, root: text, ...projectAccessFields })
        .refine(hasOneProjectPolicy, '必须且只能指定一种项目权限配置'),
    )
    .max(100),
});
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;
export type DesktopStatus = {
  phase: 'stopped' | 'starting' | 'ready' | 'degraded' | 'stopping' | 'error';
  rpcReady: boolean;
  feishuConnected: boolean;
  pending: number;
  projectless?: { enabled: boolean; ready: boolean; error: string | null };
  error: string | null;
  tasks: { status: string; count: number }[];
};
export const stoppedStatus = (): DesktopStatus => ({
  phase: 'stopped',
  rpcReady: false,
  feishuConnected: false,
  pending: 0,
  error: null,
  tasks: [],
});
export type DesktopSnapshot = {
  revision?: string | null;
  codexPathNotice?: string;
  settings: DesktopSettings;
  activeSettings: DesktopSettings | null;
  hasDraft: boolean;
  configured: boolean;
  hasSecret: boolean;
  hasDesktopNotifications: boolean;
  dataDir: string;
  status: DesktopStatus;
};
export type CheckResult = { ok: boolean; message: string; binary?: string };
export type LoginItemState = {
  supported: boolean;
  canEnable: boolean;
  status:
    'enabled' | 'not-registered' | 'requires-approval' | 'not-found' | 'unavailable' | 'error';
  enabled: boolean;
  requested: boolean;
  message: string;
};
export type DiscoveredProject = {
  key: string;
  name: string;
  root: string;
  remotePermissions?: RemotePermissions;
};
export type ProjectDiscovery = {
  projects: DiscoveredProject[];
  canonicalRoots: Record<string, string>;
  unavailableRoots?: string[];
  unavailable: number;
  warning?: string;
};
export type DesktopApi = {
  feishuSetup(action: FeishuSetupAction): Promise<FeishuSetupState>;
  applyFeishuSetup(revision: string): Promise<DesktopSnapshot>;
  mergeFeishuSetup(revision: string | null): Promise<DesktopSnapshot>;
  openFeishu(entry: OfficialEntry): Promise<void>;
  copyFeishu(item: 'permissions' | 'events' | 'binding'): Promise<void>;
  onFeishuSetup(listener: (state: FeishuSetupState) => void): () => void;
  load(): Promise<DesktopSnapshot>;
  saveDraft(settings: DesktopSettings, secret: string): Promise<DesktopSnapshot>;
  apply(settings: DesktopSettings, secret: string): Promise<DesktopSnapshot>;
  checkCodex(binary: string): Promise<CheckResult>;
  checkProjectless(binary: string): Promise<CheckResult>;
  checkFeishu(settings: DesktopSettings, secret: string): Promise<CheckResult>;
  start(): Promise<DesktopStatus>;
  stop(): Promise<DesktopStatus>;
  chooseDirectory(): Promise<string | null>;
  chooseCodex(): Promise<string | null>;
  discoverProjects(
    knownRoots: string[],
    feishu: DesktopSettings['feishu'],
  ): Promise<ProjectDiscovery>;
  logs(): Promise<string[]>;
  openData(): Promise<void>;
  copyDiagnostics(): Promise<void>;
  loginItem(): Promise<LoginItemState>;
  setLoginItem(enabled: boolean): Promise<LoginItemState>;
  onBeforeClose(listener: () => Promise<void>): () => void;
  onCloseCancelled(listener: () => void): () => void;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  onLogs(listener: (lines: string[]) => void): () => void;
};
export const uiRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('applyFeishuSetup'), revision: z.string().uuid() }),
  z.strictObject({ method: z.literal('feishuSetup'), action: setupActionSchema }),
  z.strictObject({ method: z.literal('mergeFeishuSetup'), revision: z.string().uuid().nullable() }),
  z.strictObject({ method: z.literal('openFeishu'), entry: officialEntrySchema }),
  z.strictObject({
    method: z.literal('copyFeishu'),
    item: z.enum(['permissions', 'events', 'binding']),
  }),
  z.strictObject({
    method: z.enum([
      'load',
      'start',
      'stop',
      'chooseDirectory',
      'chooseCodex',
      'logs',
      'openData',
      'copyDiagnostics',
      'loginItem',
    ]),
  }),
  z.strictObject({
    method: z.literal('saveDraft'),
    settings: desktopSettingsSchema,
    secret: z.string().max(256),
  }),
  z.strictObject({
    method: z.literal('apply'),
    settings: desktopSettingsSchema,
    secret: z.string().max(256),
  }),
  z.strictObject({
    method: z.literal('checkFeishu'),
    settings: desktopSettingsSchema,
    secret: z.string().max(256),
  }),
  z.strictObject({ method: z.literal('checkCodex'), binary: text }),
  z.strictObject({ method: z.literal('checkProjectless'), binary: text }),
  z.strictObject({
    method: z.literal('discoverProjects'),
    knownRoots: z.array(text).max(600),
    feishu: desktopSettingsSchema.shape.feishu,
  }),
  z.strictObject({ method: z.literal('setLoginItem'), enabled: z.boolean() }),
]);
export type UiRequest = z.infer<typeof uiRequestSchema>;
