import { createInterface } from 'node:readline';
import { isAbsolute, dirname } from 'node:path';
import { z } from 'zod';
import { Backend } from './backend-client.js';
import { NativeController } from './native-controller.js';
import { nativeCipher } from './native-cipher.js';
import { uiRequestSchema } from './contracts.js';

// Only inherited stdin/stdout pipes are used. No network listener or credential arguments.
process.umask(0o077);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const requestSchema = z.strictObject({
  id: z.number().int().positive(),
  method: z.enum(['initialize', 'request', 'effect', 'status', 'shutdown']),
  args: z.unknown().optional(),
});
let controller: NativeController | undefined;
let key: Buffer | undefined;
let closing = false;
let diagnostic = false;
let shutdownPromise: Promise<void> | undefined;
let queue: Promise<unknown> = Promise.resolve();
function send(value: unknown) {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n');
}
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  shutdownPromise = (async () => {
    try {
      await queue;
      await controller?.close();
    } finally {
      key?.fill(0);
      input.close();
    }
  })();
  return shutdownPromise;
}
async function dispatch(method: string, args: unknown) {
  if (method === 'initialize') {
    if (controller || closing) throw new Error('后台已经初始化');
    const data = z
      .strictObject({
        root: z.string().refine(isAbsolute),
        key: z.string().regex(/^[a-f0-9]{64}$/),
        diagnostic: z.boolean().default(false),
      })
      .parse(args);
    diagnostic = data.diagnostic;
    key = Buffer.from(data.key, 'hex');
    // Resolve only the runtime containing this entry, never a renderer-supplied executable.
    const backend = new Backend(dirname(process.execPath), (value) =>
      send({ event: 'status', value }),
    );
    await backend.invoke('initialize', data.root);
    controller = new NativeController(data.root, nativeCipher(key), backend, (value) =>
      send({ event: 'setup', value }),
    );
    return controller.snapshot();
  }
  if (!controller || closing) throw new Error('后台未就绪或正在退出');
  if (method === 'status') return controller.backend.invoke('status');
  if (method === 'effect') return controller.effect(args);
  if (method === 'request') {
    const request = uiRequestSchema.parse(args);
    if (diagnostic) {
      if (request.method === 'discoverProjects')
        return { projects: [], canonicalRoots: {}, unavailable: 0 };
      if (
        request.method !== 'load' &&
        request.method !== 'logs' &&
        !(request.method === 'feishuSetup' && request.action.kind === 'load')
      )
        throw new Error('启动诊断模式不会修改配置、读取 Codex 数据或启动任务');
    }
    return controller.handle(request);
  }
  throw new Error('不支持的后台操作');
}
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 1024 * 1024) {
    shutdown().catch(() => {});
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return;
  const { id, method, args } = parsed.data;
  if (method === 'shutdown') {
    shutdown().then(
      () => {
        send({ id, ok: true, value: null });
        process.exit(0);
      },
      () => {
        send({ id, ok: false, error: '后端清理尚未确认' });
        process.exit(1);
      },
    );
    return;
  }
  const run = async () => {
    try {
      send({ id, ok: true, value: await dispatch(method, args) });
    } catch (error) {
      send({
        id,
        ok: false,
        error:
          error instanceof z.ZodError
            ? '配置字段格式不正确，请检查当前步骤'
            : error instanceof Error
              ? error.message
              : '操作失败',
      });
    }
  };
  queue = queue.then(run);
});
input.once('close', () => {
  shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.once('SIGTERM', () => {
  shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.once('SIGINT', () => {
  shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
