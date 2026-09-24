import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { runtimePaths } from '../config/schema.js';
import { CodexRpcClient } from '../codex/rpc-client.js';
import { runGatewayCli } from '../cli/gateway.js';
import { inspectTaskDatabase } from '../cli/doctor.js';
import { TaskError } from '../tasks/types.js';
import { privateDirectory, servicePaths } from './files.js';
import { validateManifest, type ServiceManifest } from './plan.js';
import {
  ServiceLeases,
  readHealth,
  writeHealth,
  type ComponentHealth,
  type ServiceRole,
} from './state.js';
import { clearStaleSocket } from './socket.js';
import { RotatingLog } from './log.js';
import type { GatewayConfig } from '../config/schema.js';
import type { FeishuCredentials } from '../feishu/credentials.js';
import { maintain } from './maintenance.js';
import { ownedChildAlive, stopOwnedChild } from './child.js';

const isolationSchema = z.object({
  config: z.object({
    mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
    features: z.record(z.string(), z.unknown()),
  }),
});
export type ServiceRuntimeOptions = {
  validate?: () => Promise<GatewayConfig>;
  credentials?: FeishuCredentials;
  signal?: AbortSignal;
  desktop?: boolean;
  onChild?: (pid: number | null) => void;
};
export async function runService(
  manifest: ServiceManifest,
  role: ServiceRole,
  options: ServiceRuntimeOptions = {},
) {
  process.umask(0o077);
  const validate = options.validate ?? (() => validateManifest(manifest));
  const config = await validate();
  const leases = new ServiceLeases(config.dataDir);
  let token: string;
  try {
    token = leases.acquire(role);
  } catch (error) {
    leases.close();
    throw error;
  }
  const logger = new RotatingLog(
    join(servicePaths(config.dataDir).logs, `${role}.jsonl`),
    manifest.policy.logMaxBytes,
    manifest.policy.logFiles,
  );
  const state: ComponentHealth = {
    role,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'starting',
    ready: false,
    rpcReady: false,
    feishuConnected: false,
    error: null,
  };
  let stopped = false,
    child: ChildProcess | undefined,
    rpc: CodexRpcClient | undefined,
    attempts = 0;
  const socket = options.desktop
    ? config.codex.endpoint.slice('unix://'.length)
    : runtimePaths(config.dataDir).socket;
  let ownedSocket: { ino: number; dev: number } | undefined;
  let priorStatus = '';
  let lastSample = 0;
  const controller = new AbortController();
  let pendingMaintenance: Promise<void> | undefined;
  const publish = () => {
    state.updatedAt = Date.now();
    writeHealth(config.dataDir, state);
    const status = JSON.stringify([
      state.phase,
      state.ready,
      state.rpcReady,
      state.feishuConnected,
      state.error,
      state.notify,
    ]);
    if (status !== priorStatus) {
      logger.write('state', {
        phase: state.phase,
        ready: state.ready,
        rpcReady: state.rpcReady,
        feishuConnected: state.feishuConnected,
        error: state.error,
        notify: JSON.stringify(state.notify ?? { enabled: false }),
      });
      priorStatus = status;
    }
    if (state.updatedAt - lastSample >= 60_000) {
      const database = role === 'gateway' ? inspectTaskDatabase(config.dataDir) : undefined;
      logger.write('sample', {
        pid: state.pid,
        ready: state.ready,
        rpcReady: state.rpcReady,
        feishuConnected: state.feishuConnected,
        notify: JSON.stringify(state.notify ?? { enabled: false }),
        ...(database
          ? {
              database: database.status,
              tasks: JSON.stringify(database.statuses ?? []),
              outbox: JSON.stringify(database.outbox ?? []),
            }
          : {}),
      });
      lastSample = state.updatedAt;
    }
  };
  const stop = () => {
    stopped = true;
    state.ready = false;
    state.phase = 'stopping';
    controller.abort();
  };
  if (!options.desktop) {
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  publish();
  const heartbeat = setInterval(() => {
    try {
      publish();
    } catch {
      stop();
    }
  }, 5000);
  const wait = async (ms: number) => {
    const until = Date.now() + ms;
    while (!stopped && Date.now() < until) await delay(Math.min(500, until - Date.now()));
  };
  const stopChild = async () => {
    rpc?.close();
    rpc = undefined;
    const owned = child;
    if (owned) await stopOwnedChild(owned, options.desktop ?? false);
    child = undefined;
    leases.child(token, null);
    options.onChild?.(null);
    if (ownedSocket) {
      try {
        const current = lstatSync(socket);
        if (current.ino === ownedSocket.ino && current.dev === ownedSocket.dev)
          await clearStaleSocket(socket);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      ownedSocket = undefined;
    }
  };
  try {
    if (role === 'gateway') {
      let lastMaintenance = 0;
      while (!stopped) {
        try {
          await validate();
          // RPC remains gated while the independent server checks its effective isolation.
          const operation = runGatewayCli(config, {
            signal: controller.signal,
            ...(options.credentials ? { credentials: options.credentials } : {}),
            interruptOnStop: options.desktop ?? false,
            rpcAllowed: () => readHealth(config.dataDir, 'app-server').ready,
            observe: (value) => {
              Object.assign(state, value);
              state.phase = value.ready ? 'ready' : 'connecting';
              state.error = null;
              if (value.ready) attempts = 0;
            },
          });
          // Maintenance shares no worker state and uses SQLite's online backup API.
          const maintenance = setInterval(() => {
            if (stopped || pendingMaintenance || Date.now() - lastMaintenance < 3600_000) return;
            lastMaintenance = Date.now();
            pendingMaintenance = maintain(manifest)
              .then((result) =>
                logger.write('maintenance', { skipped: 'skipped' in result, ok: true }),
              )
              .catch(() => logger.write('maintenance', { ok: false }))
              .finally(() => {
                pendingMaintenance = undefined;
              });
          }, 30_000);
          try {
            await operation;
          } finally {
            clearInterval(maintenance);
          }
          if (!stopped) throw new TaskError('Gateway 意外退出');
        } catch {
          state.ready = false;
          state.rpcReady = false;
          state.feishuConnected = false;
          state.phase = 'retrying';
          state.error = 'gateway_unavailable';
          publish();
          await wait(Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6)));
        }
      }
    } else {
      // Codex may implicitly include its startup cwd in command sandbox writes.
      // Keep that cwd away from credentials, configuration, SQLite and logs.
      const sandboxCwd = join(servicePaths(config.dataDir).root, 'sandbox-cwd');
      privateDirectory(sandboxCwd);
      const overrides = [
        'notify=[]',
        'features.hooks=false',
        'features.plugins=false',
        'features.apps=false',
        'features.multi_agent=false',
        'features.shell_snapshot=false',
        'mcp_servers={}',
      ];
      while (!stopped) {
        state.phase = 'starting';
        state.ready = false;
        state.rpcReady = false;
        publish();
        try {
          await validate();
          await clearStaleSocket(socket);
          let exited = false;
          child = spawn(
            manifest.binary,
            [
              'app-server',
              '--listen',
              config.codex.endpoint,
              ...overrides.flatMap((value) => ['-c', value]),
            ],
            {
              cwd: sandboxCwd,
              env: {
                ...process.env,
                CODEX_HOME: manifest.codexHome,
                ...(options.desktop
                  ? {
                      PATH: `${dirname(manifest.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
                    }
                  : {}),
              },
              stdio: ['ignore', 'ignore', 'ignore'],
              detached: options.desktop ?? false,
            },
          );
          child.once('exit', () => {
            exited = true;
          });
          child.once('error', () => {
            exited = true;
          });
          if (child.pid) {
            leases.child(token, child.pid, options.desktop ?? false);
            options.onChild?.(child.pid);
          }
          const deadline = Date.now() + 30_000;
          while (!stopped && !exited && Date.now() < deadline) {
            rpc = new CodexRpcClient({ endpoint: config.codex.endpoint, timeoutMs: 2000 });
            try {
              await rpc.connect();
              break;
            } catch {
              rpc.close();
              rpc = undefined;
              await wait(250);
            }
          }
          if (!rpc?.isReady || stopped) throw new TaskError('App Server 未就绪');
          const stat = lstatSync(socket);
          ownedSocket = { ino: stat.ino, dev: stat.dev };
          chmodSync(socket, 0o600);
          const effective = await rpc.request(
            'config/read',
            { cwd: config.dataDir, includeLayers: false },
            isolationSchema,
          );
          const active = Object.entries(effective.config.mcp_servers)
            .filter(([, value]) => value.enabled !== false)
            .map(([name]) => name);
          if (active.length) {
            if (
              active.some(
                (name) =>
                  !/^[a-zA-Z0-9_-]+$/.test(name) ||
                  overrides.includes(`mcp_servers.${name}.enabled=false`),
              )
            )
              throw new TaskError('无法隔离 MCP 配置');
            overrides.push(...active.map((name) => `mcp_servers.${name}.enabled=false`));
            await stopChild();
            continue;
          }
          for (const feature of ['hooks', 'plugins', 'apps', 'multi_agent'])
            if (effective.config.features[feature] !== false) throw new TaskError('外部集成未隔离');
          attempts = 0;
          state.phase = 'ready';
          state.error = null;
          state.ready = true;
          state.rpcReady = true;
          publish();
          while (!stopped && !exited && rpc.isReady) {
            await wait(5000);
            if (!stopped)
              await rpc.request(
                'thread/loaded/list',
                {},
                z.object({ data: z.array(z.string()) }),
                5000,
              );
          }
          if (!stopped) throw new TaskError('App Server 已断开');
        } catch {
          state.phase = 'retrying';
          state.error = 'app_server_unavailable';
        } finally {
          state.ready = false;
          state.rpcReady = false;
          publish();
          await stopChild();
        }
        await wait(Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6)));
      }
    }
  } finally {
    clearInterval(heartbeat);
    await pendingMaintenance;
    try {
      await stopChild();
    } finally {
      state.phase = 'stopped';
      state.ready = false;
      state.rpcReady = false;
      state.feishuConnected = false;
      try {
        publish();
      } finally {
        // A surviving owned child must continue blocking another supervisor.
        if (!child || !ownedChildAlive(child, options.desktop ?? false)) leases.release(token);
        leases.close();
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        options.signal?.removeEventListener('abort', stop);
      }
    }
  }
  return 0;
}
