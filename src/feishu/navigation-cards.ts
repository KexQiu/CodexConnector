import {
  canExecuteProject,
  projectPermissionLabel,
  type ProjectAccess,
} from '../config/project-policy.js';
import type { TaskStore } from '../tasks/store.js';
import { TaskError } from '../tasks/types.js';
import { cardTime, type CardLayout } from './card-layout.js';
import { DRAFT_TTL, PROJECT_PAGE_SIZE, shortText, type NoticeButton } from './conversation-ui.js';
import { taskStateNames } from './task-layout.js';

const base = (heading: string, eyebrow: string): CardLayout => ({
  version: 1,
  heading,
  eyebrow,
  theme: 'blue',
  alerts: [],
  sections: [],
  notes: [],
});
export const navigationButtons = (): NoticeButton[] => [
  { label: '当前会话', action: 'panel', choice: 'refresh', expiresAt: Date.now() + DRAFT_TTL },
  { label: '任务列表', action: 'tasks', page: 0, expiresAt: Date.now() + DRAFT_TTL },
];

type Project = { key: string; name: string; available: boolean } & ProjectAccess;
export function projectPickerCard(
  projects: Project[],
  page: number,
  currentProject: string | null | undefined,
  draft: { id: string; prompt: string; expiresAt: number } | null,
  discoveryUnavailable: boolean,
  canCreate = false,
) {
  const pages = Math.max(1, Math.ceil(projects.length / PROJECT_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages)
    throw new TaskError('项目列表已变化，请重新发送 /项目。');
  const layout = base(draft ? '这项任务在哪个项目进行？' : '选择项目', '项目导航');
  layout.status = `第 ${page + 1}/${pages} 页 · ${projects.length} 个项目`;
  if (draft) {
    layout.sections.push({
      title: '已保存需求 · 尚未执行',
      text: shortText(draft.prompt, 180),
      notes: ['选择项目后开始执行，无需重发。', `有效至：${cardTime(draft.expiresAt)}`],
    });
  } else layout.notes.push('选择项目会准备一个新话题；随后直接发送需求即可。');
  if (discoveryUnavailable) layout.alerts.push('暂时无法发现其他桌面项目，已列出本机配置的项目。');
  const buttons: NoticeButton[] = [];
  const expiresAt = draft?.expiresAt ?? Date.now() + DRAFT_TTL;
  if (!draft) {
    layout.sections.unshift({
      title: currentProject === null ? '当前 · 无项目' : '无项目',
      text: '普通聊天：不读取文件、不执行命令、不调用外部工具；仅允许内置时钟。',
      actions: [0],
    });
    buttons.push({ label: '查看无项目会话', action: 'projectless_sessions', page: 0, expiresAt });
  }
  for (const project of projects.slice(page * PROJECT_PAGE_SIZE, (page + 1) * PROJECT_PAGE_SIZE)) {
    const selectable = project.available && canExecuteProject(project);
    const actions = selectable ? [buttons.length] : [];
    if (selectable)
      buttons.push({
        label: draft ? '在此执行需求' : '选择此项目',
        action: 'project',
        projectKey: project.key,
        draftId: draft?.id ?? null,
        expiresAt,
      });
    layout.sections.push({
      title: `${currentProject === project.key ? '当前 · ' : ''}${shortText(project.name, 80)}`,
      text: project.key,
      notes: [!project.available ? '路径失效 · 暂时不能执行' : projectPermissionLabel(project)],
      actions,
    });
  }
  if (!projects.length)
    layout.sections.push({
      title: '暂无项目',
      text:
        canCreate && !draft
          ? '点击「新建项目」，回复名称即可创建。'
          : '请在本机配置项目后重新打开列表。',
    });
  if (page > 0)
    buttons.push({
      label: '上一页',
      action: 'projects',
      page: page - 1,
      draftId: draft?.id ?? null,
      expiresAt,
    });
  if (page + 1 < pages)
    buttons.push({
      label: '下一页',
      action: 'projects',
      page: page + 1,
      draftId: draft?.id ?? null,
      expiresAt,
    });
  if (canCreate && !draft) buttons.push({ label: '新建项目', action: 'create_project', expiresAt });
  if (draft)
    buttons.push({ label: '取消这条需求', action: 'cancel_draft', draftId: draft.id, expiresAt });
  return { layout, buttons };
}

export function helpCard() {
  const layout = base('使用帮助', '从需求开始');
  const buttons: NoticeButton[] = [
    { label: '选择项目', action: 'projects', page: 0, expiresAt: Date.now() + DRAFT_TTL },
    ...navigationButtons(),
  ];
  layout.sections = [
    {
      title: '日常对话',
      text: '直接发送消息即可开始无项目聊天；需要处理文件时先选择项目。继续当前会话时，直接发送下一条消息即可。',
      notes: ['执行中的新消息会排到下一轮；回复任务卡时，以被回复的任务为准。'],
      actions: [0, 1],
    },
    {
      title: '查看与切换',
      text: '/当前 — 当前项目与会话\n/会话 — 选择当前项目的会话\n/任务 — 查看所有任务\n/额度 — 账号剩余额度\n/新话题 — 在当前项目开启独立会话',
      actions: [2],
    },
    {
      title: '任务控制',
      text: '/状态 任务ID — 查看详情\n/刷新 任务ID — 更新原任务卡\n/补充 任务ID 内容 — 补充到正在执行的任务\n/打断 任务ID — 请求停止任务',
      notes: ['任务 ID 可使用唯一的前 8 位或更长前缀。审批请使用对应任务卡的按钮。'],
    },
    {
      title: '更多用法',
      text: '/项目 — 项目列表\n/选择 项目key — 指定项目\n/会话 项目key [页码] — 指定项目的会话\n/任务 [页码] — 翻看历史任务\n/新建项目 名称 — 创建并选择项目\n/取消创建 — 退出项目名称输入\n/新建 项目key 内容 — 在指定项目开始任务\n/继续 任务ID 内容 — 继续指定会话\n/回答 审批ID 题号 答案 — 补充问题答案',
    },
  ];
  return { layout, buttons };
}

const TASKS_PER_PAGE = 4;
export function taskListCard(
  store: TaskStore,
  owner: string,
  projects: { key: string; name: string }[],
  selectedTaskId: string | null | undefined,
  page: number,
  chat?: string,
) {
  const tasks = store
    .list(owner)
    .filter((task) => !chat || store.conversations.get(task.conversation_id).chat_id === chat)
    .sort((a, b) => b.updated_at - a.updated_at || b.task_id.localeCompare(a.task_id));
  const pages = Math.min(500, Math.max(1, Math.ceil(tasks.length / TASKS_PER_PAGE)));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages || page > 499)
    throw new TaskError('任务列表已变化，请重新发送 /任务。');
  const layout = base('任务列表', '我的任务 · 按最近更新排序');
  layout.status = `第 ${page + 1}/${pages} 页 · ${tasks.length} 个任务`;
  const buttons: NoticeButton[] = [];
  for (const task of tasks.slice(page * TASKS_PER_PAGE, (page + 1) * TASKS_PER_PAGE)) {
    const actions = [buttons.length];
    buttons.push({
      label: '查看详情',
      action: 'details',
      taskId: task.task_id,
      expiresAt: Date.now() + DRAFT_TTL,
    });
    layout.sections.push({
      title: `${task.task_id === selectedTaskId ? '当前 · ' : ''}${shortText(task.prompt) || '未命名任务'}`,
      fields: [
        {
          label: '状态',
          value: task.waiting_approval
            ? '等待审批'
            : task.waiting_input
              ? '等待补充输入'
              : taskStateNames[task.status],
        },
        {
          label: '项目',
          value: shortText(
            projects.find((p) => p.key === task.project_key)?.name ?? task.project_key ?? '无项目',
            80,
          ),
        },
      ],
      code: task.task_id,
      notes: [
        `最近更新：${cardTime(task.updated_at)}`,
        '上方为任务 ID；查看详情不会启动或切换任务。',
      ],
      actions,
    });
  }
  if (!tasks.length)
    layout.sections.push({ title: '暂无任务', text: '选择项目后，直接发送需求即可开始。' });
  if (page > 0)
    buttons.push({
      label: '上一页',
      action: 'tasks',
      page: page - 1,
      expiresAt: Date.now() + DRAFT_TTL,
    });
  if (page + 1 < pages && page < 499)
    buttons.push({
      label: '下一页',
      action: 'tasks',
      page: page + 1,
      expiresAt: Date.now() + DRAFT_TTL,
    });
  buttons.push(
    tasks.length
      ? navigationButtons()[0]!
      : { label: '选择项目', action: 'projects', page: 0, expiresAt: Date.now() + DRAFT_TTL },
  );
  if (tasks.length > 500 * TASKS_PER_PAGE)
    layout.notes.push('列表最多展示最近更新的 2,000 个任务；更早任务可用 /状态 任务ID 查询。');
  layout.notes.push('每轮需求单独列出；按会话合并查看请使用 /会话。');
  return { layout, buttons };
}

export function operationCard(
  title: string,
  message: string,
  theme: CardLayout['theme'],
  next: string,
  fields?: { label: string; value: string }[],
) {
  const layout = base(title, '操作反馈');
  layout.theme = theme;
  layout.sections = [{ title: '处理结果', text: message, ...(fields ? { fields } : {}) }];
  layout.notes = [next];
  return layout;
}
