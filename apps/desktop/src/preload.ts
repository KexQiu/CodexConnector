import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, UiRequest } from '../../../src/desktop/contracts.js';

async function invoke<T>(request: UiRequest): Promise<T> {
  const result = (await ipcRenderer.invoke('desktop:request', request)) as {
    ok: boolean;
    value?: T;
    error?: string;
  };
  if (!result.ok) throw new Error(result.error ?? '操作失败');
  return result.value as T;
}
const api: DesktopApi = {
  feishuSetup: (action) => invoke({ method: 'feishuSetup', action }),
  applyFeishuSetup: (revision) => invoke({ method: 'applyFeishuSetup', revision }),
  mergeFeishuSetup: (revision) => invoke({ method: 'mergeFeishuSetup', revision }),
  openFeishu: (entry) => invoke({ method: 'openFeishu', entry }),
  copyFeishu: (item) => invoke({ method: 'copyFeishu', item }),
  onFeishuSetup: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on('desktop:feishu-setup', receive);
    return () => {
      ipcRenderer.removeListener('desktop:feishu-setup', receive);
    };
  },
  load: () => invoke({ method: 'load' }),
  saveDraft: (settings, secret) => invoke({ method: 'saveDraft', settings, secret }),
  apply: (settings, secret) => invoke({ method: 'apply', settings, secret }),
  checkProjectless: (binary) => invoke({ method: 'checkProjectless', binary }),
  checkCodex: (binary) => invoke({ method: 'checkCodex', binary }),
  checkFeishu: (settings, secret) => invoke({ method: 'checkFeishu', settings, secret }),
  start: () => invoke({ method: 'start' }),
  stop: () => invoke({ method: 'stop' }),
  chooseDirectory: () => invoke({ method: 'chooseDirectory' }),
  chooseCodex: () => invoke({ method: 'chooseCodex' }),
  discoverProjects: (knownRoots, feishu) =>
    invoke({ method: 'discoverProjects', knownRoots, feishu }),
  logs: () => invoke({ method: 'logs' }),
  openData: () => invoke({ method: 'openData' }),
  copyDiagnostics: () => invoke({ method: 'copyDiagnostics' }),
  loginItem: () => invoke({ method: 'loginItem' }),
  setLoginItem: (enabled) => invoke({ method: 'setLoginItem', enabled }),
  onBeforeClose: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, token: unknown) => {
      if (typeof token !== 'string') return;
      Promise.resolve()
        .then(listener)
        .then(
          () => ipcRenderer.send('desktop:draft-flushed', { token, ok: true }),
          () => ipcRenderer.send('desktop:draft-flushed', { token, ok: false }),
        );
    };
    ipcRenderer.on('desktop:flush-draft', receive);
    return () => {
      ipcRenderer.removeListener('desktop:flush-draft', receive);
    };
  },
  onCloseCancelled: (listener) => {
    const receive = () => listener();
    ipcRenderer.on('desktop:close-cancelled', receive);
    return () => {
      ipcRenderer.removeListener('desktop:close-cancelled', receive);
    };
  },
  onStatus: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) =>
      listener(status);
    ipcRenderer.on('desktop:status', receive);
    return () => {
      ipcRenderer.removeListener('desktop:status', receive);
    };
  },
  onLogs: (listener) => {
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (!active || reading) return;
      reading = true;
      try {
        const lines = await invoke<string[]>({ method: 'logs' });
        if (active) listener(lines);
      } catch {
        // Connection errors are already shown by the status subscription.
      } finally {
        reading = false;
      }
    };
    refresh().catch(() => {});
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  },
};
contextBridge.exposeInMainWorld('desktop', api);
