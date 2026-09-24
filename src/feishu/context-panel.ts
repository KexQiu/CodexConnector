import { canExecuteProject, projectPermissionLabel } from '../config/project-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import type { TaskStore } from '../tasks/store.js';
import { DRAFT_TTL, shortText, topicTitle, type NoticeButton } from './conversation-ui.js';
import { StatusMetrics } from '../tasks/status-metrics.js';
import { sessionSections } from './metrics-layout.js';
import { cardTime, type CardLayout } from './card-layout.js';
import { taskFailureDescription } from '../tasks/presentation.js';

// Rotate before the IM PATCH API's 14-day limit. Refresh buttons before their 24h expiry.
export const PANEL_ROTATE_MS = 13 * 86400_000;
export const PANEL_REFRESH_MS = 12 * 3600_000;
const panelSchema = z.object({
  panel_id: z.string(),
  message_id: z.string().nullable(),
  message_created_at: z.number().nullable(),
  version: z.number(),
  snapshot_hash: z.string().nullable(),
  refresh_requested: z.number(),
  next_refresh_at: z.number(),
  core_hash: z.string().nullable(),
  last_rendered_at: z.number(),
});
const stateNames = {
  queued: '排队中',
  starting: '启动中',
  running: '执行中',
  completed: '执行完成',
  failed: '执行失败',
  interrupted: '已停止',
  unknown: '结果待核对',
};

/** A projection of user_context/tasks, never a second source of routing state. */
export class ContextPanel {
  constructor(
    readonly store: TaskStore,
    private readonly config: GatewayConfig,
    readonly owner: string,
    readonly chat: string,
  ) {}
  context() {
    return z
      .object({ project_key: z.string(), task_id: z.string().nullable() })
      .optional()
      .parse(
        this.store.db
          .prepare('SELECT project_key,task_id FROM user_context WHERE owner_key=?')
          .get(this.owner),
      );
  }
  request() {
    this.store.db
      .prepare(
        `INSERT INTO feishu_panels (panel_id,owner_key,chat_id) VALUES (?,?,?)
      ON CONFLICT(owner_key,chat_id) DO UPDATE SET refresh_requested=1`,
      )
      .run(randomUUID(), this.owner, this.chat);
  }
  snapshot(now = Date.now()) {
    const context = this.context();
    const project = this.config.projects.find((p) => p.key === context?.project_key);
    const task = context?.task_id ? this.store.get(context.task_id) : null;
    if (task && (task.owner_key !== this.owner || task.project_key !== context?.project_key))
      throw new Error('Panel context ownership mismatch');
    const tasks = task
      ? this.store
          .list(this.owner)
          .filter(
            (t) =>
              t.project_key === task.project_key &&
              (task.thread_id ? t.thread_id === task.thread_id : t.task_id === task.task_id),
          )
      : [];
    const active = tasks
      .filter((t) => ['running', 'starting', 'unknown'].includes(t.status))
      .sort((a, b) => a.created_at - b.created_at)[0];
    const queued = tasks.filter((t) => t.status === 'queued').length;
    const waiting = task
      ? z.number().parse(
          this.store.db
            .prepare(
              `SELECT count(*) FROM feishu_commands c JOIN tasks t ON t.task_id=c.target_task_id
      WHERE c.owner_key=? AND c.chat_id=? AND c.state='received' AND c.attempts<5
      AND (t.task_id=? OR (? IS NOT NULL AND t.thread_id=?))`,
            )
            .pluck()
            .get(this.owner, this.chat, task.task_id, task.thread_id, task.thread_id),
        )
      : 0;
    const state = active ?? task;
    const metrics = new StatusMetrics(this.store, this.owner);
    const status = state
      ? queued && !active
        ? '排队中'
        : stateNames[state.status]
      : '等待发送需求';
    const text =
      `当前项目：${project ? shortText(project.name, 80) + '（' + project.key + '）' : (context?.project_key ?? '尚未选择')}\n` +
      `当前会话：${task ? topicTitle(this.store, task) : '新话题'}\n任务状态：${status}\n` +
      `排队消息：${queued + waiting} 条\n权限：${projectPermissionLabel(project)}\n` +
      metrics.sessionText(
        task?.thread_id ?? null,
        state?.turn_id ?? null,
        false,
        project?.key,
        project?.root,
      ) +
      '\n' +
      (state?.waiting_approval ? '等待审批，请在对应任务卡操作。\n' : '') +
      (state?.waiting_input ? '等待补充输入，请查看对应任务卡。\n' : '') +
      (context && !canExecuteProject(project) ? '该项目未开放执行权限。\n' : '') +
      (!context
        ? '先选择项目，或直接发送需求后按提示选择。'
        : task
          ? '下一条普通消息继续当前会话；执行中会排队。'
          : '下一条普通消息将在当前项目新建会话。') +
      '\n引用其他任务卡时，以被回复的话题为准。';
    const buttons: NoticeButton[] = [
      ...(context
        ? [
            {
              label: '切换会话',
              action: 'sessions' as const,
              projectKey: context.project_key,
              choice: 'gateway' as const,
              page: 0,
              expiresAt: now + DRAFT_TTL,
            },
          ]
        : []),
      { label: '切换项目', action: 'projects', page: 0, expiresAt: now + DRAFT_TTL },
      ...(context
        ? [
            {
              label: '新话题',
              action: 'panel' as const,
              choice: 'new_topic' as const,
              projectKey: context.project_key,
              taskId: context.task_id,
              expiresAt: now + DRAFT_TTL,
            },
          ]
        : []),
      ...(task
        ? [
            {
              label: '查看详情',
              action: 'panel' as const,
              choice: 'details' as const,
              projectKey: task.project_key,
              taskId: task.task_id,
              expiresAt: now + DRAFT_TTL,
            },
          ]
        : []),
      { label: '刷新面板', action: 'panel', choice: 'refresh', expiresAt: now + DRAFT_TTL },
    ];
    const layout: CardLayout = {
      version: 1,
      eyebrow: project ? `${shortText(project.name, 80)} · ${project.key}` : '尚未选择项目',
      heading: task ? topicTitle(this.store, task) : '新话题',
      status:
        (state?.waiting_approval ? '等待审批' : state?.waiting_input ? '等待补充输入' : status) +
        (queued + waiting ? ` · ${queued + waiting} 条排队` : ''),
      theme:
        state?.waiting_approval || state?.waiting_input || state?.status === 'unknown'
          ? 'orange'
          : state?.status === 'failed'
            ? 'red'
            : state?.status === 'completed'
              ? 'green'
              : !task
                ? 'grey'
                : 'blue',
      alerts: [
        ...(state?.waiting_approval ? ['请在对应任务卡查看操作范围并选择是否批准。'] : []),
        ...(state?.waiting_input ? ['需要补充输入，请查看对应任务卡。'] : []),
        ...(state && taskFailureDescription(state) ? [taskFailureDescription(state)] : []),
        ...(context && !canExecuteProject(project) ? ['该项目目前只读，未开放执行权限。'] : []),
      ],
      sections: project
        ? sessionSections(
            metrics,
            task?.thread_id ?? null,
            state?.turn_id ?? null,
            project.key,
            project.root,
          )
        : [],
      notes: [
        ...(project ? [`权限：${projectPermissionLabel(project)}`] : []),
        !context
          ? '先选择项目，或直接发送需求后按提示选择。'
          : task
            ? '下一条普通消息继续当前会话；执行中会排队。'
            : '直接发送需求，在当前项目开始新话题。',
        '引用其他任务卡时，以被回复的话题为准。',
      ],
    };
    if (task)
      layout.sections.push({
        title: '任务 ID',
        code: task.task_id,
        notes: ['用于 /状态、/继续 等命令。'],
      });
    buttons.sort((a, b) => {
      const rank = (button: NoticeButton) =>
        button.choice === 'details'
          ? 0
          : button.choice === 'new_topic'
            ? 1
            : button.action === 'projects'
              ? 2
              : 3;
      return rank(a) - rank(b);
    });
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          text,
          rendererRevision: 3,
          layout,
          buttons: buttons.map((button) => ({ ...button, expiresAt: 0 })),
        }),
      )
      .digest('hex');
    const coreHash = createHash('sha256')
      .update(
        JSON.stringify({
          context,
          title: task ? topicTitle(this.store, task) : null,
          active: active?.task_id,
          status,
          queue: queued + waiting,
          approval: state?.waiting_approval,
          input: state?.waiting_input,
          project,
        }),
      )
      .digest('hex');
    return { title: '当前项目与会话', text, layout, buttons, hash, coreHash };
  }
  /** At most one unresolved write per panel. Unknown writes are reconciled, never replayed. */
  sync(now = Date.now()) {
    const db = this.store.db;
    return db
      .transaction(() => {
        let raw = db
          .prepare('SELECT * FROM feishu_panels WHERE owner_key=? AND chat_id=?')
          .get(this.owner, this.chat);
        if (!raw) {
          if (!this.context()) return false;
          this.request();
          raw = db
            .prepare('SELECT * FROM feishu_panels WHERE owner_key=? AND chat_id=?')
            .get(this.owner, this.chat);
        }
        const panel = panelSchema.parse(raw);
        if (
          db
            .prepare(
              "SELECT 1 FROM outbox WHERE panel_id=? AND state IN ('claimed','sending','unknown')",
            )
            .get(panel.panel_id)
        )
          return false;
        const failure = z
          .object({ outbox_id: z.string(), error_code: z.string().nullable() })
          .optional()
          .parse(
            db
              .prepare(
                "SELECT outbox_id,error_code FROM outbox WHERE panel_id=? AND state='failed' ORDER BY card_version DESC LIMIT 1",
              )
              .get(panel.panel_id),
          );
        if (failure) {
          // Only an explicit platform rejection can authorize replacement of a dead card.
          if (!/^feishu_\d+_(230011|230031|230110)$/.test(failure.error_code ?? '')) return false;
          db.prepare("UPDATE outbox SET state='superseded' WHERE outbox_id=?").run(
            failure.outbox_id,
          );
          panel.message_id = null;
          panel.message_created_at = null;
          panel.refresh_requested = 1;
          db.prepare(
            'UPDATE feishu_panels SET message_id=NULL,message_created_at=NULL,refresh_requested=1 WHERE panel_id=?',
          ).run(panel.panel_id);
        }
        const snapshot = this.snapshot(now);
        const rotate =
          panel.message_created_at !== null && now - panel.message_created_at >= PANEL_ROTATE_MS;
        const pending = z
          .object({
            operation: z.string().nullable(),
            next_retry_at: z.number(),
            attempts: z.number(),
          })
          .optional()
          .parse(
            db
              .prepare(
                "SELECT operation,next_retry_at,attempts FROM outbox WHERE panel_id=? AND state='pending' ORDER BY card_version DESC LIMIT 1",
              )
              .get(panel.panel_id),
          );
        if (
          snapshot.hash === panel.snapshot_hash &&
          !panel.refresh_requested &&
          now < panel.next_refresh_at &&
          (!rotate || pending?.operation === 'send')
        )
          return false;
        // Pending updates have not been sent (or were explicitly rejected), so only the newest projection matters.
        if (
          snapshot.coreHash === panel.core_hash &&
          !panel.refresh_requested &&
          !rotate &&
          now - panel.last_rendered_at < 15_000
        )
          return false;
        db.prepare("UPDATE outbox SET state='superseded' WHERE panel_id=? AND state='pending'").run(
          panel.panel_id,
        );
        const message = rotate ? null : panel.message_id;
        const payload = {
          title: snapshot.title,
          text:
            snapshot.text +
            '\n更新于：' +
            new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
          buttons: snapshot.buttons,
          layout: {
            ...snapshot.layout,
            notes: [...snapshot.layout.notes, `更新于：${cardTime(now)}（北京时间）`],
          },
        };
        db.prepare(
          `INSERT INTO outbox (outbox_id,logical_key,task_id,panel_id,card_version,message_id,operation,payload,state,created_at,owner_key,chat_id,next_retry_at,attempts)
        VALUES (?,?,NULL,?,?,?,?,?,'pending',?,?,?,?,?)`,
        ).run(
          randomUUID(),
          `feishu:panel:${panel.panel_id}:${panel.version + 1}`,
          panel.panel_id,
          panel.version + 1,
          message,
          message ? 'update' : 'send',
          JSON.stringify(payload),
          now,
          this.owner,
          this.chat,
          pending?.next_retry_at ?? 0,
          pending?.attempts ?? 0,
        );
        db.prepare(
          'UPDATE feishu_panels SET version=version+1,snapshot_hash=?,refresh_requested=0,next_refresh_at=?,core_hash=?,last_rendered_at=? WHERE panel_id=?',
        ).run(snapshot.hash, now + PANEL_REFRESH_MS, snapshot.coreHash, now, panel.panel_id);
        return true;
      })
      .immediate();
  }
}
