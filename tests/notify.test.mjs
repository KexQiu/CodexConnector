import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { NotifyInbox } from '../src/notify/inbox.ts';
import { NotifyReceiver } from '../src/notify/receiver.ts';
import { eventIdentity } from '../src/notify/event.ts';
import { FeishuSender } from '../src/feishu/sender.ts';
import { FeishuApiError } from '../src/feishu/api.ts';
import {
  prepareNotify,
  installNotify,
  restoreNotify,
  stageForward,
  notifySetting,
} from '../scripts/gates/notify.mjs';

const owner = { appId: 'cli_fixture', tenantKey: 'tenant_fixture', openId: 'ou_fixture' };
const credentials = { ...owner, allowedOpenId: owner.openId, testChatId: 'oc_fixture' };
const event = (cwd, extra = {}) => ({
  type: 'agent-turn-complete',
  'thread-id': 'thread_gui',
  'turn-id': 'turn_gui',
  cwd,
  'last-assistant-message': 'M6_FIXTURE_OK',
  ...extra,
});
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
describe('M6 durable GUI notification extension (simulated GUI/Feishu)', () => {
  let dir, project, db, store, config, inbox, receiver, token;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-m6-')));
    project = join(dir, 'project');
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(join(dir, 'spool'), { mode: 0o700 });
    token = randomBytes(32).toString('hex');
    writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    config = {
      projects: [{ key: 'p', name: 'fixture', root: project, remoteWrite: false }],
      notify: {
        port: 9999,
        tokenFile: join(dir, 'token'),
        spoolDir: join(dir, 'spool'),
        projectKeys: ['p'],
        verifiedEvents: ['agent-turn-complete'],
      },
    };
    inbox = new NotifyInbox(store, config, credentials);
  });
  afterEach(() => {
    receiver?.close();
    receiver = undefined;
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const count = (db, table) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  async function start() {
    config.notify.port = await freePort();
    receiver = new NotifyReceiver(config.notify, inbox);
    await receiver.start();
    return `http://127.0.0.1:${config.notify.port}/notify`;
  }
  function post(url, data = event(project), headers = {}) {
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
  }
  function settings(mode = 'forward', extra = {}) {
    const path = join(dir, 'bridge.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        mode,
        allowedRoots: [project],
        ...config.notify,
        captureDir: join(dir, 'captures'),
        captureUntil: Date.now() + 60_000,
        captureMarker: 'M6_FIXTURE_OK',
        ...extra,
      }),
      { mode: 0o600 },
    );
    return path;
  }
  function wrapper(setting, original = [], args = [JSON.stringify(event(project))], stdin) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [resolveBridge, setting, JSON.stringify(original), ...args],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const chunks = [];
      child.stderr.on('data', (chunk) => chunks.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr: Buffer.concat(chunks).toString() }));
      if (stdin !== undefined) child.stdin.end(stdin);
      // When unspecified the pipe deliberately stays open; wrapper must not await EOF.
    });
  }
  const resolveBridge = resolve('scripts/notify-bridge.mjs');
  function originalHelper(code = 0) {
    const path = join(dir, 'original.mjs'),
      output = join(dir, 'original.json');
    writeFileSync(
      path,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))); process.exitCode=${code};`,
      { mode: 0o600 },
    );
    return { command: [process.execPath, path, 'turn-ended', 'with space'], output };
  }

  it('commits one inbox/outbox by business identity even if duplicate body changes', () => {
    expect(inbox.receive(event(project)).outcome).toBe('queued');
    expect(inbox.receive(event(project, { 'last-assistant-message': 'changed' })).outcome).toBe(
      'duplicate',
    );
    expect(count(db, 'inbox')).toBe(1);
    expect(count(db, 'outbox')).toBe(1);
    for (const table of ['tasks', 'rpc_operations', 'threads', 'execution_locks', 'feishu_actions'])
      expect(count(db, table)).toBe(0);
    expect(db.prepare('SELECT payload FROM outbox').pluck().get()).toContain('M6_FIXTURE_OK');
  });
  it('allows separate turns of the same thread', () => {
    inbox.receive(event(project));
    inbox.receive(event(project, { 'turn-id': 'second' }));
    expect(count(db, 'outbox')).toBe(2);
  });
  it('suppresses Gateway-owned threads before a turn is bound, without touching task state', () => {
    const { task } = store.submit({
      owner,
      requestKey: 'test',
      projectKey: 'p',
      cwd: project,
      prompt: 'fixture',
    });
    store.claim(task.task_id, 'epoch');
    store.bindThread(task.task_id, 'thread_gui', project, 'epoch');
    const before = store.get(task.task_id);
    expect(inbox.receive(event(project)).outcome).toBe('suppressed-rpc-owned');
    expect(store.get(task.task_id)).toEqual(before);
    expect(
      db.prepare("SELECT count(*) FROM outbox WHERE logical_key LIKE 'gui-notify:%'").pluck().get(),
    ).toBe(0);
  });
  it('rejects non-allowlisted/nested roots and symlinks escaping the project', () => {
    const nested = join(project, 'nested');
    mkdirSync(nested);
    const link = join(project, 'escape');
    symlinkSync(dir, link);
    for (const cwd of [dir, nested, link]) expect(inbox.receive(event(cwd)).outcome).toBe('denied');
    expect(count(db, 'inbox')).toBe(0);
  });
  it('rejects missing IDs and unverified failure/interrupt types', () => {
    for (const extra of [
      { 'turn-id': undefined },
      { 'thread-id': '' },
      { type: 'agent-turn-failed' },
      { type: 'agent-turn-interrupted' },
    ])
      expect(() => inbox.receive(event(project, extra))).toThrow();
    config.notify.verifiedEvents = [];
    expect(inbox.receive(event(project)).outcome).toBe('disabled');
  });
  it('rolls back the inbox if outbox persistence fails; retry then succeeds once', () => {
    db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() => inbox.receive(event(project))).toThrow();
    expect(count(db, 'inbox')).toBe(0);
    db.exec('DROP TRIGGER fail_outbox');
    expect(inbox.receive(event(project)).outcome).toBe('queued');
  });
  it('stores no input-messages, tokens or raw argv in business database', () => {
    inbox.receive(event(project, { 'input-messages': ['PRIVATE_INPUT'], token: 'PRIVATE_TOKEN' }));
    for (const table of ['inbox', 'outbox']) {
      const row = db.prepare(`SELECT payload FROM ${table}`).pluck().get();
      expect(row).not.toContain('PRIVATE_');
      expect(row).not.toContain('input-messages');
    }
  });
  it('listens on loopback and rejects bad tokens, browser origins, bad JSON/type and oversized bodies', async () => {
    const url = await start();
    expect((await post(url, event(project), { authorization: 'Bearer bad' })).status).toBe(403);
    expect((await post(url, event(project), { origin: 'http://localhost' })).status).toBe(403);
    expect((await post(url, event(project), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(url, { arbitrary: true })).status).toBe(400);
    expect(
      (await post(url, event(project, { 'last-assistant-message': 'x'.repeat(256 * 1024) })))
        .status,
    ).toBe(413);
    expect(count(db, 'inbox')).toBe(0);
    const accepted = await post(url);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).identity).toBe(eventIdentity(event(project)));
    expect(count(db, 'outbox')).toBe(1);
  });
  it('returns a non-ACK on persistence failure', async () => {
    const url = await start();
    db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect((await post(url)).status).toBe(503);
    expect(count(db, 'inbox')).toBe(0);
  });
  it('preserves original argument boundaries, exit status and inherited stdin', async () => {
    const path = join(dir, 'stdin.mjs'),
      output = join(dir, 'stdin.json');
    writeFileSync(
      path,
      `import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),stdin:readFileSync(0,'utf8')})); process.exitCode=7;`,
    );
    const args = [JSON.stringify(event(project)), 'two words', '$(do not execute)'];
    const result = await wrapper(
      settings(),
      [process.execPath, path, 'fixed arg'],
      args,
      'stdin verbatim',
    );
    expect(result.code).toBe(7);
    expect(JSON.parse(readFileSync(output))).toEqual({
      args: ['fixed arg', ...args],
      stdin: 'stdin verbatim',
    });
  });
  it('original notifier works with corrupt bridge settings and a never-closed stdin', async () => {
    const original = originalHelper();
    const path = settings();
    writeFileSync(path, 'invalid json');
    expect((await wrapper(path, original.command)).code).toBe(0);
    expect(JSON.parse(readFileSync(original.output))).toEqual([
      'turn-ended',
      'with space',
      JSON.stringify(event(project)),
    ]);
  });
  it('spools while offline, strips user prompts, and replays once after restart', async () => {
    config.notify.port = await freePort();
    const original = originalHelper();
    const raw = event(project, { 'input-messages': ['DO_NOT_RETAIN'] });
    expect((await wrapper(settings(), original.command, [JSON.stringify(raw)])).code).toBe(0);
    const name = `${eventIdentity(raw)}.json`;
    const path = join(config.notify.spoolDir, name);
    expect(readFileSync(path, 'utf8')).not.toContain('DO_NOT_RETAIN');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    receiver = new NotifyReceiver(config.notify, inbox);
    receiver.drain();
    expect(readdirSync(config.notify.spoolDir)).toEqual([]);
    expect(count(db, 'outbox')).toBe(1);
    // Simulate loss of the HTTP ACK/local unlink and a sender replay after DB reopening.
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    receiver = new NotifyReceiver(config.notify, new NotifyInbox(store, config, credentials));
    receiver.drain();
    expect(count(db, 'outbox')).toBe(1);
    expect(readdirSync(config.notify.spoolDir)).toEqual([]);
  });
  it('removes a spool file only after receiving the committed identity ACK', async () => {
    await start();
    expect((await wrapper(settings())).code).toBe(0);
    expect(readdirSync(config.notify.spoolDir)).toEqual([]);
    expect(count(db, 'outbox')).toBe(1);
  });
  it('still forwards to Gateway when the original notifier exits with error', async () => {
    await start();
    const original = originalHelper(9);
    expect((await wrapper(settings(), original.command)).code).toBe(9);
    expect(count(db, 'outbox')).toBe(1);
  });
  it('still persists notification when the original executable is missing', async () => {
    await start();
    expect((await wrapper(settings(), [join(dir, 'missing-executable')])).code).toBe(127);
    expect(count(db, 'outbox')).toBe(1);
  });
  it('bounded capture records argv and stdin strategy, expires, and sends nothing', async () => {
    const setting = settings('capture');
    const original = originalHelper();
    await wrapper(setting, original.command);
    const file = readdirSync(join(dir, 'captures'))[0];
    const captured = JSON.parse(readFileSync(join(dir, 'captures', file)));
    expect(captured.argv).toEqual([JSON.stringify(event(project))]);
    expect(captured.stdin.strategy).toBe('inherited-without-reading');
    expect(count(db, 'outbox')).toBe(0);
    await wrapper(settings('capture', { captureUntil: 0 }), original.command);
    expect(readdirSync(join(dir, 'captures'))).toHaveLength(1);
  });
  it('captures rich-text escaped test markers without rewriting original argv', async () => {
    const original = originalHelper();
    const raw = event(project, {
      'last-assistant-message': 'M6\\_FIXTURE\\_OK',
      'input-messages': ['只回复 M6\\_FIXTURE\\_OK。'],
    });
    const args = [JSON.stringify(raw)];
    expect((await wrapper(settings('capture'), original.command, args)).code).toBe(0);
    const files = readdirSync(join(dir, 'captures'));
    expect(files).toHaveLength(1);
    const capture = JSON.parse(readFileSync(join(dir, 'captures', files[0])));
    expect(capture.argv).toEqual(args);
    expect(capture.originalExitCode).toBe(0);
    expect(JSON.parse(readFileSync(original.output))).toEqual([
      'turn-ended',
      'with space',
      ...args,
    ]);
  });
  it('normalizes only test-marker comparison and retains escaped notification content', async () => {
    await start();
    const setting = settings('forward', { testMarker: 'M6_FIXTURE_OK' });
    await wrapper(
      setting,
      [],
      [JSON.stringify(event(project, { 'last-assistant-message': 'OTHER_MARKER' }))],
    );
    expect(count(db, 'outbox')).toBe(0);
    await wrapper(
      setting,
      [],
      [JSON.stringify(event(project, { 'last-assistant-message': 'M6\\_FIXTURE\\_OK' }))],
    );
    expect(count(db, 'outbox')).toBe(1);
    expect(JSON.parse(db.prepare('SELECT payload FROM outbox').pluck().get()).text).toContain(
      'M6\\_FIXTURE\\_OK',
    );
  });
  it('retains spool on database failure and reports an extension error', () => {
    const raw = event(project),
      path = join(config.notify.spoolDir, `${eventIdentity(raw)}.json`);
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    receiver = new NotifyReceiver(config.notify, inbox);
    receiver.drain();
    expect(readFileSync(path, 'utf8')).toContain('M6_FIXTURE_OK');
    expect(receiver.status().errorCode).toBe('notify-spool-drain-failed');
    db.exec('DROP TRIGGER fail_outbox');
    receiver.drain(Date.now() + 6000);
    expect(count(db, 'outbox')).toBe(1);
  });
  it('quarantines malformed or denied spool entries without starving later valid events', () => {
    const valid = event(project);
    writeFileSync(join(config.notify.spoolDir, `${'0'.repeat(64)}.json`), '{invalid', {
      mode: 0o600,
    });
    const denied = event(dir, { 'turn-id': 'denied' });
    writeFileSync(
      join(config.notify.spoolDir, `${eventIdentity(denied)}.json`),
      JSON.stringify(denied),
      { mode: 0o600 },
    );
    writeFileSync(
      join(config.notify.spoolDir, `${eventIdentity(valid)}.json`),
      JSON.stringify(valid),
      { mode: 0o600 },
    );
    receiver = new NotifyReceiver(config.notify, inbox);
    receiver.drain();
    expect(count(db, 'outbox')).toBe(1);
    const files = readdirSync(config.notify.spoolDir);
    expect(files.filter((f) => f.endsWith('.invalid'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.denied'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
  it('does not follow token or spool symlinks', () => {
    const bad = join(dir, 'token-link');
    symlinkSync(config.notify.tokenFile, bad);
    expect(() => new NotifyReceiver({ ...config.notify, tokenFile: bad }, inbox)).toThrow();
    const raw = event(project),
      path = join(config.notify.spoolDir, `${eventIdentity(raw)}.json`);
    symlinkSync(config.notify.tokenFile, path);
    receiver = new NotifyReceiver(config.notify, inbox);
    receiver.drain();
    expect(readFileSync(config.notify.tokenFile, 'utf8')).toBe(token);
    expect(count(db, 'inbox')).toBe(0);
  });
  it('reuses Feishu unknown-send reconciliation without blind duplicate POST', async () => {
    inbox.receive(event(project));
    let sends = 0;
    const messages = [];
    const api = {
      prepare: async () => {},
      create: async (chat, content) => {
        sends++;
        messages.push({
          message_id: 'om_gui',
          chat_id: chat,
          msg_type: 'interactive',
          sender: { sender_type: 'app', id_type: 'app_id', id: credentials.appId },
          body: { content },
        });
        throw new FeishuApiError('unknown');
      },
      update: async () => {
        throw new Error('unexpected update');
      },
      history: async () => messages,
      get: async () => messages[0],
    };
    const sender = new FeishuSender(store, credentials, api);
    await sender.flushOne();
    expect(db.prepare('SELECT state FROM outbox').pluck().get()).toBe('unknown');
    await sender.flushOne();
    expect(sends).toBe(1);
    db.prepare('UPDATE outbox SET reconcile_at=0').run();
    await sender.reconcileOne(Date.now() + 60_000);
    expect(db.prepare('SELECT state FROM outbox').pluck().get()).toBe('delivered');
    expect(sends).toBe(1);
    expect(count(db, 'tasks')).toBe(0);
  });
});

describe('M6 notify configuration plan and rollback', () => {
  let dir, configPath, planDir, original;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-m6-plan-')));
    configPath = join(dir, 'config.toml');
    planDir = join(dir, 'plan');
    original =
      '# retained\nnotify = ["/bin/echo", "turn-ended"] # comment\nmodel = "fixture"\n[features]\nexample = false\n';
    writeFileSync(configPath, original, { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('prepares without edits, installs capture only, restores exact original bytes', () => {
    chmodSync(dir, 0o755); // User Codex Home is normally traversable; the config remains 600.
    prepareNotify({ configPath, directory: planDir, root: dir });
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(installNotify(planDir).status).toBe('CAPTURE_INSTALLED');
    expect(notifySetting(readFileSync(configPath, 'utf8')).command[0]).toBe(
      realpathSync(process.execPath),
    );
    expect(restoreNotify(planDir).identicalToBackup).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(restoreNotify(planDir).status).toBe('ALREADY_RESTORED');
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
  it('rejects stale plans and double install instead of clobbering changes', () => {
    prepareNotify({ configPath, directory: planDir, root: dir });
    writeFileSync(configPath, original + '# concurrent edit\n');
    expect(() => installNotify(planDir)).toThrow(/配置已改变/);
    writeFileSync(configPath, original);
    installNotify(planDir);
    expect(() => installNotify(planDir)).toThrow(/配置已改变/);
  });
  it('preserves unrelated edits during restore and rejects changed notifier', () => {
    prepareNotify({ configPath, directory: planDir, root: dir });
    installNotify(planDir);
    writeFileSync(configPath, readFileSync(configPath, 'utf8') + '# changed later\n');
    expect(restoreNotify(planDir).identicalToBackup).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(original + '# changed later\n');
    writeFileSync(configPath, 'notify = ["/bin/true"]\n');
    expect(() => restoreNotify(planDir)).toThrow(/其他程序/);
  });
  it('supports absent original notify and rejects unsupported multiline/quoted syntax', () => {
    const text = 'model = "fixture"\n[features]\nx = true\n';
    writeFileSync(configPath, text);
    prepareNotify({ configPath, directory: planDir, root: dir });
    installNotify(planDir);
    restoreNotify(planDir);
    expect(readFileSync(configPath, 'utf8')).toBe(text);
    for (const value of ['notify = [\n"/bin/echo"\n]\n', '"notify" = ["/bin/echo"]\n'])
      expect(() => notifySetting(value)).toThrow();
  });
  it('stages opt-in forwarding without editing either live configuration', async () => {
    prepareNotify({ configPath, directory: planDir, root: dir });
    const example = JSON.parse(readFileSync(resolve('config/config.example.json'), 'utf8'));
    const gatewayPath = join(dir, 'gateway.json');
    const config = {
      ...example,
      projects: [{ key: 'p', name: 'fixture', root: dir, remoteWrite: false }],
    };
    const before = JSON.stringify(config);
    writeFileSync(gatewayPath, before, { mode: 0o600 });
    await expect(
      stageForward({ directory: planDir, gatewayConfig: gatewayPath, projectKey: 'missing' }),
    ).rejects.toThrow();
    expect(
      (await stageForward({ directory: planDir, gatewayConfig: gatewayPath, projectKey: 'p' }))
        .status,
    ).toBe('STAGED_NOT_ENABLED');
    expect(readFileSync(gatewayPath, 'utf8')).toBe(before);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(join(planDir, 'bridge.json'))).mode).toBe('capture');
    const token = readFileSync(join(planDir, 'token'), 'utf8');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(planDir, 'bridge.forward.proposed.json'), 'utf8')).not.toContain(
      token,
    );
  });
});
