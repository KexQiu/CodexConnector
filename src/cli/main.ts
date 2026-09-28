import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ConfigurationError, loadConfig, resolveConfigPath } from '../config/schema.js';
import { runDoctor, inspectTaskDatabase } from './doctor.js';
import { runTaskCli } from './tasks.js';
import { TaskError } from '../tasks/types.js';
import { runGatewayCli } from './gateway.js';
import { runServiceCli } from './service.js';
import { inspectNode, nodeCompatibilityMessage } from '../node-compatibility.js';

const HELP = `CodexConnector — 本地持久化任务与门禁

用法：
  pnpm run doctor
  pnpm config:check --config /absolute/path/to/config.json
  pnpm start --help
  pnpm gate:rpc --help
  pnpm dev projects --config /absolute/config.json
  pnpm dev sessions --project KEY --config /absolute/config.json
  pnpm dev task-create --project KEY --request-key UNIQUE --prompt-file FILE --config /absolute/config.json
  pnpm dev task-create --project KEY --thread-id OWNED_THREAD --request-key UNIQUE --prompt-file FILE --config /absolute/config.json
  pnpm dev worker --once --timeout 120 --config /absolute/config.json
  pnpm dev tasks --config /absolute/config.json
  pnpm dev task TASK_ID --result --config /absolute/config.json
  pnpm dev recover [TASK_ID] --config /absolute/config.json
  pnpm dev state --config /absolute/config.json
  pnpm dev db-backup --destination /private/path/backup.sqlite --config /absolute/config.json
  pnpm dev gateway --config /absolute/config.json [--timeout 900]
  pnpm dev feishu-recover-message --message-id om_MESSAGE --config /absolute/config.json
  pnpm build
  pnpm start service-prepare --config /absolute/config.json
  pnpm start service-install --config /absolute/config.json
  pnpm start service-status --config /absolute/config.json
  pnpm start service-stop --config /absolute/config.json
  pnpm start service-start --config /absolute/config.json
  pnpm start service-uninstall --config /absolute/config.json
  pnpm start service-maintain --config /absolute/config.json
  pnpm start service-restore-check --backup /private/backup.sqlite --destination /new/private/restore.sqlite --config /absolute/config.json

doctor 检查本机依赖/版本；传 --config 时只读检查已有任务库，不执行迁移。
config-check 只校验配置结构，不读取密钥。
task-create 只入队；worker 连接独立 App Server，M2 不启动常驻服务。
recover 只恢复订阅/核对已知 turn，不重放未知提交；旧连接审批作废，不自动批准。
gateway 在前台接收白名单单聊，支持审批卡、/回答、/补充、/打断；不会安装后台服务。
`;

export async function runCli(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        config: { type: 'string' },
        project: { type: 'string' },
        'request-key': { type: 'string' },
        'prompt-file': { type: 'string' },
        'thread-id': { type: 'string' },
        result: { type: 'boolean' },
        once: { type: 'boolean' },
        timeout: { type: 'string' },
        offset: { type: 'string' },
        limit: { type: 'string' },
        destination: { type: 'string' },
        'message-id': { type: 'string' },
        backup: { type: 'string' },
      },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      process.stdout.write(HELP);
      return 0;
    }
    const command = positionals[0];
    if (command !== 'doctor') {
      const node = inspectNode();
      if (!node.ok) {
        process.stderr.write(`${nodeCompatibilityMessage(node)}\n`);
        return 1;
      }
    }
    if (command?.startsWith('service-')) {
      const path = resolveConfigPath(values.config);
      return await runServiceCli(command, positionals, values, path, await loadConfig(path));
    }
    if (command === 'gateway' || command === 'feishu-recover-message') {
      if (positionals.length !== 1) throw new TaskError('命令参数过多');
      return await runGatewayCli(
        await loadConfig(resolveConfigPath(values.config)),
        values,
        command === 'feishu-recover-message',
      );
    }
    if (
      command &&
      [
        'projects',
        'sessions',
        'task-create',
        'tasks',
        'task',
        'worker',
        'recover',
        'state',
        'db-backup',
      ].includes(command)
    ) {
      return await runTaskCli(
        command,
        positionals,
        values,
        await loadConfig(resolveConfigPath(values.config)),
      );
    }
    if (positionals.length !== 1) throw new ConfigurationError('只接受一个命令');
    if (command === 'doctor') {
      const config = values.config ? await loadConfig(resolveConfigPath(values.config)) : null;
      const report = await runDoctor(config?.codex.binary);
      const persistence = config ? inspectTaskDatabase(config.dataDir) : undefined;
      const healthy =
        report.status === 'ok' &&
        (!persistence || ['ok', 'not-initialized'].includes(persistence.status));
      process.stdout.write(
        `${JSON.stringify({ ...report, status: healthy ? 'ok' : 'unhealthy', ...(persistence ? { scope: 'local-compatibility-and-persistence', persistence } : {}) }, null, 2)}\n`,
      );
      return healthy ? 0 : 1;
    }
    if (command === 'config-check') {
      const path = resolveConfigPath(values.config);
      const config = await loadConfig(path);
      process.stdout.write(
        `${JSON.stringify({ status: 'valid', schemaVersion: config.schemaVersion, projects: config.projects.length, scope: 'structure-only' })}\n`,
      );
      return 0;
    }
    if (command === 'version') {
      const metadata: unknown = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      );
      if (metadata && typeof metadata === 'object' && 'version' in metadata)
        process.stdout.write(`${String(metadata.version)}\n`);
      return 0;
    }
    throw new ConfigurationError('未知命令；使用 --help 查看已实现入口');
  } catch (error) {
    const message =
      error instanceof ConfigurationError || error instanceof TaskError
        ? error.message
        : '命令执行失败，请检查本机依赖、连接、数据库权限和命令参数';
    process.stderr.write(`${message}\n`);
    return 1;
  }
}
