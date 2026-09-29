import { DesktopFeishuSetup } from '../../../src/desktop/feishu-setup.js';
import {
  assertAuthorizationUrl,
  FEISHU_SETUP_MANIFEST,
  officialUrl,
} from '../../../src/feishu/setup-contracts.js';
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell, Menu } from 'electron';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveCodexBinary } from '../../../src/codex/binary.js';
import { pathToFileURL } from 'node:url';
import { Backend } from './backend.js';
import { flushDraftBeforeClose } from './draft-close.js';
import { LoginItemController } from './login-item.js';
import { z } from 'zod';
import { DesktopVault, defaultSettings, profileId } from '../../../src/desktop/vault.js';
import {
  uiRequestSchema,
  type DesktopSnapshot,
  type DesktopStatus,
  type UiRequest,
} from '../../../src/desktop/contracts.js';
import { canonicalDirectory } from '../../../src/projects/store.js';

const runtimeRoot = app.isPackaged
  ? join(process.resourcesPath, 'desktop-runtime')
  : resolve(
      process.env.CONNECTOR_DEV_RUNTIME_ROOT ??
        join(__dirname, '../../../.artifacts/desktop-runtime'),
    );
const root = app.isPackaged
  ? join(homedir(), 'Library/Application Support/CodexConnector')
  : resolve(
      process.env.CONNECTOR_DEV_DATA_ROOT ??
        join(__dirname, '../../../.artifacts/desktop-user-data'),
    );
app.setPath('userData', root);
let window: BrowserWindow | null = null;
let backend: Backend;
let vault: DesktopVault;
let feishuSetup: DesktopFeishuSetup;
let quitting = false;
let quitApproved = false;
let changes: Promise<unknown> = Promise.resolve();
const uiFile = join(__dirname, 'ui/index.html');
const loginItem = new LoginItemController(app);

function snapshot(): DesktopSnapshot {
  const active = vault.read('active');
  const shown = vault.read('draft') ?? active;
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
    hasDraft: Boolean(vault.read('draft')),
    configured: Boolean(active),
    hasSecret: Boolean(shown?.encryptedSecret),
    hasDesktopNotifications: Boolean(active?.legacy?.notify),
    dataDir: active ? vault.dataDir(active) : root,
    status: backend.status,
  };
}
async function stopped() {
  if ((await backend.request<DesktopStatus>('status')).phase !== 'stopped')
    throw new Error('请先停止服务，再应用配置');
}
async function stopWithConfirmation(): Promise<DesktopStatus> {
  const status = await backend.request<DesktopStatus>('status');
  if (status.pending > 0) {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: '停止飞书任务',
      message: `还有 ${status.pending} 个未完成任务`,
      detail:
        '停止后将取消排队任务、中断飞书运行任务；未确认的任务会保留待核对记录。Codex 桌面端独立任务继续运行。',
      buttons: ['继续运行', '停止任务'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) throw new Error('已取消停止，服务继续运行');
  }
  return backend.request<DesktopStatus>('stop');
}
async function handle(request: UiRequest): Promise<unknown> {
  switch (request.method) {
    case 'feishuSetup':
      return feishuSetup.action(request.action);
    case 'applyFeishuSetup': {
      await stopped();
      await feishuSetup.finishConnection();
      const defaults = defaultSettings();
      defaults.codexBinary = resolveCodexBinary();
      feishuSetup.finish(request.revision, defaults);
      return snapshot();
    }
    case 'mergeFeishuSetup':
      feishuSetup.merge(request.revision);
      return snapshot();
    case 'openFeishu': {
      const setup = feishuSetup.snapshot();
      if (request.entry === 'authorization') {
        if (!setup.qr || setup.qr.expiresAt <= Date.now())
          throw new Error('二维码已过期，请重新生成');
        await shell.openExternal(assertAuthorizationUrl(setup.qr.url));
      } else
        await shell.openExternal(
          officialUrl(
            request.entry,
            setup.draft?.fields.appId || setup.appId || snapshot().settings.feishu.appId,
          ),
        );
      return;
    }
    case 'copyFeishu': {
      const binding = feishuSetup.snapshot().bindingCommand;
      if (request.item === 'binding' && (!binding || binding.expiresAt <= Date.now()))
        throw new Error('绑定指令已过期，请重新绑定');
      await clipboard.writeText(
        request.item === 'permissions'
          ? JSON.stringify({ scopes: FEISHU_SETUP_MANIFEST.scopes }, null, 2)
          : request.item === 'events'
            ? [...FEISHU_SETUP_MANIFEST.events, ...FEISHU_SETUP_MANIFEST.callbacks].join('\n')
            : binding!.text,
      );
      return;
    }
    case 'load':
      return snapshot();
    case 'loginItem':
      return loginItem.read();
    case 'setLoginItem':
      return loginItem.set(request.enabled);
    case 'saveDraft':
      vault.write('draft', vault.prepare(request.settings, request.secret));
      feishuSetup.refresh();
      return snapshot();
    case 'apply': {
      await stopped();
      if (feishuSetup.snapshot().operationId || feishuSetup.snapshot().connectionExpiresAt)
        throw new Error('请先结束飞书配置连接或检查，再应用配置');
      const credentials = vault.credentials(request.settings, request.secret);
      const active = vault.read('active');
      const record = vault.prepare(request.settings, credentials.appSecret);
      await backend.request('validate', {
        settings: request.settings,
        credentials,
        legacy: record.legacy,
        ...(active ? { dataDir: vault.dataDir(active) } : {}),
      });
      vault.write('active', record);
      return snapshot();
    }
    case 'checkProjectless':
      return backend.request('projectlessCheck', request.binary);
    case 'checkCodex':
      return backend.request('doctor', request.binary);
    case 'checkFeishu': {
      try {
        return await backend.request(
          'feishuCheck',
          vault.credentials(request.settings, request.secret),
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
      if (feishuSetup.snapshot().operationId || feishuSetup.snapshot().connectionExpiresAt)
        throw new Error('请先结束飞书配置连接或检查，再启动正式服务');
      const active = vault.read('active');
      if (!active) throw new Error('请先应用配置');
      if (vault.read('draft')) throw new Error('存在未应用草稿，请先应用配置后启动');
      return backend.request('start', {
        settings: active.settings,
        dataDir: vault.dataDir(active),
        credentials: vault.credentials(active.settings),
        legacy: active.legacy,
      });
    }
    case 'stop':
      return stopWithConfirmation();
    case 'chooseDirectory':
    case 'chooseCodex': {
      const result = await dialog.showOpenDialog({
        title: request.method === 'chooseDirectory' ? '选择项目目录' : '选择 Codex 可执行文件',
        properties:
          request.method === 'chooseDirectory'
            ? ['openDirectory']
            : ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
      });
      const path = result.canceled ? null : (result.filePaths[0] ?? null);
      return path && request.method === 'chooseDirectory' ? canonicalDirectory(path) : path;
    }
    case 'discoverProjects':
      return backend.request('discoverProjects', {
        knownRoots: request.knownRoots,
        dataDir: join(root, 'profiles', profileId({ feishu: request.feishu })),
        feishu: request.feishu,
      });
    case 'logs': {
      const active = vault.read('active');
      return active ? backend.request('logs', vault.dataDir(active)) : [];
    }
    case 'openData': {
      const error = await shell.openPath(root);
      if (error) throw new Error('无法打开数据目录');
      return;
    }
    case 'copyDiagnostics':
      await clipboard.writeText(
        JSON.stringify(
          {
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            runtime: backend.status,
          },
          null,
          2,
        ),
      );
      return;
  }
}
async function quit() {
  if (quitting) return;
  quitting = true;
  try {
    if (window && !window.isDestroyed())
      await flushDraftBeforeClose(window.webContents, ipcMain, pathToFileURL(uiFile).href);
    if (backend.connected) {
      await feishuSetup.cancel();
      await stopWithConfirmation();
    }
    await backend.close();
    quitApproved = true;
    app.quit();
  } catch (error) {
    quitting = false;
    if (window && !window.isDestroyed()) window.webContents.send('desktop:close-cancelled');
    await dialog.showMessageBox({
      type: 'info',
      message: error instanceof Error ? error.message : '尚未停止，请重试',
    });
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (!quitApproved && backend) {
      event.preventDefault();
      quit().catch(() => {});
    }
  });
  app
    .whenReady()
    .then(async () => {
      // Packaged apps use the ICNS in the bundle; use the same artwork in development.
      if (!app.isPackaged && process.platform === 'darwin')
        app.dock?.setIcon(join(__dirname, 'ui/app-icon.png'));
      const cipher = {
        encrypt(value: string) {
          if (!safeStorage.isEncryptionAvailable())
            throw new Error('无法访问 Keychain，未保存凭据');
          return safeStorage.encryptString(value).toString('base64');
        },
        decrypt(value: string) {
          try {
            return safeStorage.decryptString(Buffer.from(value, 'base64'));
          } catch {
            throw new Error('无法解密 Secret，请重新授权 Keychain 或重新填写');
          }
        },
      };
      vault = new DesktopVault(root, cipher);
      backend = new Backend(runtimeRoot, (status) => {
        if (window && !window.isDestroyed()) window.webContents.send('desktop:status', status);
      });
      await backend.request('initialize', root);
      feishuSetup = new DesktopFeishuSetup(
        vault,
        cipher,
        {
          get status() {
            return backend.status;
          },
          invoke<T = unknown>(method: string, args?: unknown) {
            return backend.request<T>(method, args);
          },
        },
        (state) => {
          if (window && !window.isDestroyed())
            window.webContents.send('desktop:feishu-setup', state);
        },
      );
      backend.onSetup = (value) => feishuSetup.progress(value);
      ipcMain.handle('desktop:request', async (event, raw: unknown) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame?.url !== pathToFileURL(uiFile).href
        )
          throw new Error('非法界面来源');
        const request = uiRequestSchema.parse(raw);
        const run = async () => {
          try {
            return { ok: true, value: await handle(request) };
          } catch (error) {
            const labels: Record<string, string> = {
              appId: 'App ID',
              appSecret: 'App Secret',
              tenantKey: 'Tenant Key',
              allowedOpenId: '用户 Open ID',
              testChatId: '单聊 Chat ID',
            };
            return {
              ok: false,
              error:
                error instanceof z.ZodError
                  ? `请检查配置字段：${error.issues.map((issue) => labels[String(issue.path.at(-1))] ?? issue.path.join('.')).join('、')}`
                  : error instanceof Error
                    ? error.message
                    : '操作失败',
            };
          }
        };
        const operation = changes.then(run);
        changes = operation;
        return operation;
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'CodexConnector',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: '退出 CodexConnector',
                accelerator: 'CmdOrCtrl+Q',
                click: () => {
                  quit().catch(() => {});
                },
              },
            ],
          },
          { role: 'editMenu' },
          { role: 'windowMenu' },
        ]),
      );
      window = new BrowserWindow({
        width: 1120,
        height: 790,
        minWidth: 900,
        minHeight: 650,
        title: 'CodexConnector',
        backgroundColor: '#f4f6f8',
        titleBarStyle: 'hiddenInset',
        webPreferences: {
          preload: join(__dirname, 'preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      window.on('close', (event) => {
        if (!quitApproved) {
          event.preventDefault();
          quit().catch(() => {});
        }
      });
      if (!existsSync(join(runtimeRoot, 'node')))
        dialog.showErrorBox(
          '运行环境缺失',
          '请重新安装完整 App，或在开发目录执行 pnpm desktop:build。',
        );
      return window.loadFile(uiFile);
    })
    .catch((error) => {
      dialog.showErrorBox('启动失败', error instanceof Error ? error.message : '无法打开 App');
      quitApproved = true;
      app.quit();
    });
}
