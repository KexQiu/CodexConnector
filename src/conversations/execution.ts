import type { GatewayConfig } from '../config/schema.js';
import type { RequestParams } from '../codex/protocol.js';
import { executableProject, checkoutRoot } from '../projects/store.js';
import { assertThreadPolicy, executionPolicy } from '../tasks/project-policy.js';
import { TaskError, type StoredTask } from '../tasks/types.js';
import type { TaskStore } from '../tasks/store.js';
import { ConversationDirectories } from './directories.js';
import { projectlessCandidateConfig } from './policy.js';
import { projectlessModel } from './capability.js';

export function executionTarget(store: TaskStore, config: GatewayConfig, task: StoredTask) {
  const conversation = store.conversations.owned(task.conversation_id, task.owner_key);
  if (conversation.cwd !== task.cwd || conversation.project_key !== task.project_key)
    throw new TaskError('任务与会话执行范围不匹配');
  if (conversation.scope_kind === 'project') {
    if (!task.project_key) throw new TaskError('项目已失效，请重新选择');
    const project = executableProject(config.projects, task.project_key, task.cwd);
    return {
      kind: 'project' as const,
      project,
      root: checkoutRoot(task.cwd),
      policy: executionPolicy(project, task.cwd),
      assert: (response: { approvalPolicy?: unknown; sandbox?: unknown }) =>
        assertThreadPolicy(project, task.cwd, response),
    };
  }
  if (task.project_key !== null || !conversation.chat_id) throw new TaskError('无项目会话归属无效');
  if (config.projectless?.enabled === false)
    throw new TaskError('本机已关闭无项目对话；历史仍可查看');
  new ConversationDirectories(config.dataDir).assert(conversation);
  const thread = {
    cwd: task.cwd,
    model: projectlessModel,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: { ...projectlessCandidateConfig, model_reasoning_effort: 'low' },
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
  } satisfies RequestParams<'thread/start'>;
  const turn = {
    cwd: task.cwd,
    model: projectlessModel,
    environments: [],
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  } satisfies Partial<RequestParams<'turn/start'>>;
  return {
    kind: 'projectless' as const,
    root: task.cwd,
    policy: { thread, turn },
    assert: (response: { approvalPolicy?: unknown; sandbox?: unknown }) => {
      const sandbox = response.sandbox as { type?: unknown; networkAccess?: unknown } | undefined;
      if (
        response.approvalPolicy !== 'never' ||
        sandbox?.type !== 'readOnly' ||
        sandbox.networkAccess !== false
      )
        throw new TaskError('普通聊天权限未生效');
    },
  };
}
