# CodexConnector

通过飞书单聊管理个人 Mac 上的 Codex 任务：选择项目、提交任务、处理审批、补充或打断执行，并接收结果。

M0 至 M4 阶段功能已验收。M4 审批、输入、控制和恢复：158 项本地测试通过，真实补充/重连/打断、手机命令允许/取消、逐题回答/取消、权限子集/取消、文件允许/取消、退出后恢复及写锁检查通过；手机补充和打断已分别通过，更新超时后的独立终态通知兜底也已真实验证；桌面人工交接联合验收通过，原历史保持不变、没有新增执行。阶段证据分别见 [M3 报告](./docs/gates/M3-gateway.md) 和 [M4 报告](./docs/gates/M4-interactions.md)。M5 常驻服务已安装，生命周期及飞书收发验证通过，正在人工值守试运行，操作见 [M5 部署说明](./docs/gates/M5-deployment.md)；G1 平台自动重投待补测，完整可靠性门禁尚未完成。

## 文档入口

| 文档                                                   | 内容                                          |
| ------------------------------------------------------ | --------------------------------------------- |
| [立项说明](./PROJECT_CHARTER.md)                       | 目标、交付范围、资源估算、风险和下一检查点    |
| [技术选型](./TECH_STACK.md)                            | 组件选择、版本策略、替代方案和待验证条件      |
| [开发计划](./DEVELOPMENT_PLAN.md)                      | M0–M6 任务、依赖和验收要求                    |
| [技术契约](./codex-feishu-gateway.md)                  | 唯一任务提交顺序、状态、归属、恢复和进程职责  |
| [M0 验收记录](./docs/gates/M0-foundation.md)           | 实际版本、验证命令、兼容性处理和未覆盖项      |
| [G1 飞书状态](./docs/gates/G1-feishu.md)               | 真实收发、卡片与故障验证及覆盖范围            |
| [G2 RPC 验收](./docs/gates/G2-rpc.md)                  | 真实 RPC 证据、版本兼容与恢复边界             |
| [M2 任务验收与操作](./docs/gates/M2-tasks.md)          | 真实任务、故障注入、CLI 使用及 unknown 边界   |
| [M3 飞书闭环与操作](./docs/gates/M3-gateway.md)        | 命令、发送核对、补收消息、权限及真实验收状态  |
| [M4 审批、控制和恢复](./docs/gates/M4-interactions.md) | 审批映射、输入、补充/打断、恢复约束及验证边界 |

| [M5 常驻部署与试运行](./docs/gates/M5-deployment.md) | 服务管理、健康检查、备份恢复、内容保留与待验收项 |
| [M5 完整测试操作手册](./docs/gates/M5-test-runbook.md) | 准备步骤、逐条飞书消息、按钮操作、预期结果与故障核对 |
| [M6 通知桥接与验收](./docs/gates/M6-notify.md) | GUI 通知捕获、原通知保留、离线补投、联调及回滚 |
| [交互优化第一批](./docs/INTERACTION_UX.md) | 项目选择卡、普通聊天、话题切换、详情及升级验收 |
| [当前项目与会话面板](./docs/CONTEXT_PANEL.md) | 自动更新状态卡、菜单入口、配置步骤和验收 |
| [模型、上下文与账号额度](./docs/STATUS_METRICS.md) | 会话模型、Token 统计、剩余额度和重置时间 |
| [卡片分区与展示](./docs/CARD_LAYOUT.md) | 摘要、详情、审批及独立额度卡的布局与验收 |

文档职责：立项说明定义范围，技术选型定义组件与工程约定，技术契约定义业务行为，开发计划定义执行和验收。协议字段以固定 CLI 生成产物为准；设计规则不等于功能已经实现。

## 首期技术栈

Node.js 24、TypeScript 6.0.x、pnpm、飞书官方 Node SDK、Codex App Server、ws、SQLite/better-sqlite3、Zod、Pino、Vitest、ESLint/Prettier、macOS launchd。

Gateway 是一个根包和一个进程，连接独立 App Server。项目写入受白名单和执行锁控制，消息与任务状态保存在本机 SQLite。

## 环境与安装

本机组合：Node.js 24.15.0、pnpm 11.20.0、Codex `0.155.0-alpha.9.2`；macOS arm64。9 月 20 日发现应用自动更新后，已审核协议差异、重新生成类型，通过隔离 RPC 及 M4 真实控制回归；旧 M3 报告仍对应 `0.154.0-alpha.6.2`，新版本完整覆盖见 M4 报告。默认使用 `/Applications/ChatGPT.app/Contents/Resources/codex`，可以通过 `CODEX_BINARY` 指定同版本二进制；版本漂移会阻止探针继续。依赖精确版本见 package.json 和 pnpm-lock.yaml，运行基线见 src/runtime-baseline.json。

在项目根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm run doctor
```

依赖缓存保存在被忽略的 `.pnpm-store/`，安装脚本默认关闭，当前组合已经验证可以直接使用发行包。依赖与 lockfile 不一致时，运行脚本会提示先安装，不再隐式联网安装。

`doctor` 是 pnpm 的内置命令名，必须使用 `pnpm run doctor` 才能运行本项目诊断。默认只检查本机版本和依赖；加 `--config /absolute/config.json` 时只读检查已有任务数据库，未初始化会明确标记，不执行迁移。不连接 RPC/飞书、不读取凭据、不创建运行目录。

## 已实现的开发入口

| 命令                                                                         | 行为                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm typecheck`                                                             | 检查源码、测试和完整生成协议类型                           |
| `pnpm lint` / `pnpm format:check`                                            | 静态检查 / 格式检查                                        |
| `pnpm test` / `pnpm test:watch`                                              | 单次测试 / 开发监听                                        |
| `pnpm build`                                                                 | 用 tsc 生成 dist，复制存在的迁移资源                       |
| `pnpm dev --help` / `pnpm start --help`                                      | 分别从源码 / 构建产物运行命令入口                          |
| `pnpm check:sqlite`                                                          | 在私有临时目录验证驱动与持久性并输出本机延迟，结束自动清理 |
| `pnpm protocol:generate`                                                     | 用固定本机 CLI 重新生成协议类型、Schema 和摘要             |
| `pnpm protocol:check`                                                        | 临时重新生成并逐文件比对，不修改已有生成产物               |
| `pnpm gate:rpc`                                                              | 隔离 Home 验证两种本地传输；默认不提交模型任务             |
| `pnpm gate:feishu`                                                           | 校验本机飞书配置；`--connect` 验证连接，`--live` 真实联调  |
| `pnpm gate:tasks --live`                                                     | 真实模型新建、续跑、worker 重启恢复及备份验收              |
| `pnpm dev projects` / `sessions --project KEY`                               | 只读项目/会话发现，按项目匹配后分页                        |
| `pnpm dev task-create --project KEY --request-key UNIQUE --prompt-file FILE` | 持久化入队；加 `--thread-id` 继续自有会话                  |
| `pnpm dev worker --once --timeout 120`                                       | 恢复已有任务并至多派发一个排队任务                         |
| `pnpm dev tasks` / `task TASK_ID --result`                                   | 任务列表 / 显式读取模型正文                                |
| `pnpm dev recover` / `state`                                                 | 已知 turn 状态核对 / 本地数据库诊断                        |
| `pnpm dev db-backup --destination /private/path/backup.sqlite`               | 一致性备份，不覆盖已有文件                                 |

`pnpm start` 不带参数展示帮助；`pnpm dev gateway` 启动 M3 前台 Gateway，`pnpm gate:gateway --live` 运行人工参与的真实验收，`pnpm dev feishu-recover-message --message-id om_MESSAGE_ID` 核实并补收原消息。M5 已安装两个独立用户 LaunchAgent，临时探针启动前必须先停止常驻服务。开发入口使用 `node --import tsx`，避免 tsx CLI 的辅助 IPC socket 在受限环境下阻止只读诊断。

## 配置与本地数据

配置样例在 [config/config.example.json](./config/config.example.json)。可以先验证结构：

```sh
pnpm config:check --config /Users/kex/Code/MyCode/CodexConnector/config/config.example.json
```

示例中的用户、目录和飞书 ID 都是占位符，remoteWrite 默认 false。结构校验不等于目录、登录或飞书应用已就绪。配置路径优先级为 `--config`、`CODEX_FEISHU_CONFIG`、`~/.codex-feishu/config.json`。

实际运行目录约定为 `~/.codex-feishu`，也可配置项目内私有 dataDir；目录 700、敏感文件 600。当前状态指标使用 schema v7，2026-09-23 已完成生产迁移；后续升级前仍须停止旧 Gateway/worker 并备份，拒绝外部业务库、迁移校验和漂移和不支持的版本。不直接写 Codex 自有数据库；M5 另用服务租约库管理两个 LaunchAgent。prompt、模型结果、审批/回答及待选项目的需求会保存在任务库中，备份同样需要保护。

协议生成包含 experimental 字段，仅表示类型可描述它们，不自动启用客户端能力。生成代码只做确定性的 NodeNext 导入转换，禁止手工编辑字段。

飞书联调凭据填写在 [config/feishu.local.json](./config/feishu.local.json)，字段说明见 [config/README.md](./config/README.md)。该文件权限 `600`，不参与 Git 和格式化。它是本机联调配置，不会因为填写完成就自动发送消息。

已准备被忽略的 `config/gateway.local.json`，引用已有飞书凭据；可通过 `CODEX_FEISHU_CONFIG` 指定。原 `codexconnector` 保持只读，独立测试项目 `m5fixture` 已启用写权限。当前由两个 LaunchAgent 启动 App Server 和 Gateway。新增其他可写项目需明确范围，停止并卸载服务后修改 remoteWrite，再重新生成部署清单及安装。基础步骤见 [M3 操作说明](./docs/gates/M3-gateway.md)，新库迁移和审批/控制范围见 [M4 操作](./docs/gates/M4-interactions.md)。未知提交结果会保留锁，不能用重试制造第二个 turn；M4 已通过阶段功能验收，仍需完成 M5 部署和试运行。

## RPC 门禁复测

```sh
# 隔离 Home，只验证连接、列表和错误响应
pnpm gate:rpc
# 现有 Home，只读会话与历史
pnpm gate:rpc --home existing
# 真实模型任务、控制、审批及恢复（会产生测试会话和模型用量）
pnpm gate:rpc --home existing --transport unix --live
```

可用 `--suite completed|controls|approvals|recovery|rpc-controls` 定向复测；`rpc-controls` 只验证控制命令接受、重连和打断，不证明模型完成补充指令。探针只在自己的临时目录启动子进程，关闭进程后清理目录；真实 Home 的测试历史保留。外部 MCP、插件、hooks 和桌面通知只在探针进程中关闭，不改全局配置。

审批探针仅在 `--live` 中预授权固定测试目录的精确 `printf` 命令及已核验的 shell 包装，分别接受一次和拒绝一次，不批准会话级权限或规则变更。正式 Gateway 审批仍需用户决定。

每轮脱敏报告与私有调试证据写入 `.artifacts/g2/<runId>/`，目录 `700`、文件 `600`；不得把 `.private.*` 文件提交或复制到公开报告。受限执行环境禁止本地监听时需要在允许监听的终端执行，`EPERM` 不算协议不支持。测试中的本地 socket 夹具也需要监听权限。

## 下一步

2026-09-23 已上线项目、帮助、操作提示和任务列表分区卡：项目逐项选择，`/帮助` 分组导航，新增 `/任务 [页码]` 查看所有任务；`/状态` 保持原有目标规则。306 项测试、飞书原生组件接口验证及 v8→v9 迁移通过，手机展示待确认。见 [使用与验收步骤](./docs/NAVIGATION_CARDS.md)。

2026-09-23 已上线会话导航优化：所有按钮恢复边框，`/会话` 提供合并后的可选会话列表，长回复可完整翻页，原卡直接展示完整 ID。298 项测试、真实组件投递和 v7→v8 迁移通过；按钮边框已获用户确认。手机实测没有代码块复制图标，按用户选择仅保留 ID 展示，不提供复制按钮或跳转页。见 [会话导航说明](./docs/SESSION_NAVIGATION.md)。

2026-09-23 已上线卡片分区展示：会话摘要双列显示模型和上下文，详情独立展示完整统计，`/额度` 显示剩余百分比与进度条，审批区保留完整操作范围。285 项测试和真实飞书四类布局/回执恢复通过，原面板原地更新；手机视觉验收待用户确认。见 [卡片展示说明](./docs/CARD_LAYOUT.md)。

2026-09-23 已补齐新话题默认模型/思考强度、旧会话主动补读和历史 Token 恢复。`/当前` 展示会话状态，`/额度` 独立展示账号剩余额度和重置时间，任务详情不再混入额度。277 项测试、真实默认配置/历史记录/模型用量事件、生产 v6→v7 迁移和原卡更新通过；手机命令展示待用户核对。操作及统计口径见 [状态指标说明](./docs/STATUS_METRICS.md)。

2026-09-23 已上线当前项目与会话面板：发送 `/当前` 或 `/面板` 可查看最新状态，后台状态卡自动跟随项目、话题、任务和队列变化。245 项测试通过，生产 v4→v5 迁移保留全部原有业务记录；真实飞书发送、原消息更新及重启不重复发卡已验证。菜单事件处理已实现，飞书后台当前账号无权访问目标应用，菜单配置和真实点击待完成；使用方式见 [面板说明](./docs/CONTEXT_PANEL.md)。

2026-09-21 已上线交互优化第一批：首次普通消息引导选项目、保留需求、接着聊/新话题/切换项目、精简卡片及详情、会话未建立时保存后续消息。226 项测试通过，生产数据库 v3→v4 迁移完成且原记录一致；两个服务和飞书连接就绪，部署通知发送回执已确认。用户已确认选择 `m5fixture` 后收到新话题提示，真实回调及回执核对通过，未新增模型任务；普通聊天及其余按钮待联合验收，操作见 [交互优化说明](./docs/INTERACTION_UX.md)。

M5 部署代码及其阶段 179 项全量测试通过；真实进程退出恢复、卸载重装、备份恢复和 `/项目` 收发通过，锁屏、Wi-Fi 断开重连及休眠唤醒后的收发均已联合验收。两个服务已在线，独立测试项目 `m5fixture` 可执行，原项目保持只读。T11 的 12 个真实任务备份恢复已通过；原 T12 在约 16.13 小时后提前归档，UX-R01 在约 48.265 小时后因本次面板升级归档，两轮均未完成全部人工验收，不计通过。当前状态指标版本观察从 2026-09-23 12:12:03（北京时间）重新开始。跨网络切换保留待测，重新登录测试按用户要求跳过并记为未验证，详见 [M5 部署说明](./docs/gates/M5-deployment.md)。

可用 `pnpm gate:interactions --live --suite controls` 或 `--suite approvals` 启动临时测试；同一飞书应用一次只使用一个连接。G1 自动重投仍需补测，当前范围见 [G1 报告](./docs/gates/G1-feishu.md)。运行这些长连接探针前先 `service-stop`，结束后 `service-start`。

M6 已开始开发，提供 `pnpm gate:notify` 配置/捕获工具和 `pnpm gate:notify:live` 隔离联调探针。通知扩展默认关闭，仅实现完成事件；真实 GUI 完成通知已送达飞书且经用户确认，重复事件本地重放通过。临时配置已逐字节恢复，桥接关闭；回滚后的新桌面任务正常完成，用户确认不再收到对应卡片。原 Computer Use 通知功能、真实离线补投及完整 G3 验收仍待完成。M6 联调时曾使用 `.artifacts/m6/build` 保持当时的线上基线；此次交互升级仍保持通知扩展关闭。不要在常驻运行或观察期间直接执行 `pnpm build` 或 `pnpm verify`。见 [M6 说明](./docs/gates/M6-notify.md)。
