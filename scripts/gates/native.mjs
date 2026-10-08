import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { nodeEnvironment } from '../node-runtime.mjs';

const root = dirname(dirname(import.meta.dirname));
const runtime = join(root, '.artifacts/native-runtime');
const directory = mkdtempSync(join(tmpdir(), 'cc-native-pipes-'));
const data = join(directory, '中文 空格 数据');
mkdirSync(data, { mode: 0o700 });
const project = join(directory, '测试项目');
mkdirSync(project, { mode: 0o700 });
const key = randomBytes(32).toString('hex');
const secret = 'fixture-native-secret-never-output';
const hosts = [];
function createHost() {
  const child = spawn(join(runtime, 'node'), [join(runtime, 'backend/desktop/native-entry.js')], {
    cwd: runtime,
    env: nodeEnvironment(join(runtime, 'node')),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hosts.push(child);
  const pending = new Map();
  let next = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    assert(!line.includes(secret), 'Secret appeared in an IPC snapshot or event');
    const reply = JSON.parse(line);
    if (!reply.id) return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(reply.id);
    if (reply.ok) waiter.resolve(reply.value);
    else waiter.reject(new Error(reply.error));
  });
  const request = (method, args) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('native gate timeout'));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    });
  const call = (requestValue) => request('request', requestValue);
  return { child, request, call };
}
async function children(pid) {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
try {
  const first = createHost();
  const initial = await first.request('initialize', { root: data, key });
  assert.equal(initial.configured, false);
  assert.equal(initial.status.phase, 'stopped');
  const settings = {
    ...initial.settings,
    codexBinary: '/fixture/local-codex',
    maxConcurrentTasks: 3,
    projects: [
      {
        key: 'fixture',
        name: '测试项目',
        root: project,
        remotePermissions: { mode: 'disabled', networkAccess: false },
      },
    ],
  };
  await first.call({ method: 'saveDraft', settings, secret: '' });
  let flow = await first.call({
    method: 'feishuSetup',
    action: { kind: 'begin', mode: 'existing', intent: 'replace' },
  });
  const fields = {
    appId: 'cli_fixture',
    tenantKey: 'fixture',
    allowedOpenId: 'ou_fixture',
    testChatId: 'oc_fixture',
  };
  flow = await first.call({
    method: 'feishuSetup',
    action: { kind: 'edit', revision: flow.draft.revision, fields, secret, name: 'fixture' },
  });
  flow = await first.call({ method: 'feishuSetup', action: { kind: 'step', step: 4 } });
  await first.call({ method: 'feishuSetup', action: { kind: 'flow-skip' } });
  const saved = await first.call({ method: 'applyFeishuSetup', revision: flow.draft.revision });
  assert.equal(saved.configured, true);
  assert.equal(saved.hasDraft, true);
  assert.equal(saved.settings.maxConcurrentTasks, 3);
  assert.deepEqual(saved.settings.projects, settings.projects);
  assert.equal(saved.activeSettings.maxConcurrentTasks, 1);
  assert.deepEqual(saved.activeSettings.projects, []);
  assert.equal(saved.hasSecret, true);
  for (const file of ['active.json', 'draft.json', 'feishu-setup.json'])
    assert(!readFileSync(join(data, file), 'utf8').includes(secret));
  const descendants = await children(first.child.pid);
  assert.equal(descendants.length, 1, 'expected only the privately forked gateway backend');
  const exited = once(first.child, 'exit');
  first.child.stdin.end();
  assert.equal((await exited)[0], 0);
  for (const pid of descendants)
    assert.equal(alive(pid), false, 'parent EOF left its backend alive');
  const second = createHost();
  const reopened = await second.request('initialize', { root: data, key });
  assert.deepEqual(reopened.settings, saved.settings);
  await assert.rejects(second.call({ method: 'start' }), /未应用草稿/);
  const done = once(second.child, 'exit');
  await second.request('shutdown');
  assert.equal((await done)[0], 0);
  const diagnostic = createHost();
  await diagnostic.request('initialize', {
    root: join(directory, 'diagnostic'),
    key,
    diagnostic: true,
  });
  const discovery = await diagnostic.call({
    method: 'discoverProjects',
    knownRoots: [],
    feishu: fields,
  });
  assert.deepEqual(discovery.projects, []);
  await assert.rejects(diagnostic.call({ method: 'checkCodex', binary: '/bin/sh' }), /诊断模式/);
  const diagnosticExit = once(diagnostic.child, 'exit');
  await diagnostic.request('shutdown');
  assert.equal((await diagnosticExit)[0], 0);
  console.log(
    'Rust transition gate passed: encrypted save/reopen, Feishu-only merge, private pipes, parent EOF cleanup, diagnostic isolation. No network or model tasks.',
  );
} finally {
  for (const child of hosts)
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  rmSync(directory, { recursive: true, force: true });
}
