import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { CodexRpcClient } from '../codex/rpc-client.js';
import { stopOwnedChild } from '../service/child.js';
import { TaskError } from '../tasks/types.js';
import { resolveCodexBinary } from '../codex/binary.js';
import { inspectProjectless, type ProjectlessCapability } from './capability.js';
import {
  disabledFeatures,
  projectlessCandidateConfig,
  projectlessProbeEnvironment,
} from './policy.js';

export const ordinaryConfigSchema = z.object({
  config: z.object({
    features: z.record(z.string(), z.unknown()),
    agents: z.object({ enabled: z.boolean() }),
    web_search: z.string(),
    notify: z.array(z.unknown()).optional(),
    project_doc_max_bytes: z.number().optional(),
    mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
  }),
});
const skillsSchema = z.object({
  data: z.array(
    z.object({ skills: z.array(z.object({ path: z.string(), enabled: z.boolean() })) }),
  ),
});
export async function assertOrdinaryConfig(rpc: CodexRpcClient, cwd: string) {
  const { config } = await rpc.request(
    'config/read',
    { cwd, includeLayers: false },
    ordinaryConfigSchema,
  );
  if (
    disabledFeatures.some((key) => config.features[key] !== false) ||
    config.agents.enabled ||
    config.web_search !== 'disabled' ||
    Object.values(config.mcp_servers).some((value) => value.enabled !== false) ||
    (config.notify?.length ?? 0) !== 0 ||
    config.project_doc_max_bytes !== 0
  )
    throw new TaskError('普通聊天限制未生效，已停止无项目执行');
  const skills = await rpc.request('skills/list', { cwds: [cwd], forceReload: true }, skillsSchema);
  if (skills.data.some((entry) => entry.skills.some((skill) => skill.enabled)))
    throw new TaskError('普通聊天存在未隔离的技能');
}
/** Separate process-wide policy. Never borrows the project server or changes global settings. */
export class OrdinaryChatServer {
  private child: ChildProcess | undefined;
  private rpc: CodexRpcClient | undefined;
  private directory: string | undefined;
  private nextAttempt = 0;
  private stopping = false;
  endpoint: string | undefined;
  capability: ProjectlessCapability | undefined;
  error: string | null = null;
  constructor(
    private readonly binary: string,
    private readonly enabled: boolean,
    private readonly onChild?: (child: ChildProcess | undefined) => void,
  ) {}
  get ready() {
    return (
      !this.stopping &&
      !!this.rpc?.isReady &&
      !!this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }
  async ensure() {
    if (!this.enabled || this.stopping || this.ready || Date.now() < this.nextAttempt) return;
    this.nextAttempt = Date.now() + 30_000;
    try {
      await this.stopProcess();
      this.capability = await inspectProjectless(this.binary);
      if (!this.capability.ok) throw new TaskError(this.capability.message);
      this.directory ??= await mkdtemp(join(tmpdir(), 'cc-chat-'));
      await chmod(this.directory, 0o700);
      this.endpoint = `unix://${join(this.directory, 'rpc.sock')}`;
      if (Buffer.byteLength(this.endpoint.slice(7)) > 100)
        throw new TaskError('普通聊天 socket 路径过长');
      const overrides = Object.entries(projectlessCandidateConfig).map(
        ([key, value]) => `${key}=${JSON.stringify(value)}`,
      );
      await this.launch(overrides);
      const discovered = await this.rpc!.request(
        'config/read',
        { cwd: this.directory, includeLayers: false },
        ordinaryConfigSchema,
      );
      const names = Object.keys(discovered.config.mcp_servers);
      if (names.some((name) => !/^[A-Za-z0-9_-]+$/.test(name)))
        throw new TaskError('普通聊天无法隔离 MCP 配置');
      overrides.push(...names.map((name) => `mcp_servers.${name}.enabled=false`));
      const skills = await this.rpc!.request(
        'skills/list',
        { cwds: [this.directory], forceReload: true },
        skillsSchema,
      );
      const paths = [
        ...new Set(skills.data.flatMap((entry) => entry.skills.map((skill) => skill.path))),
      ];
      overrides.push(
        `skills.config=[${paths.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(',')}]`,
      );
      await this.stopProcess();
      await this.launch(overrides);
      await assertOrdinaryConfig(this.rpc!, this.directory);
      this.error = null;
    } catch (error) {
      this.error = error instanceof TaskError ? error.message : '普通聊天后端未就绪';
      await this.stopProcess();
    }
  }
  private async launch(overrides: string[]) {
    if (this.stopping) throw new TaskError('普通聊天后端正在停止');
    await rm(join(this.directory!, 'rpc.sock'), { force: true });
    this.child = spawn(
      resolveCodexBinary(this.binary),
      ['app-server', '--listen', this.endpoint!, ...overrides.flatMap((value) => ['-c', value])],
      {
        cwd: this.directory!,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...projectlessProbeEnvironment(),
          CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        },
      },
    );
    this.onChild?.(this.child);
    let failed = false;
    this.child.once('error', () => {
      failed = true;
    });
    const deadline = Date.now() + 15_000;
    while (!this.stopping && !failed && this.child.exitCode === null && Date.now() < deadline) {
      const rpc = new CodexRpcClient({ endpoint: this.endpoint!, timeoutMs: 2000 });
      try {
        await rpc.connect();
        this.rpc = rpc;
        await chmod(join(this.directory!, 'rpc.sock'), 0o600);
        return;
      } catch {
        rpc.close();
        await delay(200);
      }
    }
    throw new TaskError('普通聊天后端连接失败');
  }
  private async stopProcess() {
    this.rpc?.close();
    this.rpc = undefined;
    if (this.child) {
      await stopOwnedChild(this.child, true);
      this.child = undefined;
      this.onChild?.(undefined);
    }
  }
  async stop() {
    this.stopping = true;
    await this.stopProcess();
    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
    }
  }
}
