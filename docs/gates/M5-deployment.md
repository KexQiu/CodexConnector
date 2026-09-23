# M5 macOS 常驻部署与试运行

最新部署（2026-09-23）：会话导航升级至 schema v8，298 项测试、真实组件验收和业务数据迁移核对通过。当前构建及试运行起点以 [session-navigation-evidence.json](./session-navigation-evidence.json) 为准；旧部署记录保留为历史证据。

当前部署更新（2026-09-23）：已上线[原生卡片分区展示](../CARD_LAYOUT.md)，schema 保持 v7，285 项测试及真实卡片接口/回执恢复通过。原会话面板原地更新、业务数据核对一致，两个服务就绪；本轮试运行起点和构建摘要以 [card-layout-evidence.json](./card-layout-evidence.json) 为准。以下里程碑验收与旧试运行记录均保留为历史证据。

需要开始完整测试时，按 [M5 测试操作手册](./M5-test-runbook.md) 从 P00 准备独立测试项目，再逐项执行；手册中的待测用例不代表已执行。本文件记录已交付功能和真实验收证据。

2026-09-20：部署实现及本机生命周期验收通过，两个用户 LaunchAgent 已安装并在线；真实 `/项目` 收发、锁屏、Wi-Fi 断开重连及休眠唤醒后的收发通过。阶段状态为 **IN_PROGRESS**，尚未标记 V0.2。24 小时人工值守和跨网络切换仍待验收；重新登录测试按用户要求从本轮范围移除，记录为未验证，不计通过。运行基线的已验收里程碑仍为 M4。

2026-09-21：用户要求直接切换交互新版，已完成停机备份、生产 schema v3→v4 迁移和两个服务重装，历史数据核对一致；真实飞书部署通知发送成功。原 T12 在约 16.13 小时后提前归档，不计通过；新版观察于今天 11:31:51（北京时间）重新开始。当前部署证据见 [交互优化证据](./UX-evidence.json)，下方原 M5 生命周期测试结果保留为历史版本证据。

## 已交付及验证

- `src/service/`：部署清单、私有文件、SQLite 服务租约、socket 归属、分层健康状态、轮转日志、在线备份与内容保留。
- `service-prepare/install/start/stop/status/uninstall/maintain/restore-check`：运行构建产物，不依赖交互式 shell 或 pnpm 常驻。
- `pnpm gate:services --live --config /absolute/config.json`：仅在所有项目只读且任务库为空时，测试清单匹配的已安装服务。结束恢复服务，不操作桌面 GUI，不提交模型任务。
- `pnpm service:trial --config /absolute/config.json --start`：记录一次真实起点；不重复覆盖起点。去掉 `--start` 只读统计每分钟样本、未就绪次数和超过两分钟的记录缺口。满 24 小时仍返回待人工验收，不自动宣布通过、不创建提醒。

本地测试：全量 179 项通过（含 21 项 M5），类型、lint、格式通过，当前部署构建通过且摘要未变化。常驻启动后的最终回归未重建运行中的 dist。真实生命周期报告：`.artifacts/m5/2026-09-20T09-02-25.896Z-services-5c0f18ba/report.json`，11 个检查通过，包括：

| 检查                                                         | 本机结果                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| App Server、Gateway、真实飞书连接独立就绪                    | PASS                                                        |
| 第二个 App Server/Gateway 监督实例拒绝抢占                   | PASS                                                        |
| App Server 下线时 Gateway 存活且飞书仍连接                   | PASS                                                        |
| Gateway 先运行，App Server 后启动，自动重连                  | PASS                                                        |
| 自有 Codex 子进程 SIGKILL 后恢复                             | PASS                                                        |
| App Server 监督进程及 Gateway 分别 SIGKILL 后由 launchd 恢复 | PASS                                                        |
| SQLite 在线备份、离线新副本恢复、完整性检查                  | PASS                                                        |
| 两服务停止/启动，卸载/重装后数据和凭据保留                   | PASS                                                        |
| 配置、Secret、数据库、WAL、SHM、socket、plist 权限 600       | PASS                                                        |
| 用户在常驻服务中发送 `/项目` 并收到只读项目列表              | PASS_USER_OBSERVED；数据库为 processed / delivered，各 1 条 |

服务故障测试使用空任务库，没有宣称本轮真实执行了模型任务。任务断线恢复已有 M4 证据；M5 的活跃 WAL、保留 unknown 锁、内容清理不破坏去重由隔离 SQLite 测试覆盖。G1 平台自动重投仍为 PARTIAL。

## 本机服务与状态

当前配置为 `/Users/kex/Code/MyCode/CodexConnector/config/gateway.local.json`，凭据仍引用现有 `feishu.local.json`，无需复制 Secret。2026-09-20 已完成 P00：原 `codexconnector` 保持 `remoteWrite=false`，新增 `m5fixture` 为可执行项目，目录是 `/Users/kex/Code/MyCode/CodexConnector/.artifacts/m5-workspace`，权限 700。配置及数据库已备份，服务重新部署后 healthy/ready/feishuConnected 均为 true；构建未变，配置仅新增此项目。准备证据见 [setup-report.json](../../.artifacts/m5/manual-R01-QYS752/setup-report.json)，待用户通过 `/项目` 确认列表；尚未提交模型任务。

| 项目                             | 实际位置                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| App Server LaunchAgent           | `~/Library/LaunchAgents/io.codexconnector.app-server.plist`      |
| Gateway LaunchAgent              | `~/Library/LaunchAgents/io.codexconnector.gateway.plist`         |
| 运行数据                         | `/Users/kex/Code/MyCode/CodexConnector/.artifacts/gateway-local` |
| 任务库 / Unix socket             | 运行数据下 `gateway.sqlite` / `app-server.sock`                  |
| 清单、健康、服务租约、试运行起点 | 运行数据下 `services/`                                           |
| 结构化日志 / 备份                | 运行数据下 `logs/` / `backups/`                                  |

`.artifacts/gateway-local` 已是常驻运行目录，清理历史探针时必须保留它；迁移运行目录前先卸载服务，再备份和修改配置重新部署。

在项目根目录执行：

```sh
export CODEX_FEISHU_CONFIG=/Users/kex/Code/MyCode/CodexConnector/config/gateway.local.json
pnpm start service-status
pnpm service:trial --config "$CODEX_FEISHU_CONFIG"
```

`healthy` 表示两个 PID 存活且心跳不超过 20 秒；`ready` 要求两个组件就绪和数据库检查通过；`feishuConnected` 单独报告 SDK 连接状态。数据库检查是只读诊断，不能证明下一笔事务一定可写。退出码 0 为整体就绪、2 为未就绪、1 为命令错误。没有新增 HTTP 健康端口。

launchd 使用 `KeepAlive=true`、重启节流 15 秒、`Umask=63`（八进制 077）、退出等待 60 秒，不依赖服务启动顺序。Gateway 的 RPC 重连按 1、2、4…最多 60 秒退避，飞书长连接恢复由官方 SDK 处理。健康状态与 launchd 是否加载分别显示。

App Server 启动前及重新拉起子进程时验证 Node/Codex 基线、构建和配置摘要；禁用该进程的外部 MCP、插件、hooks、apps、多 agent、桌面 notify，核对实际配置后才允许 Gateway 连接派发。不修改全局 Codex 配置。新版 Codex 或变动后的构建不自动接受。

单实例租约独立存放于 `services/leases.sqlite`，不依赖修改任务库 schema；当前任务库为 v8（历史交互升级时为 v4）。父 PID 或其子 PID 仍存活就拒绝接管；只有确认 socket 不在监听、当前用户拥有且 inode 未被替换，才能删除旧 socket。不会使用 `pkill codex` 或清理 GUI 的锁。

## 日常启动与停用

```sh
# 本机已安装；通常无需再次运行
pnpm start service-stop
pnpm start service-start
pnpm start service-status

# 卸载只删除两个自有 plist，保留配置、数据库、日志和备份
pnpm start service-uninstall
```

同一飞书应用只运行一个接收端。运行 G1/M3/M4 临时探针前先 `service-stop`，完成并退出探针后再 `service-start`。不要在常驻服务运行时执行 `pnpm build`、`pnpm verify`、替换 dist 或修改运行配置；`verify` 的最后一步会重建 dist。

首次安装或升级流程：

1. 检查任务、审批、锁与 outbox；排空执行队列，对 unknown 保留证据并人工核对。停止服务不会把 unknown 自动改成失败，也不会自动重跑。
2. 运行 `service-uninstall`，保留运行数据。不要先覆盖仍运行的 dist。
3. 保存停机一致性备份和旧构建。跨 schema 升级时，将旧 `backups/` 移入私有归档目录保留并重建空的私有备份目录；当前备份轮转会检查 schema，不应将旧备份混入新版自动备份队列。验证依赖、源码、协议及运行基线，执行 `pnpm verify`，或安装摘要一致的已验证独立构建。升级 Codex 要先完成 G2 及受影响的真实回归。
4. 执行 `pnpm start service-prepare`：拒绝尚存活的 worker/服务、非终态任务或未知外部库；已有库先生成 `before-prepare-*.sqlite`，再执行有校验和的迁移。生成两个 plist 并 `plutil -lint`，记录绝对 Node/Codex 路径及摘要。
5. 执行 `pnpm start service-install`，再 `service-status`。更改目录或解释器路径时同样重新准备，不能照搬别的机器生成的清单。

准备步骤拒绝残留已安装 plist，因此必须先卸载再生成新清单。Node 原生 SQLite 驱动及当前 Codex 都采用已验证版本；应用自动更新造成不匹配时需重新验证，不应直接改基线数字绕过检查。

## 日志、保留与备份

可选 `service` 配置及默认值：

```json
{
  "service": {
    "logMaxBytes": 5242880,
    "logFiles": 5,
    "backupIntervalHours": 24,
    "backupsToKeep": 7,
    "contentRetentionDays": 30
  }
}
```

两个日志各保留当前文件和最多 5 个轮转文件，每份上限 5 MiB。只记录受控状态、计数和错误类别；每分钟写一条健康及任务/outbox 数量样本。不记录 prompt、回答、Secret、原始 SDK payload 或完整错误对象。子进程标准输出不作为审计日志保存。

Gateway 启动约 30 秒后尝试维护，之后每小时检查是否达到备份间隔；失败写维护失败状态日志并在后续检查重试。使用 SQLite backup API 获取包含已提交 WAL 数据的一致性副本，核验 application_id、schema、迁移校验和、quick_check、外键。默认保留最近 7 个自动备份。升级前备份单独保留，人工核对后清理。

内容保留采用保守的逻辑清理：超过 30 天且已终态、无未决操作的任务，每轮最多 100 条，清空 prompt、结果正文、关联事件、RPC 意图/返回和审批回答等内容。新接收的审批/回答/控制命令会关联对应任务，沿用同样条件；无任务命令只有确认回复已结算时才清理。保留 ID、指纹和去重墓碑，旧消息不会因此再次执行。unknown、未决审批/控制、未确认回执及无法可靠关联的历史事件保留用于核对。批处理及未决状态可能延长实际保留时间。

逻辑清理不代表磁盘物理擦除，也不删除飞书或 Codex 自有历史；WAL 和旧备份仍可能含内容。这些文件必须继续使用私有目录和文件权限。

```sh
pnpm start service-maintain
# 使用上一步返回的 backup 路径；目标父目录先创建为 700，目标文件必须不存在
mkdir -m 700 /private/tmp/codex-restore-check
pnpm start service-restore-check \
  --backup /absolute/path/to/gateway-backup-TIMESTAMP.sqlite \
  --destination /private/tmp/codex-restore-check/checked.sqlite
```

恢复命令只生成新离线副本，不覆盖在线库、不启动 worker。真实回滚必须停止并卸载服务，核对旧二进制支持的 schema/迁移校验和，再处理备份时点以后可能已执行的任务和已发出的消息；历史备份不能未经核对直接上线，否则可能重复执行。schema 不兼容时拒绝恢复，不直接降级 `user_version`。

## 待完成的人工验收

原 T12/R01 起点为 **2026-09-20 19:21:47（北京时间）**，在约 16.13 小时后因用户授权升级提前结束，状态为 `ENDED_EARLY_FOR_AUTHORIZED_UX_DEPLOYMENT`，不计通过。停机前两个服务各有 963 条已汇总样本，没有未就绪采样或超过两分钟的间隔；这些结果不能替代 24 小时验收。原起点、报告、日志和备份保存在 `.artifacts/deployments/ux-20260921-r01/`；更早的只读配置记录也继续保留。

UX-R01 从 **2026-09-21 11:31:51（北京时间）** 开始，在约 48.265 小时后因用户要求增加面板而归档。旧构建未变，两个服务各有 2888 条样本；App Server / Gateway 分别有 1 / 3 条未就绪样本，各有一次超过两分钟的间隔，最长为 304 / 296 秒。没有将间隔原因推定为系统故障或休眠；仍缺人工场景和任务负载验收，不计通过。原报告和日志保存在 `.artifacts/deployments/context-panel-20260923-r01/`。

面板初版观察从 2026-09-23 11:50:53 开始，在约 0.316 小时后因本次状态指标升级归档，不计通过。当前版本观察起点为 **2026-09-23 12:12:03（北京时间）**，最早于 **2026-09-24 12:12:03** 复核。`services/trial.json` 保存新构建摘要和用户跳过重新登录的决定，详见 [当前观察记录](../../.artifacts/deployments/status-metrics-20260923-r01/trial-new.json)。切换后手动备份已通过，仅作为 v6 恢复基线，自动备份仍待独立验证。本机后台持续记录样本，没有创建 Codex 自动化或提醒；休眠、日志缺口、任务和通知仍需复核，满 24 小时不自动验收通过。

每次只做一个动作，并在原专用单聊发送 `/项目` 核对回复：

1. 锁屏：**已通过用户观察及回执联合验收**。用户按锁屏/解锁步骤操作后确认可以收到；独立核对到一条新的 `/项目` 命令为 processed，回复为 delivered，两个服务均 ready。累计两条命令及两条回复均已结算。锁屏动作本身来自用户反馈，未自动采集系统锁屏事件；证据为 `.artifacts/m5/lock-screen.json`。
2. 网络恢复：**Wi-Fi 断开重连已通过用户观察、日志及回执联合验收**。日志在北京时间 17:17:29 记录飞书断开、17:17:44 恢复 ready，采样间隔 5 秒，记录到的未就绪区间约 15 秒；RPC 保持 ready，Gateway PID 未变化。恢复后新增一条 `/项目` 命令 processed、回复 delivered，累计三条均已结算。证据为 `.artifacts/m5/network-recovery.json`。此轮未测试切换到另一网络，也未在断网期间发送消息，不能作为跨网络漫游或 G1 自动重投证据；跨网络切换仍待补测。
   跨网络切换于 2026-09-20 按用户“暂时无法测试”的反馈记为 **DEFERRED_USER_UNAVAILABLE**，仍保留待测，不计通过；有另一可用网络时再补测。记录为 `.artifacts/m5/network-switch-deferred.json`。
3. 休眠唤醒：**已通过用户观察、运行日志及回执联合验收**。用户确认唤醒后收到回复；独立核对到两条新的 `/项目` 命令 processed、回复 delivered，累计五条均已结算。日志记录北京时间 17:21:28 RPC 暂不可用、17:21:40 恢复，随后 17:21:45 飞书连接暂不可用、17:22:00 整体恢复 ready；两个监督进程 PID 未变化。证据为 `.artifacts/m5/sleep-wake.json`。休眠动作和时长来自用户反馈，未采集系统电源事件；没有运行中的模型任务，不据此声称已验证休眠中的任务恢复或持续在线。
4. 重新登录：**SKIPPED_BY_USER**。用户明确要求“不测试这种情况”，已从本轮待办移除，不再等待该操作；重新登录后自动启动仍为未验证，不计通过。记录为 `.artifacts/m5/login-skipped.json`，原 `.artifacts/m5/login-before.json` 仅保留历史快照，不能作为验收证据。该决定已随 T12 新观察记录保留，不会为测试登录而重置起点。
5. 新配置开始观察并满 24 小时后运行试运行报告，人工复核服务重启、未就绪样本、日志缺口、任务终态、锁、failed/unknown outbox 和备份结果。`m5fixture` 的 T05/R01 真实文件写入已通过：文件内容精确匹配、一次 `turn/start`、一次成功创建、最终卡片 delivered、锁为 0；首次命令临时文件权限错误后在同一 turn 内恢复，详见 [T05 验收记录](../../.artifacts/m5/manual-R01-QYS752/T05-R01-acceptance-1789899735013.json)。排队、控制、执行中重启及 24 小时负载仍需各自验收，不能由本项或旧空任务库观察代替。

完成保留范围内的项目后，再按明确的覆盖范围决定 M5/V0.2 是否通过；用户跳过的项目不计通过。M6 GUI 通知扩展已按用户要求提前开发，使用独立构建保留当前 M5/T12 基线；其真实 G3 验收见 [M6 说明](./M6-notify.md)，不计入 M5 通过项。

2026-09-20 T09 补充验收：执行中仅重启 Gateway，App Server 及其子进程保持运行；原 thread/turn 完成、原卡终态已送达、锁释放，没有额外 `turn/start` 或追加。由于用户将 R01 原文发送了两次，本轮以“一行历史内容加本任务一行、重启前后均两行”核对，记录为 `PASS_WITH_BASELINE_ADJUSTMENT`，不声称严格完成了原单行步骤。第一条已结束任务保留为未覆盖故障注入；第二条任务的恢复证据见 [T09 验收记录](../../.artifacts/m5/manual-R01-QYS752/T09-acceptance-1789902352528.json)。此结果不替代 T10 App Server 重启或 T12 持续试运行。

2026-09-20 T10/R01 验收通过：文件写入一行且原任务仍执行时，仅重启专用 App Server，Gateway 保持运行。恢复后的 App Server 只读快照与 Gateway 均确认原 turn 为 interrupted；仅一次 `turn/start`、一次恢复用 `thread/resume`，文件仍为一行，原卡“已打断”终态 delivered、锁为 0。此项允许重启中断任务，不要求命令继续执行或返回成功标记；详见 [T10 验收记录](../../.artifacts/m5/manual-R01-QYS752/T10-R01-acceptance-1789902884612.json)。

2026-09-20 T11/R01 验收通过：在线备份包含 12 个真实任务，恢复到新的私有离线副本；16 张业务表的逐行摘要、schema、完整性和外键均一致，运行库在核对前后也未变化。两个进程租约表不作为离线业务恢复验收对象；未覆盖运行库，也未启动恢复副本的 worker。见 [T11 验收记录](../../.artifacts/m5/manual-R01-QYS752/T11-R01-acceptance-1789903251782.json)。T12 已启动，24 小时观察和分时任务仍待完成。

## 依据与边界

App Server 的传输和协议以本机 `codex app-server --help`、固定版本生成协议和 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 核对；launchd 参数以本机 `man launchd.plist` / `man launchctl` 及 `plutil` 验证。协议仍包含实验性能力，短时本机测试不是生产可靠性承诺。

## 会话展示补齐与独立额度命令（2026-09-23）

本轮已完成 schema v6→v7、19 张既有业务表逐行内容摘要核对、原状态卡更新与手动备份。新话题展示默认模型和思考强度，旧会话只读恢复可用历史统计，账号额度仅由 `/额度` 展示。277 项测试与真实模型用量事件通过；手机命令展示待用户核对。详见 [本轮证据](./session-display-evidence.json)。

12:12:03 开始的观察在约 3.257 小时后因本次授权升级归档，不计通过。当前观察于 **2026-09-23 15:29:44（北京时间）** 重新开始，最早 **2026-09-24 15:29:44** 复核。继续保留用户跳过重新登录测试的决定；没有创建自动化或提醒，满 24 小时不会自动判定通过。M6 通知仍关闭。

2026-09-23 SESSION-NAVIGATION-R03：按用户选择仅展示完整 ID，移除复制操作提示，不添加跳转页。原生复制方案因手机未显示复制图标而未通过，不计为已实现。94 项相关回归通过；服务切换后健康、原面板回执和业务数据一致性均已核对。新构建观察起点、上一轮归档及当前状态以 [会话导航证据](./session-navigation-evidence.json) 为准。

2026-09-23 NAVIGATION-CARDS-R01：项目、帮助、操作提示和任务列表完成分区优化，新增 `/任务 [页码]`。306 项回归与真实飞书组件验证通过；schema v8→v9 副本演练和停机升级保持 20 张业务表记录一致，服务恢复后任务数量、选中态与原面板一致。旧构建和旧备份已归档，v9 手动备份通过。当前观察起点以 [导航卡片证据](./navigation-cards-evidence.json) 为准，手机视觉验收尚待用户确认。
