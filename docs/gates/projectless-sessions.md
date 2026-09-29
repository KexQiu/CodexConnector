# 无项目会话 NP0–NP4 验收记录

2026-09-28 最终 NP0：**PASS**。用户明确允许内建 `clock.curr_time`，其余限制保持不变。受控端点与本机登录下的真实模型新建、续聊、重启恢复均通过。NP1–NP3 已实现；2026-09-29 已完成开发档案备份、迁移和独立版本切换，NP4 真实飞书验收进行中。

## 本机证据

- Codex：`codex-cli 0.158.0-alpha.2.1`；macOS arm64；Node `v24.15.0`。
- 最终复测轮次：`2026-09-28T09-57-12.627Z-9722a2d5`；72 个受控模型请求、38 个受控回合，另有 3 个真实模型回合。汇总见 [脱敏结果](./projectless-sessions.evidence.json)。
- 模型请求使用 `gpt-6-astra` 标识，实际发往仅监听 `127.0.0.1` 的受控端点，受控部分不调用真实模型或使用账号凭据；随后 `--live` 部分由 Codex 自己复用本机登录。
- 使用本机真实 Codex 二进制、独立 `CODEX_HOME`、Unix socket、临时目录和合成文件；去除宿主 App 工具管道和凭据环境变量，保留操作系统沙箱提示。
- 不改用户全局 Codex 配置，不连接飞书，不重启当前 App 或独立桌面任务。只关闭探针创建的进程组，结束后确认进程退出并清理目录。

候选配置逐项禁用 shell、统一执行、快照、apps、hooks、plugins、MCP、记忆、多 Agent、浏览器、搜索、图片工具等能力。`thread/start` 和每次 `turn/start` 显式传入空 `environments`、`approvalPolicy: never`、只读且不可联网的沙箱；没有动态工具和选中的能力根目录。配置回显与实际执行证据分别记录，前者不单独授予能力。

## 已修复并验证

### 多 Agent 使用实际生效的开关

首次轮次 `2026-09-28T09-12-47.084Z-8976da68` 只关闭 `features.multi_agent` 和 `features.multi_agent_v2`，但模型仍看到六个 collaboration 工具，强制 `list_agents` 返回了真实列表。

本轮增加官方的 `agents.enabled=false`，同时应用于独立进程与线程配置。其语义是禁用多 Agent 工具，见 [官方子 Agent 配置](https://learn.chatgpt.com/docs/agent-configuration/subagents)。新建、续聊和恢复的完整请求中均不再声明 collaboration 工具；新建和恢复后强制调用 `list_agents` 都得到 Codex 的 `unsupported call: collaborationlist_agents`。

修复了探针对返回值的判断：仅当输出能解析为含 `agents` 数组的 JSON 才认为返回列表，不能因为错误字符串包含 `agents` 就误判执行成功。本轮没有创建子 Agent，也没有发送跨会话消息；未声称实际执行过这些动作。

### 每一轮重新限制环境，不依赖恢复元数据

`thread/resume` 仍返回 `environmentId: local`，不能视为已经恢复普通聊天限制。恢复时单独核验同一线程、审批和沙箱策略；随后每次 `turn/start` 显式传入 `environments: []`，回合结束再用 `thread/read` 验证为空。38 个受控回合及 3 个真实回合均通过，包含新建、续聊、强制负例和进程重启后的回合。

这修复的是探针与后续实现契约，并非修复 Codex 的恢复元数据。正式实现必须覆盖所有轮次入口；`turn/steer` 不能设置环境，只能对已经验证策略的活动轮次使用，恢复状态未知时不得直接补充输入。

### hooks 已有真实对照

在临时 Codex Home 写入已审核的 `SessionStart`、`UserPromptSubmit`、`Stop` hooks；每个只对自己的临时标记文件执行 `touch`。

先启用 hooks，确认三个标记都出现；停止该进程并移除这些标记，再关闭 hooks。新建及重启后的测试均没有产生标记。所有阶段只在隔离夹具中设置 `bypass_hook_trust=true`，用于证明禁用不依赖“hook 未获得信任”；该测试参数不属于生产候选策略，不得传入用户真实 Codex Home。hook 来源、信任和开关语义见 [官方 hooks 文档](https://learn.chatgpt.com/docs/hooks)。

## 已确认的时间工具例外

### 内建时间工具可以绕过不可执行的包装器

新建、续聊、恢复及所有负例回合的模型请求仍声明：

```text
functions.exec
functions.exec/clock__curr_time
functions.wait
functions.request_user_input
functions.request_user_input_async
```

工具在 `input` 的 `additional_tools` 中；顶层 `tools` 缺失不代表没有工具。声明解析器同时审计两种位置、显式命名空间及包装器描述；未知命名工具类型会阻断审计，不会借用同名用户输入工具通过检查。

`functions.exec` 执行 Shell 或时钟，以及 `functions.wait`，均得到明确的禁用回执；不能将它们仍出现在声明中写成“Shell 执行成功”。但强制直接返回以下模型工具调用时，Codex 会返回当前 UTC 时间：

```json
{ "type": "function_call", "namespace": "clock", "name": "curr_time", "arguments": "{}" }
```

新建和重启后都复现了该行为。额外诊断轮次 `2026-09-28T09-31-05.594Z-50b1cb24` 尝试 `features.code_mode.enabled=false` 和 `features.code_mode.excluded_tool_namespaces=["clock"]`，时钟从包装器描述消失，但直接调用仍成功。这只证明已测试的排除配置不能禁止该调用，并不声称所有未来版本都无法实现。

用户已明确允许内建时间工具。策略版本为 `ordinary-chat-clock-v1`，只允许该工具返回当前 UTC 时间；时钟返回值的格式及时间窗口都要核验。没有允许其他工具或任意执行器。

残留 `exec`、`wait` 声明只有在同一进程阶段取得实际拒绝回执后才可通过声明审计；仅配置回显、没有输出、参数错误都不够。任何新增的嵌套工具仍会失败。

额外安装合成插件的对照已通过：在独立 Codex Home 启用时其 MCP 进程写入测试标记，禁用后新建及重启均无标记。浏览器宿主、网页入口、带/不带 namespace 的 Shell、补丁及 JS REPL 调用均明确拒绝；本地网络探针未收到额外请求。

真实模型复用本机登录，先按进程覆盖禁用发现的 3 个 MCP、11 个 skills，并核验策略。模型在首轮记住合成代号，第二轮及自有 App Server 重启后第三轮均准确复述，回合环境为空，没有工具调用。测试会话已归档，三个自有进程和临时目录均已清理。该结果不是只根据模型口头拒绝得出的权限结论，权限证据来自前述受控强制调用。

## 覆盖与边界

| 检查                               | 结果             | 证据边界                                             |
| ---------------------------------- | ---------------- | ---------------------------------------------------- |
| 29 项禁用配置、多 Agent、搜索、MCP | PASS             | 配置检查加受控强制调用                               |
| 新建、续聊和恢复后的工具声明       | PASS             | 按用户批准的时钟例外审计；包装器必须有同阶段拒绝回执 |
| Shell、文件补丁、JS REPL、多 Agent | PASS             | 带/不带命名空间的受控入口明确拒绝                    |
| 浏览器宿主与网页入口               | PASS             | 使用无副作用代码和本地网络探针；没有访问外部网页     |
| 插件、MCP 与 hooks                 | PASS             | 合成夹具先证明可启动，再验证禁用后的无标记结果       |
| 内置时钟                           | PASS（明确例外） | 返回格式和当前 UTC 时间窗口正确                      |
| 每轮空环境                         | PASS             | 38 个受控回合和 3 个真实回合后核验，包含重启         |
| 合成文件和记忆标记                 | PASS             | 文件未变、无读写标记；不代表所有记忆来源的普遍证明   |
| 真实连续聊天和恢复                 | PASS             | NP0 3 回合；另见下方应用链路 5 回合                  |

权限结论来自受控端点的工具声明和强制负例，不以模型口头拒绝作为证明。真实账号模型测试验证对话和恢复路径，不代替上述权限证据。

## 复测方式

在允许监听本机端口的终端运行：

```sh
pnpm gate:projectless --live
```

候选版本不一致会停止。显式测试新版本：

```sh
pnpm gate:projectless --binary /absolute/path/to/codex --candidate-version VERSION
```

该参数只创建待测记录，不授予运行权限，不改变项目兼容策略。返回码 `1` 表示已发现失败，`2` 表示检查未完成或仍缺真实验证；不会仅凭受控端点通过返回整体 NP0 成功。

输出到 `.artifacts/projectless/<runId>/`，目录 `700`、文件 `600`。`report.json` 为汇总，`*.private.*` 为服务诊断及合成工具回执；不保存完整模型请求、不保留请求头、不读取或复制 `auth.json`。受控端点最多接收 96 个请求，异常循环不能无限运行；已提交证据移除二进制和夹具绝对路径。

受限环境的 `listen EPERM` 属于监听权限问题，不是能力不支持；本轮结果来自允许监听的实际运行。

## NP1–NP3 实现

- v11 新增会话范围与持久 `conversation_id`，回填项目线程和任务。历史 fingerprint、请求键、RPC、回执、未知状态和锁保留；无法从任务投递证据确认单聊的记录保留空归属。
- 命令先在事务中保存目标范围、会话和已解析标记。首轮任务尚未绑定 Codex 线程时，后续消息已能关联本地会话；重试和切换不会改变原消息目标。
- 按会话串行，与项目共用并发配额。先前消息等待持久化重试时，后续消息不能抢先执行。首轮回包丢失保留 unknown 和锁。
- 无项目目录按规范化数据档案路径哈希与 UUID 隔离，检查私有权限、设备号和 inode；缺失或替换后拒绝恢复。
- 普通聊天使用独立 App Server、独立 RPC 和进程租约；有效配置/技能在启动及每次提交前检查。新建和每轮启动均传空环境，续聊/补充/恢复/退出使用对应后端；权限扩展请求被拒绝。
- 能力门禁绑定已测试版本、原生程序 SHA-256、策略摘要及 `gpt-6-astra`。普通聊天目前固定该模型和 low 推理强度；这是已验证范围，不继承项目配置。能力失败只阻止无项目执行。
- 飞书增加每页固定无项目入口、历史列表、新建和接着聊；新建操作本身不创建记录或目录。无选中态可直接聊天，`/选择 无项目`、`/会话 无项目`、`/当前` 可用，额度仍独立。
- App 本地项目页提供开关、能力检查和实际后端状态。沿用自动草稿缓存和停止后应用；零项目也可启动。关闭后保留历史，拒绝执行。

## NP4 当前证据

### 真实 Codex 应用链路

独立构建下运行：

```sh
node --import tsx scripts/gates/projectless-integration.mjs --live --backend .artifacts/projectless-build/backend
```

轮次 `2026-09-28T10-31-07-174Z-10200480`：**PASS**。通过真实 `FeishuCommands → TaskStore → TaskWorker → 独立 App Server → 模型`，飞书输入由本地夹具模拟，没有连接飞书或发送真实卡片。

验证零项目首条消息、同会话追问、新建第二会话、显式切回第一会话、关闭并重新创建后端和数据库连接后的续聊。共 5 个任务、5 次 turn/start、2 个 Codex 线程、5 条投递关联，无重复执行。每轮环境为空。两个测试线程已归档，专用会话目录、临时数据库和自有进程已清理。

### 现有档案副本升级

从当前开发档案在线备份出副本，再仅在副本移除源进程租约，执行带备份的 v10 → v11 升级。原档案未修改。17 条 outbox 和 14 条飞书命令的原字段哈希一致，外键校验为空。

该档案没有历史任务/线程，不能以此证明任务历史迁移；有历史任务、未知状态、回执、旧幂等记录、跨单聊和失败回滚由专门 SQLite 夹具覆盖。

### 仍待真实验收

- 使用新产物连接真实飞书，验证连续聊天、会话切换、卡片显示与实际送达。
- 同时启动独立 Codex 桌面任务和飞书任务，退出 App，确认只中断网关任务；自动化已覆盖归属范围，尚不等同于真实桌面验收。
- 用户开发档案备份及切换已完成，见下方 2026-09-29 记录；旧产物未覆盖。
- 内部安装包和 App 安装后的验收结果将在实际完成后记录。

## 工程验证

2026-09-29 完整测试 39 个文件、540 项通过；后端及桌面类型检查、ESLint、Prettier 全部通过。后端、桌面主进程和界面构建至独立目录，未覆盖旧运行产物。

受限沙箱中第一轮端口测试出现 `listen EPERM`；允许本机回环监听后通过。不能将这一环境失败计为产品缺陷或真实飞书验收。

## 暂停记录（2026-09-28）

用户决定今天暂停，明天再参与真实飞书测试。本轮临时 UI 预览已关闭；代码和独立产物保留，未切换当前运行中的旧版本，未迁移真实档案，也未提交代码。

恢复时先完成最终增补改动的测试、类型及静态检查，并补齐独立 App 产物；随后停止旧 App、备份真实档案、验证无重复实例，再启动新产物。确认普通聊天后端和飞书连接就绪后，逐条指导用户完成上述真实验收。独立发布暂存目录为 `.artifacts/projectless-release-20260928`，当前仅完成后端构建，不能当作已完成的安装包。

## 恢复验收（2026-09-29）

已在旧 App 中停止连接并正常退出，确认其主进程、后端和自有 Codex App Server 退出，独立 Codex 桌面进程仍在运行。完整复制加密配置和所有数据档案到 `.artifacts/projectless-acceptance-20260929/backup-before-v11`，备份 `quick_check=ok`、外键无错误、未完成任务为零。

独立测试产物 `.artifacts/projectless-release-20260928/app` 已运行，开发档案自动升级至 v11，升级程序另保存数据库备份。Gateway、项目 RPC、飞书长连接、普通聊天后端均 ready；首次连接时选中态和任务为空。首条自然语言消息已通过，后续逐条验证连续聊天、切换和恢复；尚未完成全部真实飞书闭环。

开发模式支持 `CONNECTOR_DEV_RUNTIME_ROOT` 和 `CONNECTOR_DEV_DATA_ROOT` 指向独立运行产物和原档案；打包模式忽略这两个变量。回退时先退出测试 App 并保存 v11 档案，再恢复上述 v10 备份并启动旧构建，禁止旧版本直接打开 v11 数据库。

### 真实飞书分步记录

| 步骤                       | 状态         | 证据                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无选中态直接发送首条消息   | PASS         | 用户确认收到“已记住青竹 0929”；任务 `69e70124` completed，项目为空，自动选中无项目会话 `ebbca12b`；仅 1 次 thread/start、1 次 turn/start，回执均 known；同一卡片 send 和终态 update 均 delivered，共 1 个任务、1 个会话、1 条投递关联                                                                     |
| 同会话自然语言追问         | PASS         | 用户确认回答“青竹 0929”；任务 `ba787153` completed，沿用会话 `ebbca12b` 及原 Codex thread；1 次 thread/resume、1 次 turn/start，均 known；终态卡片 delivered，总计 2 个任务、1 个会话。脱敏快照：`.artifacts/projectless-acceptance-20260929/step02.json`                                                 |
| 从项目入口准备新建第二会话 | PASS         | 用户完成 `/项目` → 查看无项目会话 → 新建会话；三个命令 processed，提示已 delivered；选中范围为 projectless，conversation/task 为空，仍只有 2 个原任务、1 个原会话和 1 个目录。快照：`.artifacts/projectless-acceptance-20260929/step03-ready.json`                                                        |
| 第二个无项目会话首条消息   | PASS         | 用户确认“已记住白鹭 0929”；任务 `9239a6ea` completed，新会话 `cca9aac4`、新 Codex thread 和独立私有目录，目录身份与登记一致；1 次 thread/start、1 次 turn/start 均 known，终态卡片 delivered；总计 3 个任务、2 个会话。快照：`.artifacts/projectless-acceptance-20260929/step04-second-conversation.json` |
| 切回第一会话并追问         | PASS（复测） | 首轮未实际切换，已由用户确认收到白鹭，不计通过。用户重启后从列表点击青竹“接着聊”，select processed，切换未新增任务；追问任务 `04d07073` completed，沿用青竹会话 `ebbca12b` 和原 Codex thread，回答“青竹 0929”，用户确认收到；终态卡片 delivered                                                           |

### 用户自行启动前停服（2026-09-29）

用户确认切回测试的实际回复为“白鹭 0929”，此项仍待重新操作验收；随后要求停止所有 Connector 服务，由用户自行启动。检查时测试 App 和 Gateway 主进程已退出，但服务租约所登记的两个独立 App Server 进程组仍存活且父进程为 1。按租约、用户归属、进程组与 socket 路径核验后发送 SIGTERM，两组均退出；两个旧 CLI LaunchAgent 未加载，最终活动租约和服务进程均为空，独立 Codex 桌面进程保留。核验快照：`.artifacts/projectless-acceptance-20260929/stopped-by-user.json`。

本次主进程退出方式尚未确定，不能将残留归因于某一退出路径；异常退出后的子进程清理仍需专项复测。没有把本轮停服计作“退出 App 自动清理全部进程”验收通过。用户后续启动需使用支持 v11 的新构建；会话和测试记录均保留。

### 用户重启后切换（2026-09-29）

用户自行启动新实例后，Gateway 和普通聊天后端就绪，`/会话` 与 `/会话 无项目` 均显示原来的两个会话。随后收到指向青竹任务 `ba787153` 的 select 回调并 processed；当前选择已恢复为原会话 `ebbca12b`，切换提示 delivered，任务数仍为 4、会话数仍为 2，切换没有触发执行。快照：`.artifacts/projectless-acceptance-20260929/step05-selected-first.json`。下一条追问将同时核验原线程恢复及重启后历史可用。

### 重启后历史续聊（2026-09-29）

**PASS**：旧后端进程组已确认退出，新实例网关 PID 3316、项目后端进程组 3919、普通聊天后端进程组 3988。用户切回青竹会话后追问，任务 `04d07073` 仅 1 次 thread/resume、1 次 turn/start，回执均 known，恢复原 thread `01a0eacc-6dee-7aa2-9f80-1decd2308ed7` 并正确回答“青竹 0929”。总计 5 个任务、2 个会话，之前 4 个任务未重放；用户确认结果，send/update 均 delivered。快照：`.artifacts/projectless-acceptance-20260929/step06-resume-after-restart.json`。此项证明重启恢复和去重，不代替退出时自动清理、运行中中断的验收。下一步为项目与无项目互切及普通项目回归。

### 切换到项目范围（2026-09-29）

**PASS（仅选择）**：用户通过 `/项目` 选择 CodexConnector，project 回调 processed。当前范围为 project，项目键为 `CodexConnector-d0c70a134e`，会话和任务选择为空；保持 5 个任务、2 个会话，选择本身没有执行。提示 delivered，使用本机原有只读分析权限。快照：`.artifacts/projectless-acceptance-20260929/step07-selected-project.json`。待验证项目内首次任务及返回无项目会话。

### 项目首次任务回归（2026-09-29）

**PASS（普通回复）**：用户确认收到 `PROJECT_SWITCH_OK`，任务 `0d17741c` completed，正确关联 CodexConnector 项目、project 会话 `e1db0f47` 及独立新线程；thread/start 和 turn/start 各 1 次，回执 known，终态卡片 delivered。总计 6 个任务、3 个会话，未混入两个无项目会话。快照：`.artifacts/projectless-acceptance-20260929/step08-project-task.json`。本项验证项目路由和普通回复，不等同于项目文件操作与全部权限回归。下一步切回青竹无项目会话。

### 项目与无项目互切闭环（2026-09-29）

**PASS**：从项目列表返回青竹时，select 指向原任务 `04d07073`，范围恢复为 projectless、项目为空，仍为 6 个任务和 3 个会话。后续追问生成任务 `8e69d320`，沿用青竹会话 `ebbca12b` 和原 thread，正确回答“青竹 0929”，用户确认收到；thread/resume 和 turn/start 各 1 次且 known，send/update delivered。总计 7 个任务均 completed、3 个会话，无未决 RPC 或待投递记录。快照：`.artifacts/projectless-acceptance-20260929/step09-return-from-project.json`、`step10-recall-after-project.json`。

至此真实飞书已覆盖无选中态首条消息、连续追问、新建与选择历史会话、重启续聊、项目与无项目互切。仍需核对状态展示、本机开关、退出隔离与异常清理，以及内部安装包验收；不能把上述聊天闭环通过等同于 NP4 全部完成。

### 当前状态卡片（2026-09-29）

**PASS**：用户确认 `/当前` 状态正常；命令 processed，当前面板及快照 delivered，仍为青竹 projectless 会话，任务数保持 7。卡片显示无项目普通聊天、gpt-6-astra、低推理强度、最近输入 6,669 Token、模型窗口 258,400 Token 和用量采样时间，并明确最近请求输入不等于实时上下文占用；状态正文排队为 0，布局未混入账号额度。快照：`.artifacts/projectless-acceptance-20260929/step11-current-panel.json`。下一步核对独立 `/额度` 卡片。

### 独立账号额度卡（2026-09-29）

**PASS**：用户确认额度正常；`/额度` 命令 processed，独立“账号剩余额度”卡 delivered，显示账号共享额度、剩余比例、北京时间重置时间及采样时间。查询后仍为青竹无项目会话，任务数保持 7，没有触发模型任务。快照：`.artifacts/projectless-acceptance-20260929/step12-quota.json`（本机私有，不提交账号用量）。下一步进行本机开关关闭后的历史查看和执行拒绝验收。

### 本机关闭开关并重新连接（2026-09-29）

**PASS（配置生效）**：用户停止连接后关闭并应用“允许无项目对话”，再重新连接；active 配置 `projectless.enabled=false`，无未应用草稿。飞书和项目 RPC ready，普通聊天 enabled/ready 均 false 且无错误，gateway 租约不再登记普通聊天子进程；原项目和普通聊天后端已退出，仅新项目后端运行。当前青竹选择、7 个任务和 3 个会话保留。快照：`.artifacts/projectless-acceptance-20260929/step13-projectless-disabled.json`。待实际发送历史查询及关闭后的执行请求。

### 关闭后的历史与执行拒绝（2026-09-29）

**PASS**：`/会话 无项目` 仍显示 2 个历史会话，用户又选择白鹭历史会话，切换只更新选择。续聊 `NP_DISABLED_0929` 和显式新建 `NP_DISABLED_NEW_0929` 均被命令层以 `command_rejected` 拦截；两张“本机已关闭无项目对话；历史仍可查看”提示 delivered，用户确认符合预期。仍为 7 个任务、3 个会话，thread/start 3 次、thread/resume 4 次、turn/start 7 次均未增加。当前选中白鹭会话 `cca9aac4`，恢复开关后应继续该会话。快照：`.artifacts/projectless-acceptance-20260929/step14-disabled-rejections.json`。

### 开关恢复（2026-09-29）

**PASS（配置恢复与服务重连）**：用户反馈已恢复；active 配置 `projectless.enabled=true`，无草稿，飞书、项目 RPC 和普通聊天后端均 ready，新后端进程组为 53034/53102，旧项目后端 38644 已退出。白鹭选择、7 个任务和 3 个会话保留。快照：`.artifacts/projectless-acceptance-20260929/step15-projectless-restored.json`。

App 主进程和后端进程仍为 3313/3316，未发生进程级退出重开；因此不能把本次反馈计为“退出 App 后设置保留”或“正常退出清理”通过。相关项目继续待验收，下一条消息仅核验恢复开关后的旧会话续聊。

### 恢复开关后的旧会话续聊（2026-09-29）

**PASS**：任务 `13dc7406` completed，沿用原白鹭会话 `cca9aac4` 及原 thread `01a0ead4-afaa-7f63-87f7-f4742e867b25`，正确回答“白鹭 0929”，用户确认；仅 1 次 thread/resume、1 次 turn/start，均 known，send/update delivered。总计 8 个已完成任务、3 个会话、0 个未完成任务。快照：`.artifacts/projectless-acceptance-20260929/step16-recall-after-enable.json`。下一步单独验收窗口关闭，退出前主进程 3313、后端 3316、自有进程组 53034/53102；停止后先核验，不立即重开。
