import type { SetupProgress } from '../feishu/setup-backend.js';
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { stoppedStatus, type DesktopStatus } from './contracts.js';

export class Backend {
  private child: ChildProcess;
  private nextId = 1;
  private closing = false;
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  status = stoppedStatus();
  onSetup: ((value: SetupProgress) => void) | undefined;
  get connected() {
    return this.child.connected;
  }
  constructor(runtimeRoot: string, onStatus: (status: DesktopStatus) => void) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = fork(join(runtimeRoot, 'backend', 'desktop', 'entry.js'), [], {
      execPath: join(runtimeRoot, 'node'),
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
      this.child.once('error', () => resolve({ code: 1, signal: null }));
    });
    this.child.on('message', (raw: unknown) => {
      const setup = z.object({ event: z.literal('setup'), value: z.unknown() }).safeParse(raw);
      if (setup.success) {
        this.onSetup?.(setup.data.value as SetupProgress);
        return;
      }
      const event = z.object({ event: z.literal('status'), value: z.unknown() }).safeParse(raw);
      if (event.success) {
        this.status = event.data.value as DesktopStatus;
        onStatus(this.status);
        return;
      }
      const result = z
        .object({
          id: z.number(),
          ok: z.boolean(),
          value: z.unknown().optional(),
          error: z.string().optional(),
        })
        .safeParse(raw);
      if (!result.success) return;
      const waiter = this.pending.get(result.data.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(result.data.id);
      if (result.data.ok) waiter.resolve(result.data.value);
      else waiter.reject(new Error(result.data.error ?? '后台操作失败'));
    });
    const failed = () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('后台进程已退出，请重新打开 App 并检查日志'));
      }
      this.pending.clear();
      if (this.closing) return;
      this.status = { ...stoppedStatus(), phase: 'error', error: '后台进程已退出' };
      onStatus(this.status);
    };
    this.child.once('error', failed);
    this.child.once('exit', failed);
  }
  invoke<T = unknown>(method: string, args?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.child.connected) {
        reject(new Error('后台进程未连接，请重新打开 App'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error('操作仍未确认，请检查服务状态后重试'));
        },
        method === 'setupRun' ? 720_000 : 120_000,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child.send({ id, method, args }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('无法连接后台进程'));
        }
      });
    });
  }
  async close() {
    if (this.child.connected) {
      await this.invoke('setupCancel');
      await this.invoke('stop');
      this.closing = true;
      this.child.disconnect();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('后台进程清理尚未确认，请检查日志后重试')),
            15_000,
          );
        }),
      ]);
      if (result.code !== 0 || result.signal)
        throw new Error('后台进程异常退出，请检查日志和未决任务');
    } finally {
      clearTimeout(timer);
    }
  }
}
