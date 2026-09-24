import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell, Menu } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Backend } from './backend.js';
import { flushDraftBeforeClose } from './draft-close.js';
import { LoginItemController } from './login-item.js';
import { z } from 'zod';
import { DesktopVault, defaultSettings } from '../../../src/desktop/vault.js';
import {
  uiRequestSchema,
  type DesktopSnapshot,
  type DesktopStatus,
  type UiRequest,
} from '../../../src/desktop/contracts.js';
import { canonicalDirectory } from '../../../src/projects/store.js';

const runtimeRoot = app.isPackaged
  ? join(process.resourcesPath, 'desktop-runtime')
  : join(__dirname, '../../../.artifacts/desktop-runtime');
const root = app.isPackaged
  ? join(homedir(), 'Library/Application Support/CodexConnector')
  : join(__dirname, '../../../.artifacts/desktop-user-data');
app.setPath('userData', root);
let window: BrowserWindow | null = null;
let backend: Backend;
let vault: DesktopVault;
let quitting = false;
let quitApproved = false;
let changes: Promise<unknown> = Promise.resolve();
const uiFile = join(__dirname, 'ui/index.html');
const loginItem = new LoginItemController(app);

function snapshot(): DesktopSnapshot {
  const active = vault.read('active');
  const shown = vault.read('draft') ?? active;
  const defaults = defaultSettings();
  defaults.codexBinary =
    [
      defaults.codexBinary,
      '/Applications/Codex.app/Contents/Resources/codex',
      join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
      join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
    ].find(existsSync) ?? defaults.codexBinary;
  return {
    settings: shown?.settings ?? defaults,
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
    case 'load':
      return snapshot();
    case 'loginItem':
      return loginItem.read();
    case 'setLoginItem':
      return loginItem.set(request.enabled);
    case 'saveDraft':
      vault.write('draft', vault.prepare(request.settings, request.secret));
      return snapshot();
    case 'apply': {
      await stopped();
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
      return backend.request('discoverProjects', request.knownRoots);
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
    if (backend.connected) await stopWithConfirmation();
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
      vault = new DesktopVault(root, {
        encrypt(value) {
          if (!safeStorage.isEncryptionAvailable())
            throw new Error('无法访问 Keychain，未保存凭据');
          return safeStorage.encryptString(value).toString('base64');
        },
        decrypt(value) {
          try {
            return safeStorage.decryptString(Buffer.from(value, 'base64'));
          } catch {
            throw new Error('无法解密 Secret，请重新授权 Keychain 或重新填写');
          }
        },
      });
      backend = new Backend(runtimeRoot, (status) => {
        if (window && !window.isDestroyed()) window.webContents.send('desktop:status', status);
      });
      await backend.request('initialize', root);
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
            return { ok: false, error: error instanceof Error ? error.message : '操作失败' };
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
        backgroundColor: '#f5f3ed',
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
