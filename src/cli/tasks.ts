import { mkdirSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { GatewayConfig } from '../config/schema.js';
import { runtimePaths } from '../config/schema.js';
import { CodexRpcClient } from '../codex/rpc-client.js';
import { ProjectStore, executableProject } from '../projects/store.js';
import { openGatewayDatabase, backupGatewayDatabase } from '../persistence/database.js';
import { TaskStore, ownerKey } from '../tasks/store.js';
import { configuredOwner, TaskWorker, taskSummary } from '../tasks/worker.js';
import { TaskError } from '../tasks/types.js';

interface TaskOptions {
  project?: string | undefined;
  'request-key'?: string | undefined;
  'prompt-file'?: string | undefined;
  'thread-id'?: string | undefined;
  result?: boolean | undefined;
  once?: boolean | undefined;
  timeout?: string | undefined;
  offset?: string | undefined;
  limit?: string | undefined;
  destination?: string | undefined;
}
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

export async function runTaskCli(
  command: string,
  positionals: string[],
  values: TaskOptions,
  config: GatewayConfig,
): Promise<number> {
  if (command === 'projects' || command === 'sessions') {
    const rpc = new CodexRpcClient({ endpoint: config.codex.endpoint });
    try {
      await rpc.connect();
      const projects = new ProjectStore(config.projects, rpc);
      output(
        command === 'projects'
          ? await projects.catalog()
          : await projects.sessions(
              values.project ?? '',
              Number(values.offset ?? 0),
              Number(values.limit ?? 20),
            ),
      );
      return 0;
    } finally {
      rpc.close();
    }
  }
  if (positionals.length > (['task', 'recover'].includes(command) ? 2 : 1))
    throw new TaskError('命令参数过多');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(config.dataDir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new TaskError('dataDir 必须是当前用户私有目录（700），且不能是符号链接');
  const db = openGatewayDatabase(runtimePaths(config.dataDir).database);
  try {
    // Back up the existing schema BEFORE TaskStore can migrate it.
    if (command === 'db-backup') {
      const destination = values.destination;
      if (!destination || !isAbsolute(destination))
        throw new TaskError('需要绝对路径 --destination；父目录应为 700');
      await backupGatewayDatabase(db, destination);
      output({ status: 'backed-up', path: destination });
      return 0;
    }
    const store = new TaskStore(db);
    const owner = configuredOwner(config),
      key = ownerKey(owner);
    if (command === 'tasks') {
      output(store.list(key).map(taskSummary));
      return 0;
    }
    if (command === 'task') {
      const task = store.get(positionals[1] ?? '');
      if (task.owner_key !== key) throw new TaskError('任务不属于当前配置的用户');
      output({
        ...taskSummary(task),
        ...(values.result ? { result: store.result(task.task_id) } : {}),
      });
      return 0;
    }
    if (command === 'task-create') {
      if (!values.project || !values['request-key'] || !values['prompt-file'])
        throw new TaskError('需要 --project、--request-key 和 --prompt-file');
      const project = executableProject(config.projects, values.project);
      const prompt = await readFile(resolve(values['prompt-file']), 'utf8');
      const result = store.submit({
        owner,
        requestKey: values['request-key'],
        projectKey: project.key,
        cwd: project.cwd,
        prompt,
        ...(values['thread-id'] ? { threadId: values['thread-id'] } : {}),
      });
      output({ ...taskSummary(result.task), duplicate: result.duplicate });
      return 0;
    }
    if (command === 'worker' || command === 'recover') {
      if (command === 'worker' && !values.once)
        throw new TaskError('M2 仅支持 worker --once；常驻服务在 M5 实现');
      const timeout = Number(values.timeout ?? 120);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
        throw new TaskError('timeout 必须为 1–600 秒');
      if (command === 'recover' && positionals[1] && store.get(positionals[1]).owner_key !== key)
        throw new TaskError('任务归属不匹配');
      const worker = new TaskWorker(store, config);
      let taskId: string | undefined;
      let interrupted = false;
      const interrupt = () => {
        interrupted = true;
        worker.close();
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        await worker.start();
        if (command === 'worker') {
          const task = await worker.dispatchNext();
          taskId =
            task?.task_id ??
            store.list(key).find((task) => ['running', 'unknown'].includes(task.status))?.task_id;
          if (taskId) await worker.waitForTask(taskId, timeout * 1000);
        }
      } finally {
        worker.close();
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
      }
      const id = positionals[1] ?? taskId;
      output(id ? taskSummary(store.get(id)) : { ...store.diagnostics(), dispatched: false });
      if (interrupted) return 130;
      return store.list(key).some((task) => task.status === 'unknown')
        ? 2
        : id && store.get(id).status === 'failed'
          ? 1
          : 0;
    }
    if (command === 'state') {
      output(store.diagnostics());
      return 0;
    }
    throw new TaskError('未知任务命令');
  } finally {
    db.close();
  }
}
