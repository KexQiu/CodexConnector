# M2：本地持久化任务闭环

> 验收日期：2026-09-17。结论：M2 通过。本阶段提供本地 CLI；飞书业务发送、交互审批和常驻服务分别由 M3–M5 实现。

## 1. 真实验收结果

固定 Node 24.15.0、pnpm 11.20.0、Codex 0.154.0-alpha.6.2，macOS arm64，Unix Socket。使用现有 Codex 登录，在私有临时目录运行无工具的有界模型任务。测试进程关闭 MCP、apps、plugins、hooks、多代理和桌面 notify，不修改全局配置，不读取或复制 auth.json，不发送飞书消息。

命令：`pnpm gate:tasks --live`。报告：[本机脱敏证据](../../.artifacts/m2/2026-09-17T03-59-06.461Z-ff33dd56/report.json)。原始数据库、备份、配置及调试日志保留在同一私有目录，不纳入版本管理。

| 用例                    | 结果 | 实际证据                                                                                                        |
| ----------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| 本地 CLI 新建           | PASS | queued → completed，读回 `M2_NEW_OK`                                                                            |
| 同一 request-key 重放   | PASS | 返回同一 task，重复运行 worker 后 turn/start 仍只有 1 次                                                        |
| 继续自有会话            | PASS | 沿用同一 thread，新 turn 完成并读回 `M2_CONTINUE_OK`                                                            |
| 执行中停止并重启 worker | PASS | 真实观察到 running 后发送 SIGTERM；本地转 unknown、保留 2 把锁；新 worker 恢复相同 turn 并读回 `M2_RECOVERY_OK` |
| 无重复执行              | PASS | 最终远端历史共 3 个 completed turn，本地也只有 3 次 turn/start，锁归零                                          |
| 只读发现项目和会话      | PASS | 找到临时配置项目及其会话，自动发现项目均无写权限                                                                |
| SQLite backup API 恢复  | PASS | 从备份打开 3 个 completed 任务，结果可读，quick_check 为 ok，文件权限合格                                       |
| 清理                    | PASS | 自有 App Server 进程退出，临时目录/socket 删除，真实 Home 的测试历史保留                                        |

这次覆盖 Gateway worker 重启且 App Server 仍存活。两个进程同时崩溃、机器重启及模型工具审批不属于本次真实验收。

## 2. 故障注入与回归

`pnpm verify` 通过类型、Lint、格式、73 项测试及构建。M2 新增 23 项，使用真实 SQLite 文件和本地 WebSocket 协议夹具；它们不冒充真实模型调用：

- 入队事务回滚，业务 request-key 去重及内容冲突拒绝；用户、项目、thread 归属隔离。
- 先写执行意图和原始 RPC ID，再允许请求字节发出；落盘失败时不发 RPC。
- 终态事件先于 turn/start response；绑定 ID 后补处理，迟到 response 不把终态改回 running。
- turn/start 已发送但回包丢失；任务保持 unknown，重启也不重提，继续占用 checkout/thread 锁及全局并发名额。
- inbox 应用失败后仍可按原事件重试，不能被唯一键吞掉；旧审批保留连接代次与数字/字符串 ID 区别。
- 单 worker 租约、已存活进程不可被抢占；重新派发前再次检查项目写权限。
- outbox 同一任务串行、旧版本合并、claim 过期与发送后结果未知分开处理；未知发送阻塞后续更新，核对回执后才能继续。
- 项目归属先按最深规范目录匹配再分页，worktree 分开，目录失效明确标记，配置别名歧义与 schema/cursor 漂移拒绝。
- 迁移校验和、较新 schema 拒绝、有效 WAL 备份恢复；doctor 不创建数据库、不迁移已有库。

## 3. 实现入口与事务边界

| 文件                                       | 职责                                                            |
| ------------------------------------------ | --------------------------------------------------------------- |
| `src/persistence/migrations/001_tasks.sql` | 正式 schema v1；Gateway 自有库，与 Codex 库隔离                 |
| `src/persistence/migrate.ts`               | 迁移事务、版本和校验和，拒绝未知已有表及不兼容结构              |
| `src/projects/store.ts`                    | project/list、thread/list 只读查询；本地白名单单独授权          |
| `src/tasks/store.ts`                       | 入队、状态、inbox、执行意图、归属、锁、输出、恢复与 worker 租约 |
| `src/tasks/worker.ts`                      | 固定 cwd/权限的新建与续跑；事件绑定、订阅恢复和精确 turn 核对   |
| `src/tasks/outbox.ts`                      | 待发送记录的版本、租约、失败分类和核对接口；尚无飞书发送器      |
| `src/cli/tasks.ts`                         | CLI 操作及结果脱敏；仅 `task --result` 显式输出模型正文         |
| `scripts/gates/tasks.mjs`                  | 通过构建后的 CLI 完成三次真实模型验收、备份及进程清理           |

执行顺序为：入队事务 → 派发事务（锁 + thread RPC 意图）→ thread/start 或 resume → 绑定 thread 与 turn/start 意图 → turn/start → 原子绑定 turn 并应用早到事件。任何数据库事务都不等待网络。

任务终态、锁释放及 outbox 快照在同一事务中提交。结果不确定时保留锁，状态只能通过该任务已知 turn 的事件或历史核对推进。RPC 的 `clientUserMessageId` 仅用于关联，未将它当成服务端幂等保证。

读取历史不等于订阅。恢复时先核对 thread/cwd，在写权限仍有效时调用 thread/resume 恢复订阅；legacy 读取 includeTurns，paginated 使用 thread/turns/list 并精确匹配 turn ID。权限撤销时仅尝试读取历史。[官方 App Server 说明](https://learn.chatgpt.com/docs/app-server)，具体 wire 字段以本项目固定版本的生成协议和 G2 证据为准。

## 4. 本地操作

先复制 `config/config.example.json` 为被忽略的 `config/gateway.local.json`，填写真实绝对路径及用户标识。目标项目设置 `remoteWrite: true`，codex.endpoint 指向独立 App Server；M2 不使用飞书 Secret，credentialsFile 保留路径即可。G1 的 `feishu.local.json` 是探针配置，不能直接作为 Gateway 配置。

首次准备本地目录，并在独立终端启动固定版本 App Server：

```sh
umask 077
mkdir -p "$HOME/.codex-feishu"
chmod 700 "$HOME/.codex-feishu"
/Applications/ChatGPT.app/Contents/Resources/codex app-server \
  --listen "unix://$HOME/.codex-feishu/app-server.sock" -c 'notify=[]'
```

socket 必须与配置一致；若已有监听，不删除其 socket 或启动第二个服务。此处是前台进程，M5 才安装 LaunchAgent。以下在项目根目录的另一终端执行：

```sh
export CODEX_FEISHU_CONFIG="$PWD/config/gateway.local.json"
pnpm config:check
pnpm run doctor --config "$CODEX_FEISHU_CONFIG"
pnpm dev projects
pnpm dev sessions --project YOUR_PROJECT_KEY --offset 0 --limit 20

# 将任务内容写到自己选择的私有文本文件
pnpm dev task-create --project YOUR_PROJECT_KEY \
  --request-key unique-request-001 --prompt-file /absolute/path/prompt.txt
pnpm dev worker --once --timeout 120
pnpm dev tasks
pnpm dev task TASK_ID --result

# 继续上面任务返回的自有 thread；每个新任务使用新的 request-key
pnpm dev task-create --project YOUR_PROJECT_KEY --thread-id OWNED_THREAD_ID \
  --request-key unique-request-002 --prompt-file /absolute/path/next-prompt.txt
pnpm dev worker --once --timeout 120
```

`task-create` 只入队，不自动执行；一个 worker 最多派发一个排队任务。它启动时先恢复已有任务，unknown 会阻止新任务派发。相同 request-key 和相同内容返回原任务；不同内容不能复用该 key。已有 GUI 会话只能查看，不能作为继续执行的目标。

`worker --once` 超时或收到 SIGTERM/SIGINT 时只关闭自身连接，不杀 App Server、不自动 interrupt 模型。仍在执行的任务标为 unknown 并保留锁。再次运行 worker 会恢复已知 turn 并等待；`recover [TASK_ID]` 只做一轮核对，不派发任务、不等待完成。退出码：0 为本次检查/执行成功，1 为命令错误或任务 failed，2 为存在 unknown，130 为收到终止信号。没有待派发任务时会返回 `dispatched: false`，不表示排队任务全已完成。

诊断与一致性备份：

```sh
pnpm dev state
mkdir -p "$HOME/.codex-feishu/backups"
chmod 700 "$HOME/.codex-feishu/backups"
pnpm dev db-backup --destination "$HOME/.codex-feishu/backups/manual-001.sqlite"
```

备份目标不能已存在。恢复时先停止 Gateway worker，再对全套运行库及 WAL/SHM 做受控替换；本阶段只提供 backup API 和备份打开验收，不提供覆盖在线数据库的恢复命令。数据库保存必要 prompt 和模型结果，必须按敏感文件管理。

## 5. 明确边界

- 如果 turn/start 回包丢失且尚未持久化 turn ID，即使收到其它早到事件，也不按“最新 turn”猜归属。任务保持 unknown，队列会阻塞；后续 M4 补充人工核对/解除流程，不能通过重发绕过锁。
- outbox 的 unknown 核对接口只接受上层已经独立确认的远端回执。M3 才实现飞书发送、限流分类和真实回执核对；目前没有证据就保持 unknown，不能从本地 outbox ID 推断远端未发送。
- M2 仅保存 agentMessage 完整输出，不做流式 delta 展示，不保存工具参数或原始 provider 错误到诊断。审批/用户输入请求会明确拒绝为暂不支持，不自动批准；交互体验在 M4 实现。
- 本阶段仅验证 Unix Socket 真实模型闭环；WebSocket 由本地夹具覆盖。双进程 SIGKILL、审批恢复、休眠唤醒、限流、24 小时试运行仍由 M4/M5 验收。
- G1 仍为 PARTIAL：真实文本、卡片和重连通过，平台自动重投待补测。M2 PASS 不改变 G1/G3 结论，也不等于飞书生产闭环上线。
