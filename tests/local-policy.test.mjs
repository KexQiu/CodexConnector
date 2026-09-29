import { defaultRemoteProjectCreation } from '../src/config/remote-projects.ts';
import { assertLocalConfigIsProtected } from '../src/config/local-boundary.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatewayConfigSchema } from '../src/config/schema.ts';
import example from '../config/config.example.json' with { type: 'json' };
import { desktopSettingsSchema } from '../src/desktop/contracts.ts';
import { DesktopVault } from '../src/desktop/vault.ts';
import { validateSettings } from '../src/desktop/runtime.ts';
import { canExecuteProject } from '../src/config/project-policy.ts';
import { checkoutRoot, executableProject, writableProject } from '../src/projects/store.ts';
import { executionPolicy, assertProjectInteraction } from '../src/tasks/project-policy.ts';
import { projectPickerCard } from '../src/feishu/navigation-cards.ts';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';

let root, db, store;
const owner = { tenantKey: 't', appId: 'a', openId: 'u' };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-policy-')));
  db = openGatewayDatabase(join(root, 'state.sqlite'));
  store = new TaskStore(db);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const project = (mode = 'read-only', networkAccess = false) => ({
  key: 'p',
  name: 'Project',
  root,
  remotePermissions: { mode, networkAccess },
});
const submit = (name, cwd = join(root, name), threadId) =>
  store.submit({
    owner,
    requestKey: name,
    projectKey: threadId ? 'first' : name,
    cwd,
    prompt: name,
    ...(threadId ? { threadId } : {}),
  }).task;
const claim = (task, limit = 2, checkout = task.cwd) =>
  store.claim(task.task_id, 'epoch', {
    maxConcurrentTasks: limit,
    checkoutRoot: checkout,
  });
const running = (task, threadId = `thread-${task.task_id}`) => {
  store.bindThread(task.task_id, threadId, task.cwd, 'epoch');
  store.bindTurn(task.task_id, { id: `turn-${task.task_id}`, status: 'inProgress', items: [] });
};
const complete = (task) =>
  store.reconcileTurn(task.task_id, {
    id: `turn-${task.task_id}`,
    status: 'completed',
    items: [],
    error: null,
  });

describe('local project permissions', () => {
  it('refuses writable projects containing gateway configuration/data, including aliases and not-yet-created paths', () => {
    const vault = join(root, 'vault');
    mkdirSync(vault);
    symlinkSync(vault, join(root, 'alias'));
    const p = project('workspace-write');
    expect(() => assertLocalConfigIsProtected([p], [join(root, 'alias', 'new-profile')])).toThrow(
      '包含网关',
    );
    expect(() => assertLocalConfigIsProtected([project('read-only')], [vault])).not.toThrow();
    expect(() =>
      assertLocalConfigIsProtected([{ ...p, root: join(root, 'workspace') }], [vault]),
    ).not.toThrow();
  });
  it('accepts one policy source only, validates concurrency bounds and defaults older configurations', () => {
    for (const mode of ['disabled', 'read-only', 'workspace-write'])
      expect(
        gatewayConfigSchema.parse({ ...example, maxConcurrentTasks: 8, projects: [project(mode)] })
          .projects[0],
      ).toEqual(project(mode));
    for (const p of [
      { key: 'p', name: 'p', root },
      { ...project(), remoteWrite: true },
    ])
      expect(gatewayConfigSchema.safeParse({ ...example, projects: [p] }).success).toBe(false);
    for (const value of [0, 9, 1.5, '2', null])
      expect(gatewayConfigSchema.safeParse({ ...example, maxConcurrentTasks: value }).success).toBe(
        false,
      );
    expect(
      gatewayConfigSchema.parse({ ...example, maxConcurrentTasks: undefined }).maxConcurrentTasks,
    ).toBe(1);
    expect(canExecuteProject({ remoteWrite: false })).toBe(false);
    expect(canExecuteProject({ remoteWrite: true })).toBe(true);
  });
  it('allows readonly submission but not write authorization; disables all execution explicitly', () => {
    expect(executableProject([project()], 'p').cwd).toBe(root);
    expect(() => writableProject([project()], 'p')).toThrow('文件修改');
    expect(() => executableProject([project('disabled')], 'p')).toThrow('未开放');
    const card = projectPickerCard([{ ...project(), available: true }], 0);
    expect(card.buttons.filter((button) => button.action === 'project')).toHaveLength(1);
    expect(JSON.stringify(card.layout)).toContain('只读分析');
    expect(card.buttons[0].action).toBe('projectless_sessions');
    expect(
      projectPickerCard([{ ...project('disabled'), available: true }], 0).buttons.filter(
        (button) => button.action === 'project',
      ),
    ).toHaveLength(0);
  });
  it.each(['read-only', 'workspace-write'])(
    'enforces %s and network on each thread and turn without remote escalation',
    (mode) => {
      for (const networkAccess of [false, true]) {
        const p = project(mode, networkAccess),
          policy = executionPolicy(p, root);
        expect(policy.thread.approvalPolicy).toBe('never');
        expect(policy.thread.sandbox).toBe(mode);
        expect(policy.thread.config.web_search).toBe(networkAccess ? 'live' : 'disabled');
        expect(policy.turn.sandboxPolicy).toMatchObject({
          type: mode === 'read-only' ? 'readOnly' : 'workspaceWrite',
          networkAccess,
        });
        if (mode === 'workspace-write')
          expect(policy.turn.sandboxPolicy).toMatchObject({
            writableRoots: [root],
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          });
        for (const method of [
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval',
        ])
          expect(() => assertProjectInteraction(p, method)).toThrow('硬限制');
        expect(() => assertProjectInteraction(p, 'item/tool/requestUserInput')).not.toThrow();
      }
      expect(executionPolicy({ remoteWrite: true }, root).thread.approvalPolicy).toBe('on-request');
    },
  );
  it('persists local settings, forwards the concurrency cap and defaults old desktop records', () => {
    const settings = {
      codexBinary: '/fixture/codex',
      feishu: {
        appId: 'cli_fixture',
        tenantKey: 't',
        allowedOpenId: 'ou_fixture',
        testChatId: 'oc_fixture',
      },
      projects: [project()],
      maxConcurrentTasks: 3,
    };
    const vault = new DesktopVault(join(root, 'vault'), {
      encrypt: (s) => Buffer.from(s).toString('base64'),
      decrypt: (s) => Buffer.from(s, 'base64').toString(),
    });
    vault.write('active', vault.prepare(settings, 'secret'));
    expect(vault.read('active').settings).toEqual({
      ...settings,
      hiddenProjectRoots: [],
      remoteProjectCreation: defaultRemoteProjectCreation(),
    });
    expect(validateSettings(settings, { ...settings.feishu, appSecret: 'secret' })).toMatchObject({
      maxConcurrentTasks: 3,
      projects: [project()],
    });
    expect(
      desktopSettingsSchema.parse({ ...settings, maxConcurrentTasks: undefined })
        .maxConcurrentTasks,
    ).toBe(1);
  });
});

describe('durable concurrency slots and checkout isolation', () => {
  it('keeps default one, runs isolated projects up to the configured cap and releases only on terminal state', () => {
    const a = submit('a'),
      b = submit('b'),
      c = submit('c');
    expect(claim(a, 1)).toBeTypeOf('string');
    running(a);
    expect(claim(b, 1)).toBeNull();
    expect(claim(b, 2)).toBeTypeOf('string');
    running(b);
    expect(claim(c, 2)).toBeNull();
    complete(a);
    expect(claim(c, 2)).toBeTypeOf('string');
  });
  it('waiting approval/input and unknown tasks keep capacity across database reopen; lowering the cap does not evict', () => {
    const a = submit('a'),
      b = submit('b'),
      c = submit('c');
    claim(a);
    running(a);
    claim(b);
    running(b);
    db.prepare('UPDATE tasks SET waiting_approval=1 WHERE task_id=?').run(a.task_id);
    db.prepare('UPDATE tasks SET waiting_input=1 WHERE task_id=?').run(b.task_id);
    expect(claim(c)).toBeNull();
    store.recoverLocal('new-epoch');
    db.close();
    db = openGatewayDatabase(join(root, 'state.sqlite'));
    store = new TaskStore(db);
    expect(store.get(a.task_id).status).toBe('unknown');
    expect(claim(c, 2)).toBeNull();
    expect(claim(c, 1)).toBeNull();
    expect(claim(c, 3)).toBeTypeOf('string');
    expect(db.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBe(8);
  });
  it('serializes the same thread and overlapping checkouts without a constraint exception', () => {
    const a = submit('first');
    claim(a);
    running(a, 'thread-one');
    const continuation = submit('continuation', a.cwd, 'thread-one');
    expect(claim(continuation, 8, join(root, 'different-lock'))).toBeNull();
    const nested = submit('nested', join(a.cwd, 'nested'));
    const parent = submit('parent', root);
    expect(claim(nested, 8)).toBeNull();
    expect(claim(parent, 8)).toBeNull();
    complete(a);
    expect(claim(continuation, 8)).toBeTypeOf('string');
  });
  it('coordinates separate SQLite connections atomically', () => {
    const otherDb = openGatewayDatabase(join(root, 'state.sqlite'));
    try {
      const other = new TaskStore(otherDb),
        a = submit('a'),
        b = submit('b');
      expect(claim(a, 1)).toBeTypeOf('string');
      expect(other.claim(b.task_id, 'other', { maxConcurrentTasks: 1 })).toBeNull();
      expect(other.claim(b.task_id, 'other', { maxConcurrentTasks: 2 })).toBeTypeOf('string');
    } finally {
      otherDb.close();
    }
  });
  it('locks sibling directories inside a checkout together, but permits distinct worktrees and resolves aliases', () => {
    const repo = join(root, 'repo'),
      wt = join(root, 'worktree');
    for (const p of [join(repo, '.git'), join(repo, 'a'), join(repo, 'b'), wt])
      mkdirSync(p, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/test`);
    symlinkSync(join(repo, 'a'), join(root, 'alias'));
    expect(checkoutRoot(join(root, 'alias'))).toBe(repo);
    expect(checkoutRoot(wt)).toBe(wt);
    const a = submit('a', join(repo, 'a')),
      b = submit('b', join(repo, 'b')),
      c = submit('c', wt);
    expect(claim(a, 3, checkoutRoot(a.cwd))).toBeTypeOf('string');
    expect(claim(b, 3, checkoutRoot(b.cwd))).toBeNull();
    expect(claim(c, 3, checkoutRoot(c.cwd))).toBeTypeOf('string');
  });
});
