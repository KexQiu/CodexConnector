import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainEvent, WebContents } from 'electron';

/** Quit waits for renderer edits to reach the encrypted, atomic draft on disk. */
export function flushDraftBeforeClose(
  contents: WebContents,
  ipc: IpcMain,
  expectedUrl: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = randomUUID();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ipc.removeListener('desktop:draft-flushed', receive);
      if (error) reject(error);
      else resolve();
    };
    const receive = (event: IpcMainEvent, raw: unknown) => {
      if (event.sender !== contents || event.senderFrame?.url !== expectedUrl) return;
      if (!raw || typeof raw !== 'object' || !('token' in raw) || raw.token !== token) return;
      finish(
        'ok' in raw && raw.ok === true
          ? undefined
          : new Error('本地缓存尚未保存，已保留窗口，请重试保存后退出。'),
      );
    };
    const timer = setTimeout(
      () => finish(new Error('未能确认本地缓存已保存，已保留窗口，请重试。')),
      timeoutMs,
    );
    ipc.on('desktop:draft-flushed', receive);
    try {
      contents.send('desktop:flush-draft', token);
    } catch {
      finish(new Error('无法确认本地缓存状态，尚未退出。'));
    }
  });
}
