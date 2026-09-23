# M4：审批、控制与恢复

> 更新：2026-09-20。**M4 阶段功能验收 PASS，运行里程碑为 M4。** 158 项本地测试通过；真实审批、输入、手机控制、异常恢复、独立终态通知及桌面人工交接由下述多轮证据共同覆盖。失败和超时记录保留，不宣称整套探针单轮通过。M5 部署/试运行尚未开始，G1 平台自动重投仍为 PARTIAL。汇总见 [M4 证据索引](./M4-evidence.json)。

## 已实现的行为

| 模块                                | 行为                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `tasks/interaction-policy.ts`       | 按 command、file、permissions、requestUserInput 分别校验和编码；使用生成的响应类型检查映射   |
| `tasks/interactions.ts`             | 保存请求、连接代次、原 RPC ID 类型、用户决定、逐题答案和回包意图；旧连接请求不能在新连接回包 |
| `tasks/controls.ts`                 | 持久化补充/打断队列，绑定 task 和当前 turn；提交前保存 RPC 意图；不确定结果不重发            |
| `feishu/inbound.ts` / `commands.ts` | 白名单校验后持久化按钮或文本命令；按钮只携带随机 nonce，从数据库读取真实任务、审批和选择     |
| `feishu/sender.ts`                  | 展示等待状态、审批/输入及控制结果；已终态任务的未知 PATCH 超时后独立补充终态通知             |
| `003_interactions.sql`              | schema v3；保留旧任务和动作，增加审批上下文、响应状态、工具观察记录及控制队列                |

命令审批只提供请求允许的本次 `accept`、`decline`、`cancel`；不提供 `acceptForSession` 或修改永久规则的按钮。文件审批需要提前观测到对应 item 的文件变更，冻结路径、移动目标与 diff，并在提交前重新检查目录。权限审批返回选定的原请求子集和 `scope: turn`，可选择全部所列权限、仅网络或仅文件权限；不会凭按钮提供的新路径扩权。

文件路径按当前 checkout 及真实祖先路径校验，拒绝通过符号链接逃出项目的路径。当前不支持跨项目授权、glob/special 文件系统权限条目、远端 environment、会话级授权、包含 `isSecret` 的输入问题及无法完整展示的大请求；明确返回错误，不自动批准。文件变更明细缺失也会拒绝，不能仅凭理由批准无法审查的内容。

用户输入最多三题。`/回答` 按题号保存答案，全部问题已回答才按原 question ID 返回 `answers`；选项受原问题约束，取消使用空答案映射。答案保存在权限为 600 的 Gateway 数据库中，不应把此入口当作密钥输入通道。MCP elicitation 返回取消；动态工具返回 `success: false`；其他未实现请求返回 RPC 错误。独立 App Server 不因此拥有桌面应用的 GUI 工具。

## 操作

前台启动方式及专用单聊配置沿用 [M3 操作](./M3-gateway.md)。新命令：

```text
/补充 任务ID 补充指令
/打断 任务ID
/回答 审批ID 题号 答案
```

任务 ID 和审批 ID 至少输入唯一的前 8 位。审批直接在对应任务卡上选择；文本命令若同时引用卡片，指定任务必须与引用对象一致。`/补充` 使用 `expectedTurnId`，已结束或不支持引导的 turn 返回未执行，不创建新 turn。`/打断` 的成功回包仅说明已发出请求，仍等待真实终态事件再释放锁。

请求默认有效 15 分钟；requestUserInput 若提供更短超时，则采用该超时。到期会明确结束仍待处理的 RPC 请求，旧按钮不再回包。收到 `serverRequest/resolved`、turn 结束、断线或进程重启都会使旧操作失效。已向 socket 写出响应只记作 `sent`，不当作服务端确认；没有确认即断线的响应记录为 unknown，不自动重复授权。

## 恢复与通知边界

- worker 新连接先订阅会话，再核对精确 turn 的快照；同一连接已订阅的会话只核对快照，不重复 resume。会话关闭事件清除订阅记录，后续才重新订阅。订阅失败且历史仍为 inProgress 时保留 unknown 和锁；确认终态后才释放锁。没有 turn ID 不是“未执行”的证据，不按时间猜测最近 turn。
- App Server 不可用时，飞书可以保持只读状态查询；RPC 恢复前不派发模型任务。数据库或单实例租约错误不会被当作普通离线而忽略。
- SIGTERM 关闭自有连接并释放租约；SIGKILL 后依据进程存活检查和数据库记录恢复。控制请求处于 sending 时崩溃，会转为 unknown，不自动重发。
- 模型的明确策略拒绝与一般执行失败分开显示；没有结构化拒绝码的自然语言答复保留原文，不用关键词推断。completed 仍不等于需求验收成功。
- 通知失败与模型终态分别记录，`/状态` 显示投递失败或回执待核对。通知不确定时继续使用 M3 的远端回执核对，不盲目重发。已绑定原卡的 PATCH 进入 unknown 超过 60 秒且任务已经终态时，独立发送一次无按钮的终态补充通知；不更新原卡绑定、不篡改旧 unknown，也不解除旧卡的串行限制。该兜底不适用于结果未知的初始 POST 或仍在运行/等待审批的任务。
- 会话被其他 App Server 持有写锁时，保留任务状态并提示人工协调；不删除锁、不终止桌面进程、不自动归档用户会话。协调后再恢复原 thread，不能把失败接管改成新 turn。

## 验证记录

本地 `pnpm verify`：158 项测试，类型、Lint、格式及构建通过。M4 新增 56 项，其中 46 项业务测试使用实际 SQLite、实际本机 WebSocket 和模拟服务端，另 10 项验证输入探针的消息准入、问题校验、权限/文件探针的范围约束、文件执行结果判据及手机控制探针的消息/等待命令准入；其中 SIGTERM/SIGKILL 用例启动并终止自有子进程，再由新的 worker 恢复。覆盖审批映射、权限子集、逐题回答、原卡按钮去重、越权和路径逃逸、过期/已结束/已解决请求、数据库拒写、断线重连、控制竞态、模型拒绝及 v2 迁移。**这些测试不等于真实飞书/模型联调。**

真实控制：[controls-dc67e5d1](../../.artifacts/m4/2026-09-20T02-36-26.421Z-controls-dc67e5d1/report.json) PASS。只有一个真实模型 turn：补充使用原 turn，worker 重连恢复同一 turn，打断收到 interrupted 终态后释放锁，远端原卡终态回执匹配。补充和打断通过正式控制队列在本机入队，该轮没有手机控制消息输入；本地测试覆盖飞书命令到控制队列的接线。自有 App Server 与临时目录已清理。

真实手机打断：[phone-controls-7a44d014](../../.artifacts/m4/2026-09-20T07-58-22.470Z-phone-controls-7a44d014/report.json) 独立 interrupt-only 测试 PASS。一次手机消息经过正式入口，仅提交一次原 thread/turn 的 turn/interrupt；任务 interrupted、锁为 0、无额外 turn，终态卡回执匹配。自有 App Server 正常退出、临时目录已清理。本轮未收到等待命令的完成 item，不能据此单独证明 sleep 子进程的退出状态；通过判据为 RPC、任务终态、锁和卡片。报告 selectedControls 仅包含 interrupt，不把它写成两分支整轮通过。

真实手机补充：[phone-controls-a3df5457](../../.artifacts/m4/2026-09-20T07-40-15.044Z-phone-controls-a3df5457/report.json) 的 steer 分支 PASS。完整测试消息经过正式飞书入口，仅形成一次 turn/steer，expectedTurnId 与原任务一致、服务端接受，没有新 turn。第一次不完整的固定测试文本被探针准入过滤，随后完整消息正常接收。该轮整体 BLOCKED，尚未收到手机打断：运行中的卡片 PATCH 网络请求超时，后续 GET 可成功读取原卡，但仍是更早的回执，无法确认该 PATCH 结果。unknown 更新阻塞后续卡片快照，旧探针又在补充后等待卡片核对，导致未进入打断步骤。原任务随后自然 completed、锁为 0；自有进程退出且临时目录已清理，但旧卡终态通知未核实，不能宣称本轮通知闭环通过。

探针现将补充回包确认与下一步打断解耦，终态卡仍须独立核实；卡片核对超过 60 秒明确 BLOCKED，保留 unknown，不能当成发送失败而盲目重发。生产 Gateway 的控制处理原本独立于 outbox，此次修改仅移除探针的额外等待。可用 --phone-mode interrupt-only 在新临时任务单独补测打断，报告 selectedControls 明确范围。旧卡 PATCH 的不确定结果不由新一轮成功覆盖，后续采用下述独立终态通知兜底。

真实终态通知兜底：[terminal-notice](../../.artifacts/m4/2026-09-20T07-40-15.044Z-phone-controls-a3df5457-terminal-notice/report.json) PASS。在上一轮已退出探针的数据库副本上，由正式 FeishuSender 生成独立终态通知，一次 POST 后核实新消息的身份和回执。原始数据库校验未变，没有 RPC 或 PATCH 重放；旧 PATCH 仍为 unknown，旧卡绑定及被阻塞的快照保留。恢复的是用户收到最终结果的能力，不表示原卡已经更新。新通知带原任务 ID 和最终结果，旧更新即使迟到也不能覆盖它。

终态通知使用任务级唯一 logical_key 持久化去重；其 POST 回包丢失仍先核对自身回执，不会再创建第三张卡。新增 9 项回归覆盖重启/刷新不重复发送、补发回包丢失、迟到旧 PATCH、GET 失败、运行中/越权/错误绑定/初始 POST 不触发。`pnpm verify` 共 158 项通过，含真实本机 WebSocket 的验证需允许回环监听；第一次受限环境的失败日志保留，不作为通过证据。该策略复用 schema v3，不新增迁移或依赖。

真实手机命令审批：[approvals-d3b9b213](../../.artifacts/m4/2026-09-20T02-52-50.790Z-approvals-d3b9b213/report.json) 整轮 PASS，11:00 北京时间结束。两次真实有效回调分别形成一次处理，没有额外 turn；两项审批均收到服务端 resolved，两个原卡的远端终态回执均匹配。最终锁为 0，未完成事件为 0，outbox 无待发送或错误项，自有 App Server 正常退出、临时目录已清理。

| 手机操作                      | 实际 RPC 决定 | 工具结果                                       | 任务终态      |
| ----------------------------- | ------------- | ---------------------------------------------- | ------------- |
| `d0c2fb62` 点击「仅允许本次」 | `accept`      | 固定 printf 退出码 0，输出 `M4_APPROVAL_PROBE` | `completed`   |
| `c3b37dd5` 点击「取消」       | `cancel`      | `declined`，未执行命令                         | `interrupted` |

该版本本次请求没有提供 `decline`，因此采用服务端提供的 `cancel` 验证不授权路径。报告中 `phoneApproval_decline` 是测试分支名称，实际协议决定以 `declineEvidence.wireDecision: cancel` 为准；不能据此宣称字面 `decline` 也已真实验证。当前探针已停止，旧卡片不再用于下一轮交互。

真实手机用户输入：[inputs-3b9e02d3](../../.artifacts/m4/2026-09-20T03-43-27.218Z-inputs-3b9e02d3/report.json) 整轮 PASS，11:55 北京时间结束。第一条真实飞书消息后仅保存 color=蓝色、保持等待且未回包；第二条消息后一次回传 color=蓝色 和 language=中文。另一个请求点击「取消回答」后一次回传空 answers。两项请求均收到服务端 resolved，两个原 turn 均 completed，结果分别包含 M4_INPUT_OK 与 M4_INPUT_CANCELLED，两个原卡远端回执匹配。共两条回答消息、一次取消回调、两个 turn，没有额外执行；最终锁和未完成事件均为 0，outbox 无错误，自有 App Server 已退出、临时目录已清理。请求实际为 isBlocking=false、autoResolutionMs=null；等待行为由逐题状态与真实回包验证。

真实手机权限子集：[permissions-88b1bae1](../../.artifacts/m4/2026-09-20T05-59-33.983Z-permissions-88b1bae1/report.json) 的仅网络分支已通过。14:01 北京时间收到真实点击，实际 RPC 回包为 permissions.network.enabled=true、scope=turn，不包含请求中的文件权限；服务端 resolved，原 turn completed，远端原卡回执匹配。取消权限分支于 14:18 过期，未收到取消点击，整轮为 BLOCKED；过期任务已结束、原卡终态已投递，锁和未处理事件均为 0，自有进程与临时目录已清理。仅网络的通过证据保留，后续仅补测取消分支；这些记录不证明后续沙箱访问效果。

真实手机权限取消：[permissions-58e40b52](../../.artifacts/m4/2026-09-20T07-12-05.129Z-permissions-58e40b52/report.json) 单项补测 PASS。15:14 北京时间收到取消点击，实际回包为 permissions={}、scope=turn；服务端 resolved，原 turn completed，远端原卡回执匹配。一次有效回调、一个 turn，锁和未完成事件均为 0，outbox 无错误，自有进程已退出、临时目录已清理。权限子集与取消两项由上述两轮证据共同覆盖；保留旧轮 BLOCKED，不宣称完整权限套件单轮 PASS。权限工具仅在测试进程中启用，不代表日常服务已开启。

真实手机文件审批：[files-1bcac9e9](../../.artifacts/m4/2026-09-20T07-23-02.731Z-files-1bcac9e9/report.json) 的允许分支已通过。15:26 北京时间收到真实点击，RPC 回包为 decision=accept；服务端 resolved，文件工具 completed，临时文件 m4-file-accept.txt 的完整内容为 M4_FILE_APPROVAL_PROBE 加换行，原 turn completed，远端原卡回执匹配。该轮以固定 exec 命令承载 apply_patch，实际收到并处理的是 item/fileChange/requestApproval，而非命令审批。只读沙箱仅用于测试，不修改正式项目的执行策略。

15:29 北京时间的文件取消点击已被处理：回包 decision=cancel、服务端 resolved、任务 interrupted，原卡终态匹配且锁为 0。该 CLI 将取消后的 fileChange item 标为 failed，探针原先断言只能为 declined，导致该轮 FAIL。断言发生在检查文件是否存在之前，清理后不能补充当时的磁盘证据，因此保留失败报告并单独重测取消。新判据仍要求精确取消回包、resolved、文件不存在；仅在 task=interrupted 时接受 tool=failed，不能把一般执行失败当成取消成功。探针会在断言前保存实际工具状态、回包与磁盘检查结果，避免丢失证据。

真实手机文件取消：[files-9f1e14fc](../../.artifacts/m4/2026-09-20T07-32-32.649Z-files-9f1e14fc/report.json) 单项补测 PASS。15:35 北京时间的点击仅回传一次 decision=cancel，服务端 resolved，task=interrupted、tool=failed，清理前已实际确认文件不存在。一次有效回调、一个 turn，原卡终态回执匹配，锁和未完成事件均为 0，自有进程退出、临时目录清理完成。文件允许与取消由两轮证据共同覆盖；旧 FAIL 保留，不宣称文件套件单轮完整 PASS。

真实 App Server 退出后恢复、跨进程写锁及桌面人工交接已通过，证据见下文。旧卡已通过独立终态通知完成告知恢复；原 PATCH 继续保留 unknown，G1 平台自动重投仍为 PARTIAL。

真实写锁：[ownership-2aa62373](../../.artifacts/m4/2026-09-20T02-46-47.641Z-ownership-2aa62373/report.json) PASS。两个自有 App Server 使用同一个已完成测试会话：第二个收到 active writer 冲突；显式停止第一个测试进程后，第二个恢复原 thread，历史仍只有原 turn，没有新增模型执行。这验证了底层写锁契约，不代表桌面 GUI 自动交接已实现。

真实桌面人工交接：[desktop-handoff-219734ca](../../.artifacts/m4/2026-09-20T08-21-03.027Z-desktop-handoff-219734ca/report.json) PASS，16:34 北京时间结束。用户先确认“会话被占用”，显式停止自有测试持有者后，再确认“能看到原历史，不再提示占用”。两项 GUI 观察以 PASS_USER_OBSERVED 独立记录；程序另行核对真实写锁冲突、持有进程退出、同一个 thread 中仍只有原 interrupted turn，没有新模型执行。自有进程和临时目录已清理，没有删除写锁或结束桌面进程。该测试验证人工交接，不包含自动接管或恢复后的新一轮写任务。

真实退出后恢复：[recovery-e2aca320](../../.artifacts/m4/2026-09-20T02-52-11.927Z-recovery-e2aca320/report.json) PASS。原审批探针连接断开后，其自有 App Server 被清理退出；新进程基于数据库备份恢复精确 thread/turn，核实 interrupted 后释放锁并更新原卡。没有提交新 turn，旧审批 response_state 仍为 none。原失败报告及数据库保持原样，修复后的核对记录保存在独立目录。

联调发现并修复的兼容/恢复问题：

- 本地真实 command 请求的 environmentId 为 `local`。原解析器仅允许 null/缺省，导致两轮请求被明确拒绝。现接受 `local` 并补回归，远端环境仍拒绝。
- [approvals-bd4f2080](../../.artifacts/m4/2026-09-20T02-43-51.140Z-approvals-bd4f2080/report.json) 在周期性 thread/resume 后断线，运行循环随后继续 dispatch 导致退出。现避免重复订阅，并在异步恢复后重新检查连接；新增断线原因诊断。旧报告缺少客户端断线原因，因此尚不能将底层断线原因完全归为重复请求。
- 对应回归覆盖等待审批时多次核对、会话关闭后重新订阅，以及恢复/审批写入期间断线仍可投递飞书状态、数据库故障不被误吞为离线；修复后重新运行的上述手机允许/取消测试已通过，旧失败报告保留。

可重复入口：

```bash
pnpm gate:interactions --help
pnpm gate:interactions --live --suite controls --timeout 600
pnpm gate:interactions --live --suite phone-controls --timeout 1800
pnpm gate:interactions --live --suite phone-controls --phone-mode interrupt-only --timeout 1800
pnpm gate:interactions --live --suite approvals --timeout 1800
pnpm gate:interactions --live --suite inputs --timeout 1800
pnpm gate:interactions --live --suite permissions --timeout 1800
pnpm gate:interactions --live --suite permissions --permission-decision cancel --timeout 1800
pnpm gate:interactions --live --suite files --timeout 1800
pnpm gate:ownership --live --source .artifacts/m4/CONTROLS_RUN
pnpm gate:ownership --live --desktop --source .artifacts/m4/CONTROLS_RUN
node --import tsx scripts/gates/recover-terminal-notice.mjs --live --source .artifacts/m4/PHONE_CONTROLS_RUN
```

新增 `inputs` 探针使用正式 Gateway 输入处理器、官方飞书长连接和真实 App Server 请求。先由手机逐题回答颜色和语言，验证第一题后仍等待且未回包、第二题后仅回包一次并继续原 turn，再在另一个请求上点击「取消回答」。探针仅接收当前请求 ID 对应的两条固定回答，其他文本不能创建任务；只有观察到真实且仍有效的输入请求才发出操作提示，普通模型提问不能替代。请求的 isBlocking 如实记录；是否仍在等待、何时回包由实际事件和状态验证，不能只靠该标志断言。

`phone-controls` 探针使用一次固定 `/bin/sleep 900` 保持真实 turn 活跃。观察到固定命令在临时目录运行、原卡送达后，才提示手机发送指定的 `/补充` 消息；服务端接受并核对 expectedTurnId 后，再提示发送同一任务的 `/打断`。文本经过正式飞书 SDK、身份校验、持久化命令与控制队列；探针只接纳当前任务和当前步骤的固定文本，按钮及其他文本不能替代验收。必须核对两个真实消息、各一次控制 RPC、只有原 turn、interrupted 终态、锁释放和原卡回执。该场景证明补充指令被同一 turn 接受与打断闭环，不证明模型完成了补充指令的语义要求。模拟准入测试或启动成功不等于真实手机控制通过。

输入预检的前两轮被探针误设的 `isBlocking: true` 条件阻止；实际请求为 `isBlocking: false`、`autoResolutionMs: null`，两题的 ID 和选项均符合预期。正式 Gateway 解析器原本已接受两种布尔值，本次修正的是探针条件，保留原始 BLOCKED 报告。两轮均未收到手机回答；自有测试进程已退出，原 turn 已分别经 [recovery-74b0eee7](../../.artifacts/m4/2026-09-20T03-39-03.159Z-recovery-74b0eee7/report.json) 和 [recovery-25e0ff8a](../../.artifacts/m4/2026-09-20T03-43-09.809Z-recovery-25e0ff8a/report.json) 核对为终态并更新原卡。后续测试使用新请求，不复用旧 ID。

本机固定 CLI 的 `features list` 显示 `default_mode_request_user_input` 默认为 false，状态为 under development。本轮仅向自有测试 App Server 传入 `-c 'features.default_mode_request_user_input=true'`，并通过 config/read 核实生效；没有改全局配置。功能开关和新增探针不代表真实联调已通过，最终以该轮报告为准。日常服务是否启用此实验能力需按实际启动配置核对。

`permissions` 探针临时开启 `features.request_permissions_tool=true`，该工具在固定 CLI 中也默认关闭且处于 under development。仅接纳临时目录内固定 `m4-permission.txt` 的写权限与网络权限组合请求，拒绝额外路径、读取权限、glob 或远端环境。第一轮由手机选择「仅网络（本轮）」并核对真实回包只包含 network；第二轮选择「取消」并核对空 permissions，两轮 scope 均必须为 turn，继续原 turn、收到 resolved 并核对原卡回执。该测试不执行实际文件或网络操作，也不证明后续沙箱访问的执行效果。功能开关、准入单元测试和启动成功均不算真实权限审批 PASS，仍需两次手机操作及服务端结果。

可用 `--permission-decision network|cancel` 单独补测未完成分支，默认 all 执行两项。报告通过范围按 selectedDecisions 记录，单项运行严格验证一次有效回调和一个 turn；不能将单项 PASS 表述为同一轮两项全部通过，也不复用过期 RPC 请求。

`files` 探针仅在测试进程将 thread 和 turn 沙箱收紧为 read-only，核对 thread/start 的实际沙箱响应，触发临时项目内固定文件的原生 fileChange 审批。准入检查要求真实 item 观察记录包含单个固定文件的新增及固定文本，缺失 diff 或范围不符则拒绝。手机允许后核实文件完整内容；取消后核实未创建文件、工具 declined 或 tool=failed 且 task=interrupted，两项均核对真实回包、原 turn、原卡和锁。可用 `--file-decision accept|cancel` 补测单项。该测试不修改正式 workspace-write 策略，也不表示默认配置下每次项目内写文件都会请求审批。探针与本地测试就绪仍不等于真实文件审批通过。

文件首轮预检 [files-6127003d](../../.artifacts/m4/2026-09-20T07-19-00.518Z-files-6127003d/report.json) 为 BLOCKED：模型报告当前没有独立 apply_patch 工具，禁止命令入口的提示使其未调用工具，没有产生文件审批。任务已 completed、自有进程退出、锁为 0；终态卡在独立副本中补发并核对，见 [file-terminal-card](../../.artifacts/m4/2026-09-20T07-22-27.254Z-file-terminal-card/report.json)。探针现在允许仅以固定 exec 命令承载同一 apply_patch 内容，仍须实际收到 item/fileChange/requestApproval 才能进入验收，普通命令审批不能替代。未产生审批的终态会先完成原卡投递再结束探针。

首轮 [permissions-f9f27391](../../.artifacts/m4/2026-09-20T04-00-41.559Z-permissions-f9f27391/report.json) 在 12:16 北京时间过期，没有收到手机回调，审批记录为 expired、decision=null，任务已 completed、锁为 0，自有进程退出。该轮没有验证权限子集授权，原 FAIL 报告保留。探针原先直接断言应有用户选择，导致退出时一条终态卡更新未发送；已在独立数据库副本中补发并核对原卡回执，见 [expired-card](../../.artifacts/m4/2026-09-20T05-59-01.091Z-expired-card/report.json)。探针现先完成终态卡投递，再将等待手机决定超时归为 BLOCKED；不延长或重新激活过期授权，新一轮使用新请求。

真实探针只使用专用单聊和临时项目，禁用 hooks/plugins/apps/MCP/多代理等外部集成。审批探针只允许出现固定 `printf M4_APPROVAL_PROBE` 请求，选择权仍在手机用户。禁止同时启动另一个使用同一飞书应用的连接。测试超时后会关闭连接，旧卡片继续可见不代表服务仍在线。

## 本机版本漂移与迁移

本次发现应用内 Codex 已从 M3 验收版本 `0.154.0-alpha.6.2` 更新到 `0.155.0-alpha.9.2`。版本门禁在模型任务和飞书连接建立前阻止了首次联调。对新 CLI 生成的协议做差异核对后，重新生成 865 个类型文件及 JSON Schema；审批、权限、用户输入和控制接口未发生字段变化。thread/start/resume 的新增响应字段由现有解析器兼容，移除的 thread/rollback 不在 Gateway 使用范围。

`pnpm protocol:check` 和类型检查通过；新版本 [隔离 G2 回归](../../.artifacts/g2/2026-09-20T02-36-18.863Z-673f1b5c/report.json) 及上述真实控制检查通过。旧 G2/M3 报告仍属于旧版本，不将它们改写成新版本的完整验收结果。没有替换全局 CLI 或改动全局配置。

升级正式库前停止 Gateway 和 worker，再执行 `db-backup`，最后由新入口执行 v2 → v3 编号迁移。迁移发现任一租约时会拒绝；先确认进程状态并正常停止，不能随意清除租约。只读 doctor 对尚未升级的 v2 库报告不兼容是预期行为；不要用旧程序写入 v3 库。测试使用新的临时库，未迁移 `config/gateway.local.json` 指向的日常库。

协议依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)；具体字段以固定本机 CLI 生成类型为准。`turn/steer` 绑定 expectedTurnId，permissions 按请求返回子集，serverRequest/resolved 用于关闭交互请求。

桌面联合验收需要人工查看真实 Codex 窗口。当前 Computer Use 明确禁止控制 `com.openai.codex`，不能用两个测试 App Server 的结果替代 GUI 结果，也不能绕过该限制截图或操控窗口。先确认用户在电脑前，再启动只加载既有 M4 测试会话的持有进程；用户打开该会话并记录占用提示，显式释放自有测试进程后，再由用户重新打开核实原会话和历史。全程不发送新模型任务、不删除锁、不结束桌面进程。当前已提供 `--desktop` 探针：每步最多等待 30 分钟，人工反馈与 RPC 证据分开记录；只在用户确认占用提示、释放后历史可见且原 turn 未增加时通过。本轮已取得下述人工观察和程序核对证据，不能据此宣称自动交接可用。
