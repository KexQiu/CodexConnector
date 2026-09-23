# Codex × 飞书：本机 Gateway 技术契约

> 修订日期：2026-09-15，M0 契约对齐。
> 本文定义实现必须遵守的行为，不能将整个设计视为已上线。M0–M3 阶段功能已验收；M3 采用多轮真实证据，范围及未覆盖项见 [M3 验收](./docs/gates/M3-gateway.md)。M4 审批、输入和控制已实现第一轮，实际范围与剩余验收见 [M4 报告](./docs/gates/M4-interactions.md)；G1 平台自动重投和常驻部署仍待完成。
> [立项说明](./PROJECT_CHARTER.md) · [技术选型](./TECH_STACK.md) · [开发计划](./DEVELOPMENT_PLAN.md)

## 1. 目标和边界

飞书作为个人 Mac 上 Codex 的控制与通知入口。Gateway 校验身份、记录任务、调度请求和发送通知；本机 Codex 运行代理、执行工具和读写工作目录，模型推理调用其配置的模型服务。

V0.1/V0.2 支持查看项目/历史，创建、继续 Gateway 自有会话，补充、打断、人工审批、用户输入和终态卡片。GUI 原 thread 接管、历史 fork、多人控制、公网 app-server、自动批准均不在第一期范围。GUI 通知作为 V0.3，由 G3 单独验证。

9 月 11 日历史探针只验证了部分握手/列表行为。9 月 17 日已完成 [G2 的真实 RPC 验收](./docs/gates/G2-rpc.md)；G1 消息、卡片及重连通过，平台自动重投仍未观测，整体为 PARTIAL；GUI 通知尚未验收。当前版本与未覆盖项以门禁报告和开发计划为准，不在本文保存会话数量、内部库文件名或机器特定二进制路径。

## 2. 进程职责

```text
飞书单聊/卡片
    │ 官方 SDK 长连接
    ▼
FeishuAdapter → Domain → CodexRpc → 独立 Codex App Server
                    │                  │
                    ▼                  ▼
              Gateway SQLite      专用/已登记 checkout

ProjectStore → Codex 元数据只读适配 / 已验证的历史 RPC
GUI notify → bridge → 本地通知收件箱（V0.3）
```

- launchd 分别拥有 Gateway 和独立 App Server。Gateway 负责连接/重连，不自行创建第二个常驻 App Server。
- GUI 的进程和会话由 GUI 自己管理；独立 App Server 不是 GUI 标签页的控制接口。
- M1 探针可以启动自己拥有的临时进程，并在退出时清理；不能停止不属于探针的进程。
- Gateway 只连接 Unix socket 或 loopback。Unix socket 上使用 WebSocket HTTP Upgrade 和分帧，不能按普通流逐行读 JSON。[官方协议](https://learn.chatgpt.com/docs/app-server)
- socket 必须位于当前用户的私有目录。只有确认没有活跃监听、所有权正确且路径不是符号链接后，服务所有者才能清理遗留 socket。

## 3. 术语和唯一业务模型

类型定义位于 [领域模型](./src/domain/model.ts)，RPC 字段来自 [版本生成目录](./src/codex/generated/manifest.json)。M0 定义模型，业务记录的持久化在 M2 落实。

| 名称     | 定义                         | 需要持久化的关联                                                            |
| -------- | ---------------------------- | --------------------------------------------------------------------------- |
| thread   | 多轮交互的长期 Codex 会话    | threadId、Gateway 归属、tenant/app/open_id、projectKey、规范化 cwd          |
| task     | Gateway 接受的一次用户提交   | taskId、业务 requestKey、归属、项目/cwd、可空 threadId/turnId、状态         |
| turn     | Codex 针对一次输入执行的一轮 | 对应 task、threadId、turnId                                                 |
| approval | 一次需要用户决策的服务端请求 | Gateway approvalId、connectionEpoch、原始 RPC ID 类型和值、task/thread/turn |

创建 thread 不等于开始 turn；连接成功不等于任务已执行。列表中的任意历史 thread 不能自动获得写入权限。续跑前必须重新校验持久化的归属、用户身份、项目和 cwd。

## 4. 状态机

唯一任务状态集合：

```text
queued → starting → running → completed | failed | interrupted
               └────────────→ completed | failed | interrupted
          starting / running → unknown
          unknown → running | completed | failed | interrupted
```

- queued 可以在未派发前取消为 interrupted，或本地明确拒绝为 failed。
- starting 允许直接进入终态，因为事件可能早于 turn/start response。
- waiting.approval 和 waiting.userInput 是独立标志，不能替代任务状态；等待期间仍占用执行锁。
- 启动失败使用 failed + failurePhase（thread_start/turn_start）；执行失败使用 execution。不能在 RPC 超时后仅凭没有 turnId 判定失败。
- unknown 不是终态，不能回到 queued/starting 自动重提；只有权威事件、历史核对或明确记录的人工处置能解决它。
- completed/failed/interrupted 不回退；重复同状态事件可以幂等处理，迟到 response 不能改回 running。
- turn/completed 或可确认的历史 turn 终态用于结算已启动任务。interrupt response 不等于 interrupted 已发生。
- completed 只表示这一轮执行结束，代码质量和用户需求验收另行判断。

状态迁移必须用事务内条件更新。内存状态检查不能替代数据库中的并发约束。

## 5. 唯一任务提交顺序

本节取代旧版本第 5、16 节相互矛盾的流程，后续实现不再维护另一份提交伪代码。

1. 校验原始事件身份、操作者、命令、项目权限与卡片关联。project key 精确匹配本地注册；cwd 经 realpath 与目录边界校验。
2. **事务 A**：按 tenant/app/source/eventId 或受控 nonce 去重，写入 inbox 与待执行 command，并创建 queued task 或关联既有 task；提交成功后才向飞书返回成功确认。
3. 调度器取出未处理命令，重新校验写权限、归属和执行目录。**事务 B**：占用 checkout 排他锁及已有 thread 的排他锁，设置 starting，保存第一项 rpc_operation 执行意图；提交后才发 RPC。
4. 新任务发 thread/start，续跑发 thread/resume；两者显式应用 cwd 和固定权限。连接从初始化后持续消费消息，不能等待 start 返回才启动事件路由。
5. 收到 thread response 后，**事务 C**：绑定 threadId、保存归属和 cwd、补齐 thread 锁，保存 turn/start 意图；提交后调用 turn/start。
6. 收到 turn response 后，**事务 D**：原子绑定 turnId、处理早到事件，只有任务尚未终态时才推进 running；写入相应版本的卡片 outbox。
7. 后续权威终态事件在短事务内更新 task、command/rpc_operation、释放对应执行锁并写 outbox。通知发送在事务之外进行。

以上事务独立提交，数据库写锁不得跨越网络、模型执行或人工等待。新建 thread 返回前依靠稳定 checkout 锁隔离，随机 taskId 本身不能充当目录排他锁。

| 结果                                  | 行为                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| 入站事务失败                          | 不成功确认；保留可重投语义，SDK 的实际行为必须由 G1 验证            |
| 明确尚未发送 / 服务端明确拒绝且未执行 | 按错误类别决定受控重试或 failed，保留 operation 记录                |
| thread 已创建、turn 明确启动失败      | 保存 threadId，标记 failed/turn_start；重新发起属于新的显式用户提交 |
| RPC 超时、断线、返回无法解释          | 保留执行意图，任务 unknown，继续占用 thread/checkout，核对后决定    |
| 早到事件暂时没有 task 映射            | 保存为待关联事件，后续绑定后处理，不提前标记 processed              |

外部 RPC、飞书 API、本地事务不能原子提交，不承诺跨系统 exactly-once。requestKey、clientUserMessageId 或 outboxId 是否具有服务端幂等保证，必须有固定版本协议证据，不能自行假定。

## 6. 数据存储契约

Gateway 独立维护 `~/.codex-feishu/gateway.sqlite`。M0 验证连接/事务/备份能力；M2 已实现业务表、Repository 和迁移，M3 新增飞书命令、目标、动作与运行租约。实际 DDL 以 [编号迁移](./src/persistence/migrations) 为准：M4 扩展到 v3，交互优化第一批扩展到 v4，状态面板扩展到 v5，状态指标扩展到 v6；2026-09-23 已完成生产迁移和服务切换，原有业务记录核对一致。下面定义职责约束，后续里程碑会继续扩展实现。

| 逻辑存储                         | 必须覆盖的字段或行为                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| threads / tasks                  | 第 3、4 节身份、目录和状态；turnId 在回包前允许为空                                   |
| inbox / commands                 | 业务唯一键、必要 payload、received/processed/failed、错误和重试状态；存在不等于已处理 |
| rpc_operations                   | 本地 operationId、方法、意图、连接代次、request ID、发送和已知/未知结果               |
| approvals                        | 第 3 节关联、有效性、决定、过期时间、对应卡片；不能只以 RPC ID 作全局主键             |
| outbox                           | 逻辑操作唯一键、task、目标 messageId、卡片版本、claim、attempts、nextRetryAt、结果    |
| execution_locks                  | 规范化 checkout/thread 锁键、所有 task；starting/running/unknown 保留占用             |
| user_context                     | tenant/app/open_id 下的项目和任务选择；被回复卡片的关联优先于最近选择                 |
| feishu_drafts                    | 绑定用户和单聊的待选项目需求、有效期、消费状态及结果 task；消费和任务创建必须同事务   |
| feishu_commands / feishu_actions | 消息首次解析后的固定路由；服务端 nonce 绑定的项目/草稿/任务动作及原消息身份           |
| feishu_panels                    | 用户/单聊唯一面板、已确认消息 ID、展示版本/摘要、创建时间和刷新标记；不作为路由来源   |

交互规则见 [第一批交互实现](./docs/INTERACTION_UX.md)：首次未选项目时保留需求并引导选择；普通消息按当前话题继续，运行中排队；切换项目或新话题不改变已经保存消息的目标。项目按钮只能选择授权范围，桌面自动发现不授予执行权限。

Gateway 采用 WAL、FULL、外键和有界 busy timeout。编号迁移和 schema 校验失败均停止写服务；遇到未知较新 schema 不允许旧程序继续写。所有业务 SQL 参数化，事务内用唯一键/条件更新维护不变量。

Codex 数据库使用独立只读连接，不做迁移、不改 journal_mode、不对活跃库使用 immutable。内部 schema 先探测再读取，项目按规范化 cwd 关联，处理 project_id 为空、分页、嵌套目录和独立 worktree。失败时显示降级原因，不自动修改或重建 Codex 状态库。

只读约束针对 Gateway 的数据库访问适配层；真实 App Server 自己可能写入其会话与状态记录，不能描述成所有操作完全无写入。

## 7. 事件、重连与恢复

RPC 客户端通过属性存在性识别 id，数字 0 有效；区分 result/error response、带 method/id 的服务端请求、无 id 的通知。消息格式以固定 CLI 生成类型为准，不手写完整 union。[协议生成脚本](./scripts/generate-protocol.mjs)

持久事件同时保存处理状态。唯一键冲突时，如果旧记录尚未处理，应继续恢复处理；流式 delta 不按文本 hash 去重。终态按 threadId+turnId 去重，按钮按受控业务 nonce 去重，不能套用同一泛化规则。

启动先校验配置和数据库版本，建立事件消费/订阅，再核对未终态任务和断线窗口，最后恢复派发。恢复分两种情况：

- App Server 仍存活：核验 loaded 状态、当前 turn、订阅和 pending requests；旧连接审批 ID 不直接发送给新连接。
- App Server 也重启：补读历史用于确认终态，无法确定则保持 unknown；读取历史不等于恢复实时订阅或继续同一生成点。

新 RPC 写调用在连接未就绪时停止派发。历史列表、只读诊断可以保留；队列和锁不能因为重连次数耗尽而被清空。

## 8. 审批、补充和打断

审批按生成的 commandExecution、fileChange、permissions 请求分别编码；permissions 的选择不是统一 accept 字符串。用户输入与 MCP elicitation 采用各自协议。未实现的服务端请求需要明确错误/取消路径，不能静默悬挂。

审批卡仅带受控 approvalId、taskId、action nonce 和选择值。服务器重新读取完整上下文，校验操作者、有效性、连接代次和 task/thread/turn 关联，保证一次有效决定；不信任卡片传回的 cwd 或权限范围。

serverRequest/resolved、终态、断连和超时使对应旧卡失效。不自动批准失效请求，不把旧 request ID 回到新连接；实际重新呈现能力由 G2 决定。

steer 使用当前 turn 的 expectedTurnId；interrupt 使用 threadId/turnId 并等待终态。turn/start 的回包不保证执行循环已就绪；starting 阶段的控制应先核对执行事件，处理 no active turn 竞态。steer 与完成竞态时提示已结束，不静默转换为新 turn。首期不自动合并用户补充文本。

## 9. 飞书消息、卡片与背压

采用官方 Client/WSClient/EventDispatcher，新版卡片回调以安装 SDK 和真实租户 payload 为准。确认由 handler 的真实响应机制处理，不存在本文自定义的 acknowledgeAction HTTP API。

首期命令覆盖项目、会话、新建、继续、状态、刷新、补充、打断和审批。短 ID 必须唯一；普通文本只有在明确关联到当前用户拥有的任务/会话时才可作为输入。

初始最大执行并发为 1；waiting 和 unknown 仍占名额。超载时持久化排队或明确拒绝，不能确认后丢弃；队列上限与拒绝方式必须有可观测结果。

卡片分进行中、终态、审批/输入三类。终态展示项目、目录、thread/turn、状态、耗时、回复摘要和文件变更摘要；正文与按钮不泄露凭据。

同一消息更新串行化，校验单调卡片版本，避免旧 PATCH 覆盖新状态。新建卡片 response 丢失不盲目重发；原消息删除后重建是独立记录的操作。对已绑定原卡、PATCH 未决超过 60 秒且任务已终态的情形，可另建一条无按钮的终态补充通知，用任务级唯一键去重。原 PATCH 保留 unknown，原卡仍可能过时；新通知不替换原卡绑定，不重放旧更新。该规则不适用于初始 POST 未决或仍在运行的任务，补充通知自身回包丢失仍按回执核对处理。按 SDK 的 HTTP/业务错误码区分限流、暂时故障、权限问题和结果不确定，防止 SDK 重试与 outbox 叠加失控。

当前项目与会话面板见 [实现契约及操作](./docs/CONTEXT_PANEL.md)。schema v5 的 `feishu_panels` 仅保存展示和回执关联，`user_context` 与任务记录继续决定普通消息去向；同一 owner/chat 维护一张自动更新卡，显式查询另外返回最新快照。面板投递使用独立串行队列，未知结果先核对、不盲目重发；第 13 天更换卡片，按钮每 12 小时续期。菜单事件 `application.bot.menu_v6` 仅将三个授权事件键映射到固定命令，不把未知菜单值作为模型输入。面板导航重新核对服务器保存的项目和任务；选中态变化后拒绝旧卡的新话题/详情操作。本功能使用单聊状态卡与菜单入口，不调用群置顶接口。

## 10. 项目隔离与权限

schema v6 的 `session_metrics` 和 `account_metrics` 分别保存授权会话的白名单统计及当前账号额度快照，具体口径见 [状态指标说明](./docs/STATUS_METRICS.md)。账号额度是账号共享窗口，不能从会话 Token 推算；缺失值不当作零，过重置时间不自行推断可用。身份变更丢弃旧账号在途结果，只读元数据查询不恢复或执行会话。后台轮询和显示失败不改变任务路由及审批决策。

显示目录不等于授权目录。写入仅允许显式登记、remoteWrite 为 true 的规范化路径；禁止字符串前缀匹配，用路径边界判断，派发前核验目录仍有效。

同一 checkout 只有一个 Gateway 写任务，即使 thread 不同。独立 worktree 可提供文件隔离，但需独立登记。Gateway 锁不能阻止 GUI 或人工写同一目录，远程写任务优先使用专用 checkout。

新建和续跑显式使用 workspace-write、on-request、人工 reviewer。按钮只回授用户选定权限，不提供任意 cwd、shell 或 danger-full-access 入口。身份以 tenant/app/open_id 组合校验，不用替代 ID 类型绕过白名单。

## 11. 配置、路径与诊断

Gateway 配置格式为 JSON，见 [样例](./config/config.example.json) 与 [Zod Schema](./src/config/schema.ts)。Codex 自己的 TOML 保持独立。

`~/.codex-feishu` 和下级运行目录权限 700，凭据、数据库、WAL/SHM、备份和敏感日志权限 600。安装时发现二进制绝对路径。样例没有真实凭据；M0 配置检查只验证结构，不读取 credentials.json，也不证明路径/飞书权限就绪。

结构化日志关联 task/thread/turn/operation，默认排除完整 prompt、消息、审批正文和 SDK 原始 payload。必要恢复事实写数据库。M5 已实现监督日志按 5 MiB 轮转、当前文件外保留 5 份，可通过 service 配置调整；业务恢复仍依靠数据库。默认 30 天后仅对已终态且无未决操作的内容分批逻辑清理，保留去重墓碑及 unknown 证据；在线备份默认 24 小时一次、保留 7 份。详见 [M5 部署与试运行](./docs/gates/M5-deployment.md)。

M0 的 `pnpm run doctor` 只检查本机版本和依赖加载。后续再增加数据库运行状态、RPC initialized、飞书连接、outbox 和 socket 诊断。必须显式使用 run，避免调用 pnpm 自带的 doctor。

## 12. GUI 通知扩展

G3 先观察实际 GUI 调用的 argv 与可用 stdin，保存原命令数组并提供恢复路径。读取有界、不盲等 EOF；原始参数原样转发，不能把手工传入 JSON 的模拟脚本当成真实调用契约。

bridge 原通知与 Gateway 转发失败隔离，新增请求使用短超时。通知入口仅 loopback，校验令牌、JSON 和最大 256 KiB body，先持久化后确认；不得从 payload 发起执行操作。

需要 Gateway 离线期间不漏通知时，bridge 写本地 spool 并由 Gateway 补投；否则明确为尽力通知。去重使用实际 thread/turn/事件身份；payload hash 只供审计。

正常完成、失败、打断分别实测，只开放实际支持的事件。G3 失败只阻塞 V0.3。

## 13. 部署、停止与回滚

两个 LaunchAgent 的 ProgramArguments 使用绝对路径，Gateway 运行 dist。launchd 只负责进程保活，不依赖服务启动顺序或 HTTP 检查自动完成依赖管理；Gateway 负责退避连接。

plist 的 Umask 用整数 63 表示八进制 077，并经 plutil 校验。安装/卸载只管理自己的服务，不删除用户数据库。LaunchAgent 需要登录；未登录、休眠和网络切换的可用性以本机实测为准。

SIGTERM 时暂停派发、结束短事务、关闭自身资源，不停止 GUI；退出不无限等待人工审批。SIGKILL 后依靠持久意图和核对恢复，不重跑 unknown。

升级前排空或明确处理 active/unknown 任务，用 SQLite backup API 或受控一致性备份。恢复检查完整性与业务状态，不只复制活跃 WAL 主库。回滚核对旧二进制与当前 schema 兼容，不兼容则停止并走明确恢复流程，不盲用旧程序写新库。

## 14. 验收与实施状态

M0 只落实工程、类型、配置边界、SQLite 基础能力与本文契约。业务表/迁移、任务调度、RPC 连接、飞书消息和部署不因本文完善而视为已实现。

G2 验证真实 RPC 生命周期和恢复；G1 验证真实消息/卡片及落库后 ACK；G3 验证 GUI 通知。各门禁记录 PASS/FAIL/BLOCKED、版本、脱敏证据和未覆盖项。

M2–M5 覆盖重复投递、结果未知、早到事件、旧卡片、审批失效、同目录并发、数据库不可写、SIGKILL 和备份恢复。实际命令与检查点以 [开发计划](./DEVELOPMENT_PLAN.md) 为准。
