import { lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { TaskError } from '../tasks/types.js';

export async function clearStaleSocket(path: string) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!before.isSocket() || before.uid !== process.getuid?.())
    throw new TaskError('socket 路径存在非自有 socket，拒绝删除');
  const result = await new Promise<string>((resolve) => {
    const socket = createConnection({ path });
    const finish = (result: string) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => finish('TIMEOUT'));
    socket.once('connect', () => finish('ACTIVE'));
    socket.once('error', (error) => finish('code' in error ? String(error.code) : 'UNKNOWN'));
  });
  if (!['ECONNREFUSED', 'ENOENT'].includes(result))
    throw new TaskError('socket 仍在监听或无法确认已停止');
  try {
    const after = lstatSync(path);
    if (after.ino !== before.ino || after.dev !== before.dev)
      throw new TaskError('socket 已被替换，拒绝删除');
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}
