import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskError } from '../tasks/types.js';

/** Only pass a ChildProcess created by this supervisor. Group mode requires detached spawn. */
export function ownedChildAlive(child: ChildProcess, group = false) {
  if (!child.pid) return false;
  if (!group) return child.exitCode === null && child.signalCode === null;
  return processGroupAlive(child.pid);
}
export function processGroupAlive(pgid: number) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new TaskError('无效的自有进程组');
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
    throw error;
  }
}
export async function stopOwnedChild(
  child: ChildProcess,
  group = false,
  graceMs = 8000,
  killMs = 3000,
) {
  if (!child.pid || !ownedChildAlive(child, group)) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (group) process.kill(-child.pid!, value);
      else child.kill(value);
    } catch (error) {
      // Permission errors cannot prove absence; retain uncertainty and recheck.
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return;
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (ownedChildAlive(child, group) && Date.now() < deadline) await delay(50);
  };
  signal('SIGTERM');
  await wait(graceMs);
  if (ownedChildAlive(child, group)) {
    signal('SIGKILL');
    await wait(killMs);
  }
  if (ownedChildAlive(child, group)) throw new TaskError('自有 App Server 或子进程尚未退出');
}
