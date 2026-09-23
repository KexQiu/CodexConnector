import type { TaskStore } from '../tasks/store.js';
import type { StoredTask } from '../tasks/types.js';
import { StatusMetrics } from '../tasks/status-metrics.js';
import { taskFailureDescription } from '../tasks/presentation.js';
import { topicTitle, shortText } from './conversation-ui.js';
import { cardTime, type CardLayout } from './card-layout.js';
import { sessionSections } from './metrics-layout.js';
import { resultPages, resultMarkdown } from './result-pages.js';

export const taskStateNames = {
  queued: '排队中',
  starting: '启动中',
  running: '执行中',
  completed: '执行完成',
  failed: '执行失败',
  interrupted: '已打断',
  unknown: '结果待核对',
};
export function taskLayout(
  store: TaskStore,
  task: StoredTask,
  projectName: string,
  details = false,
): CardLayout {
  const result = store.result(task.task_id);
  const pages = resultPages(result);
  const layout: CardLayout = {
    version: 1,
    eyebrow: `${shortText(projectName, 80)} · ${task.project_key}`,
    heading: topicTitle(store, task),
    status: task.waiting_approval
      ? '等待审批'
      : task.waiting_input
        ? '等待补充输入'
        : taskStateNames[task.status],
    theme:
      task.waiting_approval || task.waiting_input || task.status === 'unknown'
        ? 'orange'
        : task.status === 'completed'
          ? 'green'
          : task.status === 'failed'
            ? 'red'
            : 'blue',
    alerts: [
      ...(taskFailureDescription(task) ? [taskFailureDescription(task)] : []),
      ...(task.status === 'unknown' ? ['正在核对执行结果，锁仍保留，请勿重复提交。'] : []),
      ...(task.waiting_approval ? ['等待审批，请先核对任务卡中的操作范围。'] : []),
      ...(task.waiting_input ? ['等待补充输入，请查看任务卡中的问题。'] : []),
    ],
    sections: [
      ...(shortText(task.prompt) !== topicTitle(store, task)
        ? [{ title: '本轮需求', text: shortText(task.prompt, 120) }]
        : []),
      ...(details
        ? sessionSections(
            new StatusMetrics(store, task.owner_key),
            task.thread_id,
            task.turn_id,
            task.project_key,
            task.cwd,
            true,
          )
        : []),
      ...(result
        ? [
            {
              title: task.status === 'completed' ? '执行结果' : '最近输出',
              markdown: resultMarkdown(pages, 0),
              notes:
                pages.length > 1
                  ? [`正文第 1/${pages.length} 页；点击「查看完整内容」继续阅读。`]
                  : [],
            },
          ]
        : []),
    ],
    notes: [
      ...(task.status === 'queued'
        ? ['需求已保存，等待执行。普通消息会按顺序继续当前选中话题。']
        : []),
      ...(task.status === 'running' ? ['正在处理。普通消息排到下一轮，不会中断当前任务。'] : []),
      ...(task.status === 'completed' ? ['模型执行已结束，需求是否满足仍需验收。'] : []),
      '当前选中的会话可直接输入；回复本卡可继续这个话题。',
    ],
  };
  layout.sections.push({
    title: '任务 ID',
    code: task.task_id,
    notes: ['用于 /状态、/继续 等命令。'],
  });
  if (details) {
    const delivery = store.db
      .prepare(
        "SELECT state FROM outbox WHERE task_id=? AND state IN ('failed','unknown') ORDER BY card_version DESC LIMIT 1",
      )
      .pluck()
      .get(task.task_id);
    if (delivery === 'failed')
      layout.alerts.push('通知投递失败，请在本机查看 outbox；不影响模型任务终态。');
    if (delivery === 'unknown') layout.alerts.push('通知结果待核对，不会盲目重发。');
    if (task.thread_id)
      layout.sections.push({
        title: '会话 ID（thread）',
        code: task.thread_id,
        notes: ['用于桌面定位；飞书 /继续 使用上方任务 ID。'],
      });
    layout.sections.push({
      title: '任务信息',
      text: `目录：${task.cwd}\nturn：${task.turn_id ?? '待绑定'}`,
      notes: [
        `创建于：${cardTime(task.created_at)}（北京时间）`,
        `更新于：${cardTime(task.updated_at)}（北京时间）`,
      ],
    });
  }
  return layout;
}
