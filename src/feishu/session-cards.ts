import type { TaskStore } from '../tasks/store.js';
import type { StoredTask } from '../tasks/types.js';
import type { ProjectStore } from '../projects/store.js';
import { TaskError } from '../tasks/types.js';
import { cardTime, type CardLayout } from './card-layout.js';
import { DRAFT_TTL, shortText, topicTitle, type NoticeButton } from './conversation-ui.js';
import { taskStateNames } from './task-layout.js';
import { resultPages, resultMarkdown } from './result-pages.js';

const PAGE_SIZE = 4;
const base = (heading: string, project: string): CardLayout => ({
  version: 1,
  eyebrow: project,
  heading,
  theme: 'blue',
  alerts: [],
  sections: [],
  notes: [],
});
const pageGuard = (page: number, total: number) => {
  if (!Number.isSafeInteger(page) || page < 0 || page >= Math.max(1, Math.ceil(total / PAGE_SIZE)))
    throw new TaskError('列表已变化，请重新打开会话列表。');
};
export function sameConversation(a: StoredTask, b: StoredTask | null | undefined) {
  return (
    !!b &&
    a.owner_key === b.owner_key &&
    a.project_key === b.project_key &&
    a.conversation_id === b.conversation_id
  );
}
export function gatewaySessionCard(
  store: TaskStore,
  owner: string,
  projectKey: string | null,
  projectName: string,
  selected: StoredTask | null,
  page: number,
  chat?: string,
) {
  const groups = new Map<string, StoredTask[]>();
  for (const task of store
    .list(owner)
    .filter(
      (t) =>
        t.project_key === projectKey &&
        (!chat || store.conversations.get(t.conversation_id).chat_id === chat),
    )) {
    const key = task.conversation_id;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const groupsSorted = [...groups.values()]
    .map((group) =>
      group.sort((a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at),
    )
    .sort(
      (a, b) => Math.max(...b.map((t) => t.updated_at)) - Math.max(...a.map((t) => t.updated_at)),
    );
  pageGuard(page, groupsSorted.length);
  const layout = base('选择会话', projectKey ? `${projectName} · ${projectKey}` : projectName);
  layout.status = `第 ${page + 1}/${Math.max(1, Math.ceil(groupsSorted.length / PAGE_SIZE))} 页 · ${groupsSorted.length} 个会话`;
  const buttons: NoticeButton[] = [];
  for (const group of groupsSorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const task = group[0]!;
    const current = sameConversation(task, selected);
    const state =
      group.find(
        (t) => t.status === 'running' || t.status === 'starting' || t.status === 'unknown',
      ) ?? task;
    const output = store.result(task.task_id);
    const actions = [buttons.length];
    buttons.push({
      label: current ? '查看详情' : '接着聊',
      action: current ? 'details' : 'select',
      taskId: task.task_id,
      expiresAt: Date.now() + DRAFT_TTL,
    });
    layout.sections.push({
      title: `${current ? '当前 · ' : ''}${topicTitle(store, task)}`,
      text: shortText(output || task.prompt, 100),
      code: task.task_id,
      notes: [
        `${state.waiting_approval ? '等待审批' : state.waiting_input ? '等待输入' : taskStateNames[state.status]} · ${group.length} 轮`,
        `最近更新：${cardTime(Math.max(...group.map((t) => t.updated_at)))}`,
        '上方为任务 ID，用于 /状态、/继续 等命令。',
      ],
      actions,
    });
  }
  if (!groupsSorted.length)
    layout.sections.push({ title: '还没有会话', text: '返回当前面板后，直接发送需求即可开始。' });
  const nav = (label: string, target: number) =>
    buttons.push({
      label,
      action: projectKey === null ? 'projectless_sessions' : 'sessions',
      projectKey,
      choice: 'gateway',
      page: target,
      expiresAt: Date.now() + DRAFT_TTL,
    });
  if (page > 0) nav('上一页', page - 1);
  if ((page + 1) * PAGE_SIZE < groupsSorted.length) nav('下一页', page + 1);
  if (projectKey === null)
    buttons.push({
      label: '新建会话',
      action: 'projectless_new',
      expiresAt: Date.now() + DRAFT_TTL,
    });
  else
    buttons.push({
      label: '桌面会话（只读）',
      action: 'sessions',
      projectKey,
      choice: 'desktop',
      page: 0,
      expiresAt: Date.now() + DRAFT_TTL,
    });
  buttons.push({
    label: '当前面板',
    action: 'panel',
    choice: 'refresh',
    expiresAt: Date.now() + DRAFT_TTL,
  });
  layout.notes.push('切换只改变后续消息去向，不会启动任务。执行中的会话仍按顺序排队。');
  return { layout, buttons };
}
export async function desktopSessionCard(
  projects: Pick<ProjectStore, 'sessions'>,
  projectKey: string,
  projectName: string,
  page: number,
) {
  if (!Number.isSafeInteger(page) || page < 0 || page > 499)
    throw new TaskError('页码应为 1–500。');
  const result = await projects.sessions(projectKey, page * PAGE_SIZE, PAGE_SIZE);
  const layout = base(
    '桌面会话 · 只读',
    projectKey ? `${projectName} · ${projectKey}` : projectName,
  );
  const buttons: NoticeButton[] = [];
  if (!result.available) layout.alerts.push('项目路径失效，暂时无法可靠列出会话。');
  else {
    pageGuard(page, result.total ?? 0);
    layout.status = `第 ${page + 1} 页 · 共 ${result.total} 个会话`;
    for (const task of result.data)
      layout.sections.push({
        title: shortText(task.name || task.preview || '未命名桌面会话'),
        text: shortText(task.preview || '没有可用摘要', 100),
        code: task.id,
        notes: [
          `${{ notLoaded: '未加载', idle: '空闲', active: '执行中', systemError: '异常' }[task.status.type]} · 只读`,
          ...(task.updatedAt ? [`最近更新：${cardTime(task.updatedAt * 1000)}`] : []),
          '上方为会话 ID，用于桌面定位。',
        ],
      });
    if (!result.data.length)
      layout.sections.push({ title: '没有桌面会话', text: '可返回 Gateway 会话列表。' });
    for (const [label, target] of [
      ['上一页', page - 1],
      ['下一页', page + 1],
    ] as const)
      if (target >= 0 && target * PAGE_SIZE < (result.total ?? 0))
        buttons.push({
          label,
          action: 'sessions',
          projectKey,
          choice: 'desktop',
          page: target,
          expiresAt: Date.now() + DRAFT_TTL,
        });
  }
  buttons.push({
    label: '返回可继续会话',
    action: 'sessions',
    projectKey,
    choice: 'gateway',
    page: 0,
    expiresAt: Date.now() + DRAFT_TTL,
  });
  layout.notes.push('桌面会话仅供查看，不会接管或中断桌面执行。');
  return { layout, buttons };
}
export function copyIdCard(task: StoredTask): CardLayout {
  const layout = base('ID 信息', '任务与会话标识');
  layout.sections.push({
    title: '任务 ID · 用于飞书命令',
    code: task.task_id,
    notes: ['适用于 /状态、/继续、/打断 等命令。'],
  });
  if (task.thread_id)
    layout.sections.push({
      title: '会话 ID · 用于桌面定位',
      code: task.thread_id,
      notes: ['这是 Codex 会话 ID，不用于 /继续 命令。'],
    });
  else layout.notes.push('会话尚未建立，暂时没有会话 ID。');
  return layout;
}
export function resultCard(store: TaskStore, task: StoredTask, page: number) {
  const pages = resultPages(store.result(task.task_id));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages.length)
    throw new TaskError('结果页码已变化，请重新打开完整内容。');
  const layout = base(topicTitle(store, task), `${task.project_key ?? '无项目'} · 完整内容`);
  layout.status = `第 ${page + 1}/${pages.length} 页 · ${taskStateNames[task.status]}`;
  layout.sections.push({
    title: '回答正文',
    markdown: resultMarkdown(pages, page) || '尚未收到输出。',
  });
  layout.notes.push('这里展示当前保留的完整输出；执行中内容可能继续增长。');
  layout.sections.push({ title: '任务 ID', code: task.task_id });
  const buttons: NoticeButton[] = [];
  if (page > 0)
    buttons.push({
      label: '上一页',
      action: 'result',
      taskId: task.task_id,
      page: page - 1,
      expiresAt: Date.now() + DRAFT_TTL,
    });
  if (page + 1 < pages.length)
    buttons.push({
      label: '下一页',
      action: 'result',
      taskId: task.task_id,
      page: page + 1,
      expiresAt: Date.now() + DRAFT_TTL,
    });
  buttons.push({
    label: '查看详情',
    action: 'details',
    taskId: task.task_id,
    expiresAt: Date.now() + DRAFT_TTL,
  });
  return { layout, buttons };
}
