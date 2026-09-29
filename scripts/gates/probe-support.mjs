import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRpcClient } from '../../src/codex/rpc-client.ts';
import baseline from '../../src/runtime-baseline.json' with { type: 'json' };

export { delay };
export class ProbeBlocked extends Error {}

export async function privateDirectory(prefix) {
  const path = await mkdtemp(`/private/tmp/${prefix}`);
  await chmod(path, 0o700);
  return path;
}

async function freePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function startServer({
  directory,
  homeMode,
  transport,
  codexHome,
  extraConfig = [],
  binary = process.env.CODEX_BINARY ?? baseline.codexBinary,
  environment = process.env,
}) {
  const home =
    codexHome ??
    (homeMode === 'isolated'
      ? join(directory, 'home')
      : (process.env.CODEX_HOME ?? join(homedir(), '.codex')));
  if (homeMode === 'isolated') await mkdir(home, { recursive: true, mode: 0o700 });
  const endpoint =
    transport === 'unix'
      ? `unix://${directory}/${randomUUID().slice(0, 8)}.sock`
      : `ws://127.0.0.1:${await freePort()}`;
  // Do not change global config or trigger the user's desktop notification command.
  const args = [
    'app-server',
    '--listen',
    endpoint,
    '-c',
    'notify=[]',
    ...extraConfig.flatMap((entry) => ['-c', entry]),
  ];
  const env = { ...environment, CODEX_HOME: home };
  if (homeMode === 'isolated') {
    for (const name of Object.keys(env)) {
      if (/TOKEN|API_KEY|SECRET|PASSWORD|CODEX_AUTH|CODEX_ACCESS/i.test(name)) delete env[name];
    }
  }
  const child = spawn(binary, args, {
    cwd: directory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  let exit;
  let spawnError;
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve();
    });
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const capture = (bytes) => {
    output = (output + bytes.toString('utf8')).slice(-32_768);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const terminateOwnedGroup = async () => {
    // Signal only the process group created by this probe; never pkill other Codex processes.
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await Promise.race([exited, delay(2_000)]);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await Promise.race([exited, delay(2_000)]);
      if (!exit && !spawnError) throw new Error('Owned app-server did not exit');
    }
    return {
      ownedProcessExited: Boolean(exit || spawnError),
      code: exit?.code,
      signal: exit?.signal,
    };
  };
  let stopping;
  const stop = () => (stopping ??= terminateOwnedGroup());
  const diagnostics = async (destination = join(directory, 'server-private.log')) => {
    await writeFile(destination, output, { mode: 0o600 });
  };
  return { endpoint, home, stop, diagnostics, exited: () => Boolean(exit || spawnError) };
}

export async function connectClient(server, handlers = {}) {
  const deadline = Date.now() + 30_000;
  for (let attempt = 0; attempt < 60; attempt++) {
    let connected = false;
    const client = new CodexRpcClient({
      endpoint: server.endpoint,
      timeoutMs: 10_000,
      ...handlers,
      onDisconnect: () => {
        if (connected) handlers.onDisconnect?.();
      },
    });
    try {
      await client.connect();
      connected = true;
      return client;
    } catch (error) {
      client.close();
      if (server.exited())
        throw new ProbeBlocked('app-server exited before handshake; inspect private server log');
      // Only retry connecting/initializing, never a business operation.
      if (attempt === 59 || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

/** Small bounded in-memory probe journal, deliberately excludes text deltas. */
export function journal() {
  const entries = [];
  let closed = false;
  return {
    entries,
    onNotification(event) {
      if (
        /^(error|turn\/(started|completed)|item\/(started|completed)|serverRequest\/resolved)$/.test(
          event.method,
        )
      ) {
        if (entries.length >= 2_000) throw new Error('Probe journal limit exceeded');
        entries.push(event);
      }
    },
    onDisconnect() {
      closed = true;
    },
    async wait(method, predicate, timeoutMs = 180_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const event = entries.find((entry) => entry.method === method && predicate(entry.params));
        if (event) return event.params;
        if (closed) throw new Error('Disconnected before expected event');
        await delay(25);
      }
      throw new ProbeBlocked(`Timed out waiting for ${method}`);
    },
  };
}

export function versionBaseline(expected = baseline.codex) {
  const binary = process.env.CODEX_BINARY ?? baseline.codexBinary;
  const codex = execFileSync(binary, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (codex !== `codex-cli ${expected}`)
    throw new ProbeBlocked('Codex version drift: regenerate/review protocol first');
  return {
    codex,
    binary,
    generatedProtocolVersion: baseline.codex,
    candidate: expected !== baseline.codex,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}

export async function cleanupDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
}
