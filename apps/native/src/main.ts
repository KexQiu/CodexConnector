import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DesktopApi, UiRequest } from '../../../src/desktop/contracts.js';
import { desktopError } from '../../../src/desktop/ui-error.js';

async function call<T>(request: UiRequest): Promise<T> {
  try {
    return await invoke<T>('desktop_request', { request });
  } catch (cause) {
    throw desktopError(cause);
  }
}
function subscribe<T>(event: string, listener: (value: T) => void): () => void {
  let active = true;
  let remove: (() => void) | undefined;
  listen<T>(event, ({ payload }) => {
    if (active) listener(payload);
  })
    .then((unlisten) => {
      if (active) remove = unlisten;
      else unlisten();
    })
    .catch(() => {});
  return () => {
    active = false;
    remove?.();
  };
}
window.desktop = {
  load: () => call({ method: 'load' }),
  saveDraft: (settings, secret) => call({ method: 'saveDraft', settings, secret }),
  apply: (settings, secret) => call({ method: 'apply', settings, secret }),
  feishuSetup: (action) => call({ method: 'feishuSetup', action }),
  applyFeishuSetup: (revision) => call({ method: 'applyFeishuSetup', revision }),
  mergeFeishuSetup: (revision) => call({ method: 'mergeFeishuSetup', revision }),
  openFeishu: (entry) => call({ method: 'openFeishu', entry }),
  copyFeishu: (item) => call({ method: 'copyFeishu', item }),
  checkCodex: (binary) => call({ method: 'checkCodex', binary }),
  checkProjectless: (binary) => call({ method: 'checkProjectless', binary }),
  checkFeishu: (settings, secret) => call({ method: 'checkFeishu', settings, secret }),
  start: () => call({ method: 'start' }),
  stop: () => call({ method: 'stop' }),
  chooseDirectory: () => call({ method: 'chooseDirectory' }),
  chooseCodex: () => call({ method: 'chooseCodex' }),
  discoverProjects: (knownRoots, feishu) =>
    call({ method: 'discoverProjects', knownRoots, feishu }),
  logs: () => call({ method: 'logs' }),
  openData: () => call({ method: 'openData' }),
  copyDiagnostics: () => call({ method: 'copyDiagnostics' }),
  loginItem: () => call({ method: 'loginItem' }),
  setLoginItem: (enabled) => call({ method: 'setLoginItem', enabled }),
  onFeishuSetup: (listener) => subscribe('desktop:feishu-setup', listener),
  onStatus: (listener) => subscribe('desktop:status', listener),
  onCloseCancelled: (listener) => subscribe('desktop:close-cancelled', listener),
  onBeforeClose: (listener) =>
    subscribe<string>('desktop:flush-draft', (token) => {
      Promise.resolve()
        .then(listener)
        .then(
          () => invoke('draft_flushed', { token, ok: true }),
          () => invoke('draft_flushed', { token, ok: false }),
        )
        .catch(() => {});
    }),
  onLogs: (listener) => {
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (!active || reading) return;
      reading = true;
      try {
        const lines = await call<string[]>({ method: 'logs' });
        if (active) listener(lines);
      } catch {
        /* The status subscription reports backend failures. */
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
} satisfies DesktopApi;

// Keep the tested React screens while replacing their host and IPC transport.
import('../../desktop/src/renderer.js')
  .then(() => {
    document
      .querySelectorAll('.sidebar-brand, .topbar')
      .forEach((element) => element.setAttribute('data-tauri-drag-region', ''));
    if (new URLSearchParams(location.search).get('smoke') === '1') {
      const until = Date.now() + 10_000;
      const report = async () => {
        const images = [...document.images];
        const assetsLoaded =
          images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
        if (!document.body.innerText.includes('准备清单') || !assetsLoaded) {
          if (Date.now() > until) throw new Error('renderer_or_assets_not_ready');
          setTimeout(() => {
            report().catch(() => {});
          }, 50);
          return;
        }
        const state = await window.desktop.load();
        let errorsVisible = false;
        try {
          await window.desktop.start();
        } catch (cause) {
          errorsVisible = cause instanceof Error && cause.message.includes('启动诊断模式不会');
        }
        await invoke('smoke_complete', {
          result: {
            renderer: true,
            assetsLoaded,
            errorsVisible,
            ipc: true,
            configured: state.configured,
            phase: state.status.phase,
            feishuConnected: state.status.feishuConnected,
          },
        });
      };
      report().catch(() => {});
    }
  })
  .catch(() => {});
