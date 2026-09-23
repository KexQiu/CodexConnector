import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import type { ProjectStore } from '../projects/store.js';
import { canonicalDirectory, writableProject } from '../projects/store.js';
import type { TaskStore } from '../tasks/store.js';
import { TaskError, type StoredTask } from '../tasks/types.js';
import { taskFailureDescription } from '../tasks/presentation.js';
import { configuredOwner } from '../tasks/worker.js';
import { inboundPayload, type FeishuInbox } from './inbound.js';
import type { Interactions } from '../tasks/interactions.js';
import type { TaskControls } from '../tasks/controls.js';
import { decisionSchema } from '../tasks/interaction-policy.js';
import { ContextPanel } from './context-panel.js';
import { StatusMetrics } from '../tasks/status-metrics.js';
import type { CardLayout } from './card-layout.js';
import { quotaLayout } from './metrics-layout.js';
import { taskLayout } from './task-layout.js';
import {
  helpCard,
  navigationButtons,
  operationCard,
  projectPickerCard,
  taskListCard,
} from './navigation-cards.js';
import {
  gatewaySessionCard,
  desktopSessionCard,
  copyIdCard,
  resultCard,
  sameConversation,
} from './session-cards.js';
import { DRAFT_TTL, queueNotice, topicTitle, type NoticeButton } from './conversation-ui.js';

const commandRow = z.object({
  command_id: z.string(),
  inbox_id: z.string(),
  payload: z.string(),
  attempts: z.number(),
  target_task_id: z.string().nullable(),
  target_project_key: z.string().nullable(),
  created_at: z.number(),
});
export class FeishuCommands {
  readonly store: TaskStore;
  readonly panel: ContextPanel;
  constructor(
    private readonly inbox: FeishuInbox,
    private readonly config: GatewayConfig,
    private readonly projects: Pick<ProjectStore, 'catalog' | 'sessions'>,
    private readonly interactive?: {
      interactions: Interactions;
      controls: TaskControls;
      refreshMetrics?: (taskId?: string, projectKey?: string) => Promise<void> | void;
      refreshQuota?: () => Promise<void> | void;
    },
  ) {
    this.store = inbox.store;
    this.panel = new ContextPanel(this.store, config, inbox.owner, inbox.credentials.testChatId);
  }
  resolveTask(short: string): StoredTask {
    if (short.length < 8) throw new TaskError('任务 ID 至少输入 8 位');
    const tasks = this.store
      .list(this.inbox.owner)
      .filter((task) => task.task_id.startsWith(short));
    if (tasks.length !== 1)
      throw new TaskError(tasks.length ? '任务短 ID 有冲突，请输入完整 ID' : '任务不存在或无权限');
    return tasks[0]!;
  }
  private replyTask(message: string) {
    const ids = this.store.db
      .prepare(
        `SELECT t.task_id FROM tasks t JOIN task_destinations d USING(task_id)
      WHERE (t.notification_message_id = ? OR EXISTS
        (SELECT 1 FROM feishu_actions a WHERE a.task_id=t.task_id AND a.message_id=? AND a.owner_key=d.owner_key AND a.chat_id=d.chat_id))
        AND d.owner_key = ? AND d.chat_id = ?`,
      )
      .pluck()
      .all(message, message, this.inbox.owner, this.inbox.credentials.testChatId);
    if (ids.length > 1)
      throw new TaskError('这张列表卡包含多个会话，请先点击要继续的会话，再发送消息。');
    const id = ids[0];
    if (typeof id !== 'string')
      throw new TaskError('回复的消息未关联当前用户的任务，请指定完整任务 ID');
    return this.store.get(id);
  }
  private context() {
    return z
      .object({ project_key: z.string(), task_id: z.string().nullable() })
      .nullish()
      .parse(
        this.store.db
          .prepare('SELECT * FROM user_context WHERE owner_key = ?')
          .get(this.inbox.owner),
      );
  }
  private notice(
    key: string,
    title: string,
    text: string,
    buttons: NoticeButton[] = [],
    layout?: CardLayout,
  ) {
    queueNotice(
      this.store,
      this.inbox.owner,
      this.inbox.credentials.testChatId,
      key,
      title,
      text,
      buttons,
      layout,
    );
  }
  private projectName(key: string) {
    return this.config.projects.find((p) => p.key === key)?.name ?? key;
  }
  private taskList(page: number) {
    return taskListCard(
      this.store,
      this.inbox.owner,
      this.config.projects,
      this.context()?.task_id,
      page,
    );
  }
  private detailButtons(task: StoredTask): NoticeButton[] {
    const context = this.context();
    const selected = context?.task_id ? this.store.get(context.task_id) : null;
    return [
      ...(!sameConversation(task, selected)
        ? [
            {
              label: '接着聊',
              action: 'select' as const,
              taskId: task.task_id,
              expiresAt: Date.now() + DRAFT_TTL,
            },
          ]
        : []),
      {
        label: '查看完整内容',
        action: 'result',
        taskId: task.task_id,
        page: 0,
        expiresAt: Date.now() + DRAFT_TTL,
      },
    ];
  }
  private async sessionCard(projectKey: string, page: number, desktop = false) {
    if (!projectKey) throw new TaskError('请先选择项目，或发送 /会话 项目key。');
    if (desktop)
      return desktopSessionCard(this.projects, projectKey, this.projectName(projectKey), page);
    if (!this.config.projects.some((p) => p.key === projectKey))
      throw new TaskError('项目不存在，请先发送 /项目。');
    const context = this.context();
    const selected = context?.task_id ? this.store.get(context.task_id) : null;
    return gatewaySessionCard(
      this.store,
      this.inbox.owner,
      projectKey,
      this.projectName(projectKey),
      selected,
      page,
    );
  }
  private contextNotice(key: string, projectKey: string, task: StoredTask | null) {
    this.notice(
      key,
      task ? '已切换话题' : '新话题已准备好',
      `当前项目：${this.projectName(projectKey)}\n当前话题：${task ? topicTitle(this.store, task) : '新话题'}\n` +
        new StatusMetrics(this.store, this.inbox.owner).sessionText(
          task?.thread_id ?? null,
          task?.turn_id ?? null,
          false,
          projectKey,
          this.config.projects.find((p) => p.key === projectKey)?.root,
        ) +
        '\n' +
        (task
          ? '直接发送消息即可继续；正在执行时，新消息将排到下一轮。'
          : '直接发送需求即可开始。') +
        '\n回复其他任务卡片时，以被回复的话题为准。' +
        (this.config.projects.find((p) => p.key === projectKey)?.remoteWrite
          ? ''
          : '\n该项目目前只读，尚不能执行任务。'),
      [
        ...(task
          ? [
              {
                label: '新话题',
                action: 'new_topic' as const,
                taskId: task.task_id,
                expiresAt: Date.now() + DRAFT_TTL,
              },
            ]
          : []),
        { label: '切换项目', action: 'projects', page: 0, expiresAt: Date.now() + DRAFT_TTL },
      ],
      this.panel.snapshot().layout,
    );
  }
  private draft(id: string, now = Date.now()) {
    const row = z
      .object({ prompt: z.string(), state: z.string(), expires_at: z.number() })
      .optional()
      .parse(
        this.store.db
          .prepare('SELECT * FROM feishu_drafts WHERE draft_id=? AND owner_key=? AND chat_id=?')
          .get(id, this.inbox.owner, this.inbox.credentials.testChatId),
      );
    if (!row || row.state !== 'pending')
      throw new TaskError('这条需求已处理或已取消，请查看任务卡；不要重复提交。');
    if (row.expires_at <= now)
      throw new TaskError('项目选择已过期，这条需求尚未执行。请重新发送需求。');
    return row;
  }
  private async projectPicker(key: string, draftId: string | null, page = 0) {
    const draft = draftId ? this.draft(draftId) : null;
    // Configured projects remain usable even when Codex project discovery is offline.
    const configured = this.config.projects.map((p) => {
      let available = true;
      try {
        canonicalDirectory(p.root);
      } catch {
        available = false;
      }
      return { ...p, available };
    });
    let list = configured;
    let discoveryUnavailable = false;
    try {
      const catalog = await this.projects.catalog();
      list = [
        ...configured,
        ...catalog
          .filter((p) => !configured.some((c) => c.key === p.key))
          .map((p) => ({ ...p, remoteWrite: false })),
      ];
    } catch {
      discoveryUnavailable = true;
    }
    const card = projectPickerCard(
      list,
      page,
      this.context()?.project_key,
      draft && draftId ? { id: draftId, prompt: draft.prompt, expiresAt: draft.expires_at } : null,
      discoveryUnavailable,
    );
    // Recheck a pending draft after the asynchronous catalog lookup.
    this.store.db
      .transaction(() => {
        if (draftId) this.draft(draftId);
        this.notice(key, card.layout.heading, card.layout.heading, card.buttons, card.layout);
      })
      .immediate();
  }
  private submit(
    key: string,
    projectKey: string,
    prompt: string,
    parent: StoredTask | null,
    updateContext = true,
  ) {
    const project = writableProject(this.config.projects, projectKey, parent?.cwd);
    if (
      this.store
        .list(this.inbox.owner)
        .filter((t) => ['queued', 'starting', 'running', 'unknown'].includes(t.status)).length >=
      100
    )
      throw new TaskError('任务队列已满（100），请等待或处理结果待核对的任务。');
    const { task } = this.store.submit({
      owner: configuredOwner(this.config),
      requestKey: `feishu:${key}`,
      projectKey,
      cwd: project.cwd,
      prompt,
      ...(parent?.thread_id ? { threadId: parent.thread_id } : {}),
    });
    this.attach(task);
    if (updateContext) this.store.setContext(this.inbox.owner, projectKey, task.task_id);
    return task;
  }
  private attach(task: StoredTask) {
    const db = this.store.db;
    db.prepare('INSERT OR IGNORE INTO task_destinations VALUES (?,?,?)').run(
      task.task_id,
      this.inbox.owner,
      this.inbox.credentials.testChatId,
    );
    const destination = db
      .prepare('SELECT chat_id FROM task_destinations WHERE task_id = ? AND owner_key = ?')
      .pluck()
      .get(task.task_id, this.inbox.owner);
    if (destination !== this.inbox.credentials.testChatId)
      throw new TaskError('任务已有其他消息目标');
    db.prepare(
      "UPDATE outbox SET owner_key = ?, chat_id = ? WHERE task_id = ? AND state = 'pending'",
    ).run(this.inbox.owner, destination, task.task_id);
  }
  async processNext(now = Date.now()): Promise<boolean> {
    const db = this.store.db;
    const raw = db
      .prepare(
        `SELECT * FROM feishu_commands WHERE owner_key = ? AND chat_id = ?
      AND state != 'processed' AND attempts < 5 AND next_retry_at <= ? ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(this.inbox.owner, this.inbox.credentials.testChatId, now);
    if (!raw) return false;
    const command = commandRow.parse(raw);
    try {
      const payload = inboundPayload.parse(JSON.parse(command.payload));
      const words = payload.text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const name = words?.[1] ?? '',
        rest = words?.[2]?.trim() ?? '';
      const finish = (action: () => void) =>
        db
          .transaction(() => {
            action();
            db.prepare(
              "UPDATE feishu_commands SET state = 'processed', attempts = attempts + 1, error_code = NULL WHERE command_id = ?",
            ).run(command.command_id);
            db.prepare(
              "UPDATE inbox SET state = 'processed', attempts = attempts + 1, error_code = NULL, updated_at = ? WHERE inbox_id = ?",
            ).run(Date.now(), command.inbox_id);
          })
          .immediate();
      const notice = (
        title: string,
        text: string,
        layout?: CardLayout,
        buttons: NoticeButton[] = [],
      ) => finish(() => this.notice(command.command_id, title, text, buttons, layout));
      const associate = (taskId: string) =>
        db
          .prepare('UPDATE feishu_commands SET task_id=? WHERE command_id=?')
          .run(taskId, command.command_id);
      if (payload.kind === 'action') {
        if (payload.action === 'tasks') {
          const card = this.taskList(payload.page ?? 0);
          notice(card.layout.heading, '任务列表', card.layout, card.buttons);
          return true;
        }
        if (payload.action === 'sessions') {
          const card = await this.sessionCard(
            payload.projectKey ?? '',
            payload.page ?? 0,
            payload.choice === 'desktop',
          );
          notice(card.layout.heading, '会话列表', card.layout, card.buttons);
          return true;
        }

        if (payload.action === 'panel') {
          await this.interactive?.refreshMetrics?.(
            undefined,
            payload.choice === 'new_topic' ? this.context()?.project_key : undefined,
          );
          finish(() => {
            const context = this.context();
            this.panel.request();
            if (payload.choice === 'refresh') {
              const snapshot = this.panel.snapshot();
              this.notice(
                command.command_id,
                '当前会话快照',
                snapshot.text,
                snapshot.buttons,
                snapshot.layout,
              );
            } else if (
              !context ||
              context.project_key !== payload.projectKey ||
              context.task_id !== payload.taskId
            ) {
              const snapshot = this.panel.snapshot();
              this.notice(
                command.command_id,
                '当前会话已变化',
                '旧面板操作未生效，请使用最新状态。\n' + snapshot.text,
                snapshot.buttons,
                {
                  ...snapshot.layout,
                  alerts: ['旧面板操作未生效，请使用最新状态。', ...snapshot.layout.alerts],
                },
              );
            } else if (payload.choice === 'new_topic') {
              this.store.setContext(this.inbox.owner, context.project_key, null);
              this.contextNotice(command.command_id, context.project_key, null);
            } else if (payload.choice === 'details' && context.task_id) {
              const task = this.resolveTask(context.task_id);
              this.notice(
                command.command_id,
                '任务详情',
                this.describe(task),
                this.detailButtons(task),
                taskLayout(this.store, task, this.projectName(task.project_key), true),
              );
              associate(task.task_id);
            } else throw new TaskError('面板操作无效');
          });
          return true;
        }
        if (payload.action === 'projects') {
          await this.projectPicker(command.command_id, payload.draftId, payload.page ?? 0);
          finish(() => {});
          return true;
        }
        if (payload.action === 'cancel_draft') {
          finish(() => {
            this.draft(payload.draftId ?? '');
            db.prepare("UPDATE feishu_drafts SET state='cancelled' WHERE draft_id=?").run(
              payload.draftId,
            );
            this.notice(
              command.command_id,
              '需求已取消',
              '这条需求没有执行。直接发送新的需求即可。',
              navigationButtons(),
              operationCard('需求已取消', '这条需求没有执行。', 'grey', '直接发送新的需求即可。'),
            );
          });
          return true;
        }
        if (payload.action === 'project') {
          await this.interactive?.refreshMetrics?.(undefined, payload.projectKey ?? undefined);
          finish(() => {
            const projectKey = payload.projectKey ?? '';
            writableProject(this.config.projects, projectKey);
            if (payload.draftId) {
              const draft = this.draft(payload.draftId);
              const task = this.submit(`draft:${payload.draftId}`, projectKey, draft.prompt, null);
              db.prepare(
                "UPDATE feishu_drafts SET state='submitted',task_id=? WHERE draft_id=?",
              ).run(task.task_id, payload.draftId);
              db.prepare('UPDATE feishu_commands SET task_id=? WHERE command_id=?').run(
                task.task_id,
                payload.draftId,
              );
              associate(task.task_id);
            } else {
              this.store.setContext(this.inbox.owner, projectKey, null);
              this.contextNotice(command.command_id, projectKey, null);
            }
          });
          return true;
        }
        const task = this.resolveTask(payload.taskId ?? '');
        if (payload.action === 'select' || payload.action === 'details')
          await this.interactive?.refreshMetrics?.(task.task_id);
        else if (payload.action === 'new_topic')
          await this.interactive?.refreshMetrics?.(undefined, task.project_key);
        finish(() => {
          if (payload.action === 'approval') {
            if (!this.interactive) throw new TaskError('审批处理器未就绪');
            const choice = decisionSchema.safeParse(payload.choice);
            if (!choice.success) throw new TaskError('按钮决定无效');
            this.interactive.interactions.decide(
              payload.approvalId ?? '',
              choice.data,
              task.task_id,
            );
          } else if (payload.action === 'interrupt') {
            if (!this.interactive) throw new TaskError('控制处理器未就绪');
            this.interactive.controls.enqueue(command.command_id, task.task_id, 'interrupt');
          } else if (payload.action === 'copy_id') {
            this.notice(
              command.command_id,
              'ID 信息',
              `任务 ID：${task.task_id}\n会话 ID：${task.thread_id ?? '尚未建立'}`,
              [],
              copyIdCard(task),
            );
          } else if (payload.action === 'result') {
            const card = resultCard(this.store, task, payload.page ?? 0);
            this.notice(
              command.command_id,
              '完整内容',
              card.layout.heading,
              card.buttons,
              card.layout,
            );
          } else if (payload.action === 'select') {
            this.store.setContext(this.inbox.owner, task.project_key, task.task_id);
            this.contextNotice(command.command_id, task.project_key, task);
          } else if (payload.action === 'new_topic') {
            this.store.setContext(this.inbox.owner, task.project_key, null);
            this.contextNotice(command.command_id, task.project_key, null);
          } else if (payload.action === 'details') {
            this.notice(
              command.command_id,
              '任务详情',
              this.describe(task),
              this.detailButtons(task),
              taskLayout(this.store, task, this.projectName(task.project_key), true),
            );
          } else this.store.refresh(task.task_id);
          associate(task.task_id);
        });
        return true;
      }
      if (name === '/帮助') {
        const card = helpCard();
        notice('使用帮助', '日常对话、查询与切换、任务控制', card.layout, card.buttons);
        return true;
      }
      if (name === '/当前' || name === '/面板') {
        await this.interactive?.refreshMetrics?.();
        finish(() => {
          this.panel.request();
          const snapshot = this.panel.snapshot();
          this.notice(
            command.command_id,
            '当前会话快照',
            snapshot.text,
            snapshot.buttons,
            snapshot.layout,
          );
        });
        return true;
      }
      if (name === '/额度') {
        if (rest) throw new TaskError('直接发送 /额度 即可查看账号剩余额度。');
        await this.interactive?.refreshQuota?.();
        notice(
          '账号剩余额度',
          new StatusMetrics(this.store, this.inbox.owner).accountText(null, true),
          quotaLayout(new StatusMetrics(this.store, this.inbox.owner)),
        );
        return true;
      }
      if (name === '/项目') {
        await this.projectPicker(command.command_id, null);
        finish(() => {});
        return true;
      }
      if (name === '/选择') {
        if (!this.config.projects.some((p) => p.key === rest))
          throw new TaskError('项目不存在，请先发送 /项目');
        await this.interactive?.refreshMetrics?.(undefined, rest);
        finish(() => {
          this.store.setContext(this.inbox.owner, rest, null);
          this.contextNotice(command.command_id, rest, null);
        });
        return true;
      }
      if (name === '/会话') {
        const [key, pageValue = '1', mode] = rest.split(/\s+/);
        const page = Number(pageValue);
        if (!Number.isSafeInteger(page) || page < 1 || page > 500)
          throw new TaskError('页码应为 1–500 的整数');
        const card = await this.sessionCard(
          key || this.context()?.project_key || '',
          page - 1,
          mode === '桌面',
        );
        notice(card.layout.heading, '会话列表', card.layout, card.buttons);
        return true;
      }
      if (name === '/任务') {
        const page = rest ? Number(rest) : 1;
        if (!Number.isSafeInteger(page) || page < 1 || page > 500)
          throw new TaskError('格式：/任务 [页码]；页码应为 1–500 的整数。');
        const card = this.taskList(page - 1);
        notice(card.layout.heading, '任务列表', card.layout, card.buttons);
        return true;
      }
      // A reply is authoritative. Never fall through to a newer implicit selection.
      const replied = payload.replyTo ? this.replyTask(payload.replyTo) : null;
      if (name === '/新话题') {
        const projectKey = replied?.project_key ?? this.context()?.project_key;
        if (rest) throw new TaskError('直接发送 /新话题 即可；切换项目请使用 /项目。');
        if (!projectKey) await this.projectPicker(command.command_id, null);
        else await this.interactive?.refreshMetrics?.(undefined, projectKey);
        finish(() => {
          if (projectKey) {
            this.store.setContext(this.inbox.owner, projectKey, null);
            this.contextNotice(command.command_id, projectKey, null);
          }
        });
        return true;
      }
      if (name === '/回答') {
        if (!this.interactive) throw new TaskError('回答处理器未就绪');
        const match = rest.match(/^(\S+)\s+(\d+)\s+([\s\S]+)$/);
        if (!match) throw new TaskError('格式：/回答 审批ID 题号 答案');
        finish(() => {
          const approval = this.interactive!.interactions.find(match[1]!);
          this.interactive!.interactions.answer(
            match[1]!,
            Number(match[2]),
            match[3]!,
            replied?.task_id,
          );
          associate(approval.task_id);
        });
        return true;
      }
      if (name === '/补充' || name === '/打断') {
        if (!this.interactive) throw new TaskError('控制处理器未就绪');
        const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
        if (!match) throw new TaskError('请指定任务 ID');
        const task = this.resolveTask(match[1]!);
        if (replied && task.task_id !== replied.task_id)
          throw new TaskError('指定任务与被回复卡片不一致');
        if (name === '/打断' && match[2]) throw new TaskError('格式：/打断 任务ID');
        finish(() => {
          this.interactive!.controls.enqueue(
            command.command_id,
            task.task_id,
            name === '/补充' ? 'steer' : 'interrupt',
            match[2] ?? '',
          );
          associate(task.task_id);
        });
        return true;
      }
      if (name === '/状态' || name === '/刷新') {
        const task = rest
          ? this.resolveTask(rest)
          : (replied ??
            (this.context()?.task_id ? this.resolveTask(this.context()!.task_id!) : null));
        if (task && replied && task.task_id !== replied.task_id)
          throw new TaskError('指定任务与被回复卡片不一致');
        if (task && name === '/状态') await this.interactive?.refreshMetrics?.(task.task_id);
        if (name === '/刷新') {
          if (!task) throw new TaskError('请指定要刷新的任务 ID');
          finish(() => {
            this.attach(task);
            this.store.refresh(task.task_id);
          });
        } else if (task)
          notice(
            '任务状态',
            this.describe(task),
            taskLayout(this.store, task, this.projectName(task.project_key), true),
            this.detailButtons(task),
          );
        else {
          const card = this.taskList(0);
          notice(card.layout.heading, '任务列表', card.layout, card.buttons);
        }
        return true;
      }
      let projectKey: string,
        prompt: string,
        parent: StoredTask | null = null;
      if (name === '/新建') {
        const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) throw new TaskError('格式：/新建 项目key 任务内容');
        projectKey = match[1]!;
        prompt = match[2]!;
        if (replied && replied.project_key !== projectKey)
          throw new TaskError('新建项目与被回复任务不一致');
      } else if (name === '/继续') {
        const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) throw new TaskError('格式：/继续 任务ID 任务内容');
        parent = this.resolveTask(match[1]!);
        projectKey = parent.project_key;
        prompt = match[2]!;
        if (replied && replied.task_id !== parent.task_id)
          throw new TaskError('指定任务与被回复卡片不一致');
      } else {
        if (name.startsWith('/')) throw new TaskError('暂不支持该命令。发送 /帮助 查看用法');
        // A crash after saving a draft must not turn it into implicit work after a later switch.
        const existingDraft = z
          .object({ state: z.string(), task_id: z.string().nullable() })
          .optional()
          .parse(
            db
              .prepare(
                'SELECT state,task_id FROM feishu_drafts WHERE draft_id=? AND owner_key=? AND chat_id=?',
              )
              .get(command.command_id, this.inbox.owner, this.inbox.credentials.testChatId),
          );
        if (existingDraft) {
          if (existingDraft.state === 'pending')
            await this.projectPicker(command.command_id, command.command_id);
          finish(() => {
            if (existingDraft.task_id) associate(existingDraft.task_id);
          });
          return true;
        }
        const context = this.context();
        parent =
          command.target_project_key !== null
            ? command.target_task_id
              ? this.resolveTask(command.target_task_id)
              : null
            : (replied ?? (context?.task_id ? this.resolveTask(context.task_id) : null));
        projectKey =
          command.target_project_key ?? parent?.project_key ?? context?.project_key ?? '';
        prompt = payload.text;
        if (!projectKey) {
          if (!prompt.trim()) throw new TaskError('请输入任务内容。');
          const draftCount = db
            .prepare(
              "SELECT count(*) FROM feishu_drafts WHERE owner_key=? AND chat_id=? AND state='pending' AND expires_at>?",
            )
            .pluck()
            .get(this.inbox.owner, this.inbox.credentials.testChatId, now);
          if (typeof draftCount === 'number' && draftCount >= 100)
            throw new TaskError('已有 100 条需求等待选择项目，请先选择项目或取消旧需求。');
          db.prepare(
            `INSERT OR IGNORE INTO feishu_drafts (draft_id,owner_key,chat_id,prompt,state,created_at,expires_at)
            VALUES (?,?,?,?,'pending',?,?)`,
          ).run(
            command.command_id,
            this.inbox.owner,
            this.inbox.credentials.testChatId,
            prompt,
            now,
            now + DRAFT_TTL,
          );
          await this.projectPicker(command.command_id, command.command_id);
          finish(() => {});
          return true;
        }
        db.prepare(
          'UPDATE feishu_commands SET target_task_id=?,target_project_key=? WHERE command_id=?',
        ).run(parent?.task_id ?? null, projectKey, command.command_id);
      }
      writableProject(this.config.projects, projectKey, parent?.cwd);
      if (parent && !parent.thread_id) {
        if (
          !['queued', 'starting', 'unknown'].includes(parent.status) ||
          now - command.created_at >= DRAFT_TTL
        )
          throw new TaskError('上一个话题未能建立会话，本条消息尚未执行。请开启新话题后重新发送。');
        db.transaction(() => {
          db.prepare(
            'UPDATE feishu_commands SET target_task_id=?,next_retry_at=? WHERE command_id=?',
          ).run(parent.task_id, now + 1000, command.command_id);
          this.notice(
            `${command.command_id}:waiting`,
            '后续消息已保存',
            `项目：${this.projectName(projectKey)}\n话题：${topicTitle(this.store, parent)}\n等待该话题建立会话后排队处理，无需重发；这不会中断当前任务。`,
            [
              {
                label: '查看前一任务',
                action: 'details',
                taskId: parent.task_id,
                expiresAt: now + DRAFT_TTL,
              },
            ],
            operationCard(
              '后续消息已保存',
              '等待前一任务建立会话，再排队处理本条消息。',
              'blue',
              '无需重发；这不会中断当前任务。',
              [
                { label: '项目', value: this.projectName(projectKey) },
                { label: '话题', value: topicTitle(this.store, parent) },
              ],
            ),
          );
        }).immediate();
        return true;
      }
      finish(() => {
        const task = this.submit(
          command.command_id,
          projectKey,
          prompt,
          parent,
          command.target_project_key === null ||
            (this.context()?.project_key === projectKey &&
              (this.context()?.task_id ?? null) === (parent?.task_id ?? null)),
        );
        db.prepare('UPDATE feishu_commands SET task_id = ? WHERE command_id = ?').run(
          task.task_id,
          command.command_id,
        );
      });
      return true;
    } catch (error) {
      if (error instanceof TaskError) {
        db.transaction(() => {
          this.notice(
            command.command_id,
            '命令未执行',
            error.message,
            navigationButtons(),
            operationCard(
              '命令未执行',
              error.message,
              'orange',
              '先核对当前会话与任务状态，再根据原因调整操作。',
            ),
          );
          db.prepare(
            "UPDATE feishu_commands SET state = 'processed', error_code = 'command_rejected' WHERE command_id = ?",
          ).run(command.command_id);
          db.prepare(
            "UPDATE inbox SET state = 'processed', error_code = 'command_rejected' WHERE inbox_id = ?",
          ).run(command.inbox_id);
        }).immediate();
      } else {
        db.transaction(() => {
          db.prepare(
            "UPDATE feishu_commands SET state = 'failed', attempts = attempts + 1, next_retry_at = ?, error_code = 'processing_failed' WHERE command_id = ?",
          ).run(now + Math.min(60_000, 1000 * 2 ** command.attempts), command.command_id);
          db.prepare(
            "UPDATE inbox SET state = 'failed', attempts = attempts + 1, error_code = 'processing_failed' WHERE inbox_id = ?",
          ).run(command.inbox_id);
          if (command.attempts >= 4)
            this.notice(
              command.command_id,
              '命令处理失败',
              '已保留原消息，请在本机检查连接和数据库。恢复后使用消息 ID 补收，不要重复发送任务。',
              navigationButtons(),
              operationCard(
                '命令处理失败',
                '已保留原消息，需要在本机检查连接和数据库。',
                'red',
                '先核对原消息的处理结果，不要重复发送任务。',
              ),
            );
        }).immediate();
      }
      return true;
    }
  }
  private describe(task: StoredTask) {
    const metrics = new StatusMetrics(this.store, this.inbox.owner);
    const notification = this.store.db
      .prepare(
        "SELECT state FROM outbox WHERE task_id=? AND state IN ('failed','unknown') ORDER BY card_version DESC LIMIT 1",
      )
      .pluck()
      .get(task.task_id);
    const delivery =
      notification === 'failed'
        ? '通知投递失败，请在本机查看 outbox；不影响模型任务终态。'
        : notification === 'unknown'
          ? '通知结果待核对，不会盲目重发。'
          : '';
    return `话题：${topicTitle(this.store, task)}\n任务：${task.task_id}\n项目：${this.projectName(task.project_key)}（${task.project_key}）\n目录：${task.cwd}\n状态：${task.status}\n等待审批：${!!task.waiting_approval}\n等待输入：${!!task.waiting_input}\nthread：${task.thread_id ?? '待绑定'}\nturn：${task.turn_id ?? '待绑定'}\n${metrics.sessionText(task.thread_id, task.turn_id, true, task.project_key, task.cwd)}\n${taskFailureDescription(task)}\n${delivery}\n${this.store.result(task.task_id).slice(0, 1800)}`;
  }
}
