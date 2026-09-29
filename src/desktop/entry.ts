import { FeishuSetupBackend } from '../feishu/setup-backend.js';
import { inspectProjectless } from '../conversations/capability.js';
import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { desktopSettingsSchema } from './contracts.js';
import { DesktopRuntime, runtimeInputSchema, validateSettings } from './runtime.js';
import { discoverProfileProjects } from './projects.js';
import { validateCreationRoot } from '../projects/remote.js';
import { credentialsSchema } from '../feishu/credentials.js';
import { FeishuApi, FeishuApiError } from '../feishu/api.js';
import { runDoctor, doctorMessage } from '../cli/doctor.js';
import { assertQuietDatabase } from '../cli/service.js';
import { readPrivate } from '../service/files.js';
import { legacySettingsSchema } from './legacy.js';
import { assertLocalConfigIsProtected } from '../config/local-boundary.js';

if (!process.send) throw new Error('桌面后端只接受私有 IPC 启动');
process.umask(0o077);
const runtime = new DesktopRuntime();
const setup = new FeishuSetupBackend(
  (value) => send({ event: 'setup', value }),
  () => runtime.status().feishuConnected,
);
let closing = false;
let applicationRoot: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
const requestSchema = z.object({
  id: z.number().int(),
  method: z.string(),
  args: z.unknown().optional(),
});
const settingsInput = z.object({
  settings: desktopSettingsSchema,
  credentials: credentialsSchema,
  dataDir: z.string().refine(isAbsolute).optional(),
  legacy: legacySettingsSchema.optional(),
});
function send(value: unknown) {
  if (process.connected) process.send?.(value, () => {});
}
async function dispatch(method: string, args: unknown): Promise<unknown> {
  if (closing) throw new Error('App 正在退出');
  switch (method) {
    case 'setupRun':
      return setup.run(args);
    case 'setupConnect':
      return setup.openSession(args);
    case 'setupPauseBinding':
      return setup.cancel(false);
    case 'setupCancel':
      return setup.cancel();
    case 'initialize':
      applicationRoot = z.string().refine(isAbsolute).parse(args);
      return { ok: true };
    case 'status':
      return runtime.status();
    case 'start':
      return runtime.start(runtimeInputSchema.parse(args));
    case 'stop':
      return runtime.stop();
    case 'validate': {
      const input = settingsInput.parse(args);
      const config = validateSettings(input.settings, input.credentials, input.legacy);
      if (!applicationRoot) throw new Error('桌面后端尚未初始化');
      assertLocalConfigIsProtected(config.projects, [
        applicationRoot,
        ...(input.dataDir ? [input.dataDir] : []),
      ]);
      validateCreationRoot(config, [applicationRoot, ...(input.dataDir ? [input.dataDir] : [])]);
      if (input.dataDir) assertQuietDatabase({ ...config, dataDir: input.dataDir });
      return { ok: true };
    }
    case 'projectlessCheck': {
      const result = await inspectProjectless(z.string().refine(isAbsolute).parse(args));
      return {
        ok: result.ok,
        message: `${result.message} · 当前 ${result.actual ?? '未知'}；支持 ${result.expected}`,
      };
    }
    case 'doctor': {
      const binary = z.string().refine(isAbsolute).parse(args);
      const result = await runDoctor(binary);
      return {
        ok: result.status === 'ok',
        message: doctorMessage(result),
        binary: result.codexBinary,
      };
    }
    case 'feishuCheck': {
      const credentials = credentialsSchema.parse(args);
      try {
        await new FeishuApi(credentials).history(credentials.testChatId, Date.now() - 60_000);
      } catch (error) {
        if (error instanceof FeishuApiError)
          return {
            ok: false,
            message: `飞书检查失败（${error.apiCode ?? error.outcome}），请核对凭据、Chat ID 和会话历史读取权限`,
          };
        throw error;
      }
      return {
        ok: true,
        message: '凭据与会话历史权限可用；用户身份及事件回调仍需通过飞书实际消息验收',
      };
    }
    case 'discoverProjects':
      return discoverProfileProjects(
        z
          .object({
            knownRoots: z.array(z.string().max(4096).refine(isAbsolute)).max(600),
            dataDir: z.string().refine(isAbsolute),
            feishu: desktopSettingsSchema.shape.feishu,
          })
          .parse(args),
      );
    case 'logs': {
      const dir = join(z.string().refine(isAbsolute).parse(args), 'logs');
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => /^(app-server|gateway)\.jsonl$/.test(f))
        .flatMap((f) =>
          readPrivate(join(dir, f), 6 * 1024 * 1024)
            .trim()
            .split('\n')
            .slice(-80)
            .map((line) => {
              try {
                const value = z
                  .object({
                    at: z.unknown().optional(),
                    event: z.string().optional(),
                    phase: z.string().optional(),
                    error: z.string().nullable().optional(),
                  })
                  .parse(JSON.parse(line));
                return JSON.stringify({ component: f.replace('.jsonl', ''), ...value });
              } catch {
                return '[日志格式不可用]';
              }
            }),
        )
        .slice(-160);
    }
    default:
      throw new Error('不支持的桌面操作');
  }
}
const timer = setInterval(() => send({ event: 'status', value: runtime.status() }), 1500);
process.on('message', (raw) => {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return;
  const { id, method, args } = parsed.data;
  const run = async () => {
    try {
      send({ id, ok: true, value: await dispatch(method, args) });
    } catch (error) {
      send({
        id,
        ok: false,
        error:
          error instanceof z.ZodError
            ? `配置字段格式不正确：${error.issues.map((issue) => issue.path.join('.') || '配置').join('；')}`
            : error instanceof Error
              ? error.message
              : '操作失败',
      });
    }
  };
  if (['setupRun', 'setupCancel', 'setupConnect', 'setupPauseBinding'].includes(method))
    run().catch(() => {});
  else queue = queue.then(run);
});
const quit = () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  Promise.all([setup.cancel(), runtime.stop(), queue]).then(
    () => {
      process.exitCode = 0;
      if (process.connected) process.disconnect?.();
    },
    () => {
      process.exitCode = 1;
      if (process.connected) process.disconnect?.();
    },
  );
};
process.once('disconnect', quit);
process.once('SIGTERM', quit);
process.once('SIGINT', quit);
