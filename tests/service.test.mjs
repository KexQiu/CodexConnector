import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openGatewayDatabase, openReadonlyDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskWorker } from '../src/tasks/worker.ts';
import { RpcTransportError } from '../src/codex/rpc-client.ts';
import { FeishuRuntime } from '../src/feishu/runtime.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { servicePolicySchema } from '../src/config/schema.ts';
import { servicePaths, readPrivate, writeJson, writePrivate } from '../src/service/files.ts';
import { ServiceLeases, readHealth, writeHealth } from '../src/service/state.ts';
import { clearStaleSocket } from '../src/service/socket.ts';
import { RotatingLog } from '../src/service/log.ts';
import { buildHash, renderPlist } from '../src/service/plan.ts';
import {
  maintain,
  redactSettledContent,
  restoreCopy,
  verifyDatabase,
} from '../src/service/maintenance.ts';

describe('M5 private service ownership and durable maintenance', () => {
  let dir, db, store, leases;
  const owner = { tenantKey: 'tenant', appId: 'cli_fixture', openId: 'ou_fixture' };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-m5-'));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    leases = new ServiceLeases(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (db.open) db.close();
    leases.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const submit = (requestKey = 'one') =>
    store.submit({ owner, requestKey, projectKey: 'p', cwd: dir, prompt: 'private prompt' });
  function settled() {
    const task = submit().task;
    store.claim(task.task_id, 'e');
    store.bindThread(task.task_id, 'thread', dir, 'e');
    store.bindTurn(task.task_id, {
      id: 'turn',
      status: 'completed',
      items: [{ type: 'agentMessage', id: 'item', text: 'private result' }],
    });
    db.exec(
      "UPDATE rpc_operations SET state='known'; UPDATE outbox SET state='delivered'; UPDATE tasks SET updated_at=1",
    );
    return task;
  }
  it('blocks a second supervisor and preserves a surviving child after its owner died', () => {
    const token = leases.acquire('app-server');
    expect(() => leases.acquire('app-server')).toThrow(/拒绝抢占/);
    leases.release('foreign-token');
    expect(leases.active()).toHaveLength(1);
    leases.child(token, process.pid);
    leases.db.prepare('UPDATE leases SET pid=?').run(2147483647);
    expect(() => leases.acquire('app-server')).toThrow(/拒绝抢占/);
    leases.child(token, null);
    expect(leases.acquire('app-server')).not.toBe(token);
  });
  it('does not repurpose a foreign SQLite database as a lease store', () => {
    leases.db.pragma('application_id=123');
    expect(() => new ServiceLeases(dir)).toThrow(/不是服务/);
  });
  it('distinguishes process health, RPC readiness and Feishu connection; expires stale heartbeats', () => {
    const health = {
      role: 'gateway',
      token: 't',
      pid: process.pid,
      updatedAt: 1000,
      startedAt: 1,
      phase: 'connecting',
      ready: false,
      rpcReady: true,
      feishuConnected: false,
      error: null,
    };
    writeHealth(dir, health);
    expect(readHealth(dir, 'gateway', 1000)).toMatchObject({
      healthy: true,
      ready: false,
      rpcReady: true,
      feishuConnected: false,
    });
    expect(readHealth(dir, 'gateway', 22000)).toMatchObject({ healthy: false, rpcReady: false });
    writeHealth(dir, { ...health, pid: 2147483647, ready: true });
    expect(readHealth(dir, 'gateway', 1000).ready).toBe(false);
    writeHealth(dir, { ...health, phase: 'stopped', ready: true });
    expect(readHealth(dir, 'gateway', 1000).ready).toBe(false);
  });
  it('rejects permissive files and symlinks without modifying their target', () => {
    const file = join(dir, 'private.json'),
      link = join(dir, 'link');
    writePrivate(file, 'original');
    symlinkSync(file, link);
    expect(() => writePrivate(link, 'changed')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('original');
    chmodSync(file, 0o644);
    expect(() => readPrivate(file)).toThrow(/私有普通文件/);
    expect(() => writePrivate(file, 'changed')).toThrow();
  });
  it('never unlinks regular files, symlinks or a listening socket', async () => {
    const socket = join(dir, 'live.sock'),
      file = join(dir, 'file'),
      link = join(dir, 'link');
    writePrivate(file, 'keep');
    symlinkSync(file, link);
    await expect(clearStaleSocket(file)).rejects.toThrow(/拒绝删除/);
    await expect(clearStaleSocket(link)).rejects.toThrow(/拒绝删除/);
    const server = createServer((connection) => connection.end());
    server.listen(socket);
    await once(server, 'listening');
    try {
      await expect(clearStaleSocket(socket)).rejects.toThrow(/仍在监听/);
      expect(lstatSync(socket).isSocket()).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('cleans only the stale socket of an exited isolated fixture', async () => {
    const socket = join(dir, 'stale.sock');
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('net').createServer().listen(process.argv[1],()=>process.stdout.write('READY\\n'))",
        socket,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    try {
      await once(child.stdout, 'data');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      expect(lstatSync(socket).isSocket()).toBe(true);
      await clearStaleSocket(socket);
      expect(existsSync(socket)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  it('rotates bounded private logs and keeps valid JSON records', () => {
    const file = join(dir, 'logs', 'gateway.jsonl'),
      log = new RotatingLog(file, 180, 2);
    for (let i = 0; i < 20; i++) log.write('health', { sequence: i });
    const files = readdirSync(join(dir, 'logs'));
    expect(files.sort()).toEqual(['gateway.jsonl', 'gateway.jsonl.1', 'gateway.jsonl.2']);
    for (const name of files) {
      const path = join(dir, 'logs', name);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(path).size).toBeLessThanOrEqual(180);
      for (const line of readFileSync(path, 'utf8').trim().split('\n'))
        expect(JSON.parse(line).event).toBe('health');
    }
  });
  it('produces plist arrays with escaped paths and decimal 077 without embedding secrets', () => {
    const manifest = {
      node: '/node path/node',
      entry: '/code & test/index.js',
      configPath: '/config.json',
      dataDir: '/data',
      codexHome: '/home/.codex',
    };
    const content = renderPlist(manifest, 'gateway');
    const path = join(dir, 'gateway.plist');
    writePrivate(path, content);
    execFileSync('/usr/bin/plutil', ['-lint', path]);
    const parsed = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }),
    );
    expect(parsed.Umask).toBe(63);
    expect(parsed.ProgramArguments).toEqual([
      '/node path/node',
      '/code & test/index.js',
      'service-run',
      'gateway',
      '--config',
      '/config.json',
    ]);
    expect(parsed.KeepAlive).toBe(true);
    expect(content).not.toMatch(/appSecret|testChatId/);
  });
  it('detects build changes including migration scripts', () => {
    const entry = join(dir, 'index.js');
    writePrivate(entry, 'export {};');
    const before = buildHash(entry);
    writePrivate(join(dir, 'migration.sql'), 'SELECT 1;');
    expect(buildHash(entry)).not.toBe(before);
  });
  it('redacts settled old content but preserves deduplication and task identity', () => {
    const task = settled();
    expect(redactSettledContent(db, 2)).toBe(1);
    expect(store.get(task.task_id).prompt).toBe('');
    expect(store.result(task.task_id)).toBe('[内容已过保留期]');
    expect(db.prepare('SELECT payload FROM inbox').pluck().all()).toEqual(['{}']);
    expect(submit()).toMatchObject({ duplicate: true, task: { task_id: task.task_id } });
    expect(() =>
      store.submit({ owner, requestKey: 'one', projectKey: 'p', cwd: dir, prompt: 'different' }),
    ).toThrow(/request-key/);
  });
  it('redacts expired old draft text while retaining identities and unexpired drafts', () => {
    const insert = db.prepare(
      "INSERT INTO feishu_drafts VALUES (?, 'owner','chat','saved prompt','pending',NULL,1,?)",
    );
    insert.run('expired', 1);
    insert.run('active', Date.now() + 60000);
    redactSettledContent(db, 2);
    expect(
      db.prepare("SELECT prompt FROM feishu_drafts WHERE draft_id='expired'").pluck().get(),
    ).toBe('');
    expect(
      db.prepare("SELECT prompt FROM feishu_drafts WHERE draft_id='active'").pluck().get(),
    ).toBe('saved prompt');
    expect(db.prepare('SELECT count(*) FROM feishu_drafts').pluck().get()).toBe(2);
  });
  it('retains a topic prompt while an early follow-up is waiting for its thread', () => {
    const task = settled();
    const inboxId = db.prepare('SELECT inbox_id FROM inbox LIMIT 1').pluck().get();
    db.prepare(
      "INSERT INTO feishu_commands (command_id,business_key,inbox_id,owner_key,chat_id,payload,state,created_at,target_task_id) VALUES ('deferred','deferred',?,'owner','chat','{}','received',1,?)",
    ).run(inboxId, task.task_id);
    expect(redactSettledContent(db, 2)).toBe(0);
    expect(store.get(task.task_id).prompt).toBe('private prompt');
    db.prepare("UPDATE feishu_commands SET state='processed'").run();
    expect(redactSettledContent(db, 2)).toBe(1);
  });
  it.each(['outbox', 'rpc', 'approval', 'control', 'lock', 'fallback'])(
    'retains all old content while %s remains uncertain',
    (kind) => {
      const task = settled();
      if (kind === 'outbox') db.exec("UPDATE outbox SET state='unknown'");
      if (kind === 'rpc') db.exec("UPDATE rpc_operations SET state='unknown'");
      if (kind === 'approval')
        db.prepare(
          "INSERT INTO approvals (approval_id,task_id,thread_id,turn_id,connection_epoch,rpc_id_json,method,state,expires_at,created_at,response_state) VALUES ('a',?,'thread','turn','e','1','fixture','expired',1,1,'unknown')",
        ).run(task.task_id);
      if (kind === 'control')
        db.prepare(
          "INSERT INTO task_controls VALUES ('c',?,'o','steer','turn','private control','unknown',NULL,1)",
        ).run(task.task_id);
      if (kind === 'lock')
        db.prepare("INSERT INTO execution_locks VALUES ('orphan',?,1)").run(task.task_id);
      if (kind === 'fallback')
        db.prepare(
          "INSERT INTO outbox (outbox_id,logical_key,task_id,card_version,payload,state,created_at) VALUES ('fallback','fallback',NULL,1,?,'unknown',1)",
        ).run(JSON.stringify({ sourceTaskId: task.task_id, text: 'private result' }));
      expect(redactSettledContent(db, 2)).toBe(0);
      expect(store.get(task.task_id).prompt).toBe('private prompt');
    },
  );
  it('backs up live WAL data, rotates only verified backups and restores to a new private copy', async () => {
    const task = submit().task;
    const manifest = { dataDir: dir, policy: servicePolicySchema.parse({ backupsToKeep: 2 }) };
    const first = await maintain(manifest, true);
    expect(verifyDatabase(first.backup).tasks).toBe(1);
    expect(await maintain(manifest)).toEqual({ skipped: true });
    await maintain(manifest, true);
    const last = await maintain(manifest, true);
    expect(
      readdirSync(servicePaths(dir).backups).filter((name) => name.endsWith('.sqlite')),
    ).toHaveLength(2);
    expect(existsSync(first.backup)).toBe(false);
    const destination = join(dir, 'restored.sqlite');
    expect(await restoreCopy(last.backup, destination)).toMatchObject({
      integrity: 'ok',
      tasks: 1,
      requiresReconciliationBeforeUse: true,
    });
    const restored = openReadonlyDatabase(destination);
    try {
      expect(restored.prepare('SELECT task_id FROM tasks').pluck().get()).toBe(task.task_id);
    } finally {
      restored.close();
    }
    await expect(restoreCopy(last.backup, destination)).rejects.toThrow();
    expect(leases.active()).toHaveLength(0);
  });
  it('refuses incompatible restore sources and concurrent maintenance', async () => {
    leases.acquire('maintenance');
    await expect(maintain({ dataDir: dir }, true)).rejects.toThrow(/拒绝抢占/);
    db.pragma('user_version=999');
    expect(() => verifyDatabase(join(dir, 'gateway.sqlite'))).toThrow(/不兼容/);
    await expect(restoreCopy(join(dir, 'gateway.sqlite'), join(dir, 'new.sqlite'))).rejects.toThrow(
      /不兼容/,
    );
    expect(existsSync(join(dir, 'new.sqlite'))).toBe(false);
  });
  it('does not dispatch while isolation health is unavailable and uses increasing reconnect delays', async () => {
    let allowed = false,
      now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const start = vi
      .spyOn(TaskWorker.prototype, 'start')
      .mockRejectedValue(new RpcTransportError('fixture', 'not-sent'));
    const dispatch = vi.spyOn(TaskWorker.prototype, 'dispatchNext');
    const config = {
      schemaVersion: 1,
      dataDir: dir,
      maxConcurrentTasks: 1,
      codex: { endpoint: 'ws://127.0.0.1:9999' },
      feishu: { appId: owner.appId, allowedOpenId: owner.openId, tenantKey: owner.tenantKey },
      projects: [],
    };
    const runtime = new FeishuRuntime(
      store,
      config,
      { ...config.feishu, appSecret: 'fixture', testChatId: 'oc_fixture' },
      { rpcAllowed: () => allowed },
    );
    try {
      runtime.connected = true;
      await runtime.tick();
      expect(start).not.toHaveBeenCalled();
      expect(runtime.status()).toMatchObject({
        rpcReady: false,
        feishuConnected: true,
        ready: false,
      });
      allowed = true;
      await runtime.tick();
      expect(start).toHaveBeenCalledTimes(1);
      now += 500;
      await runtime.tick();
      expect(start).toHaveBeenCalledTimes(1);
      now += 500;
      await runtime.tick();
      expect(start).toHaveBeenCalledTimes(2);
      now += 1500;
      await runtime.tick();
      expect(start).toHaveBeenCalledTimes(2);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      runtime.close();
    }
  });
  it('does not trust malformed maintenance state as a reason to skip a backup', async () => {
    writeJson(join(servicePaths(dir).root, 'maintenance.json'), { completedAt: 'invalid' });
    await expect(
      maintain({ dataDir: dir, policy: servicePolicySchema.parse({}) }),
    ).rejects.toThrow();
    expect(leases.active()).toHaveLength(0);
  });
  it('retains uncertain taskless replies, then redacts settled content without accepting a duplicate', async () => {
    const credentials = {
      ...owner,
      allowedOpenId: owner.openId,
      appSecret: 'fixture',
      testChatId: 'oc_fixture',
    };
    const inbox = new FeishuInbox(store, credentials);
    const commands = new FeishuCommands(inbox, { projects: [] }, {});
    const event = {
      event_id: 'event',
      app_id: owner.appId,
      tenant_key: owner.tenantKey,
      sender: { sender_type: 'user', sender_id: { open_id: owner.openId } },
      message: {
        message_id: 'om_fixture',
        chat_id: credentials.testChatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'private unselected prompt' }),
      },
    };
    inbox.receive('message', event);
    await commands.processNext();
    db.exec("UPDATE outbox SET state='unknown'; UPDATE feishu_commands SET created_at=1");
    redactSettledContent(db, 2);
    expect(db.prepare('SELECT payload FROM inbox').pluck().get()).toContain(
      'private unselected prompt',
    );
    db.exec("UPDATE outbox SET state='delivered',created_at=1");
    redactSettledContent(db, 2);
    expect(db.prepare('SELECT payload FROM inbox').pluck().get()).toBe('{}');
    expect(JSON.parse(db.prepare('SELECT payload FROM feishu_commands').pluck().get()).text).toBe(
      '',
    );
    expect(inbox.receive('message', event).outcome).toBe('duplicate');
    expect(await commands.processNext()).toBe(false);
    expect(db.prepare('SELECT count(*) FROM outbox').pluck().get()).toBe(1);
  });
});
