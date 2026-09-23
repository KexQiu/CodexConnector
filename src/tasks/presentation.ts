import type { StoredTask } from './types.js';

/** Only controlled explanations reach the chat; never render raw RPC error messages. */
export function taskFailureDescription(task: StoredTask): string {
  if (task.status === 'unknown' && task.error_code === 'thread_writer_conflict')
    return '会话被其他 Codex 进程占用，无法恢复订阅。任务结果待核对、锁仍保留；请在本机协调占用后恢复，不会重跑任务。';
  if (task.status !== 'failed' || !task.failure_phase) return '';
  if (task.error_code === 'model_refused') return '模型明确拒绝了本次请求，任务未按要求完成。';
  if (task.error_code === 'thread_writer_conflict')
    return '会话被另一个 Codex 进程占用，本次模型任务尚未启动。请在本机处理会话占用后再发起续跑；系统不会自动重试。';
  const phase = {
    thread_start: task.thread_id ? '恢复会话' : '新建会话',
    turn_start: '提交模型任务',
    execution: '模型执行',
  }[task.failure_phase];
  return `失败阶段：${phase}。请在本机查看该任务的诊断记录。`;
}
