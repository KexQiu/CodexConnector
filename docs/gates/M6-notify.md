# M6：桌面通知桥接与 G3 验收

> 2026-09-20：首轮实现、206 项本地测试及独立构建通过；真实 GUI 完成通知已送达飞书且经用户确认，重复事件本地重放通过。临时 notify 配置已逐字节恢复，桥接已关闭；回滚后新桌面任务正常完成，用户确认未再收到对应卡片。G3 仍为 PARTIAL，原 Computer Use 通知功能及剩余场景待验证；未启用常驻转发。M5/T12 继续使用原来的 dist、配置和数据库。M6 开发提前进行，不代表 M5 已通过。

## 1. 功能与边界

通知链路：Codex 调用 wrapper → 原 Computer Use 通知程序；同一 wrapper 将允许范围内的完成事件先写私有 spool，再 POST 到 `127.0.0.1` 的接收入口。Gateway 在一个 SQLite 事务内保存 inbox 去重记录和 outbox 发送意图，之后复用现有飞书发送、重试及回执核对。

依据 [OpenAI 官方通知文档](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)，`notify` 接收一个 JSON 命令行参数，文档列出 `type`、`thread-id`、`turn-id`、`cwd` 等字段，目前明确支持 `agent-turn-complete`。这只是接口依据，不能代替当前桌面版本的真实调用证据。

- 只实现 `agent-turn-complete`。失败、打断没有真实证据时不开放，也不从字段缺失推断成功。
- 原命令数组与新增动态参数通过 `spawn` 原样传递，不经过 shell；stdin 直接继承，不读取、不等待 EOF。捕获记录注明 stdin 类型和读取字节数 0，不声称已观察其内容。
- 先启动原通知程序。新增持久化或 HTTP 失败不阻止原程序运行；保留原程序退出码。HTTP 额外等待最多 1.2 秒，不给原程序新增超时。
- 默认关闭。配置必须明确列出允许通知的项目，cwd 需规范化后精确匹配项目根目录。子目录、worktree、别名歧义不会自动获得通知授权；`remoteWrite` 与通知授权独立。
- 按事件类型、真实 thread/turn 和固定收件人去重，不以正文 hash 代替业务身份。同一 Gateway 自有 thread 由 RPC 任务卡覆盖，GUI 通知不再新增卡片。
- 通知不会创建任务、接管 GUI 会话、提交 RPC、修改用户上下文或生成控制按钮。不能通过回复通知卡接管该会话。
- 不新增表或数据库迁移，继续使用 schema v3；inbox 的 source 为 `gui-notify`。inbox 只保留身份、项目、处理结果和审计 hash；outbox 只保留末尾 1800 字符摘要，不保存输入 prompt。
- HTTP 仅绑定 IPv4 loopback；校验随机令牌、JSON、256 KiB 大小上限及请求期限，拒绝带 Origin 的浏览器请求。ACK 仅表示本地事务已提交，远端飞书送达仍看 outbox。
- spool 目录 700、文件和令牌 600，写入先 fsync 再原子发布。未知 HTTP 结果保留同一文件；重启后分批补收，重复补收不会重复发卡。损坏或越界文件隔离留证，不执行其内容。
- 接收入口故障单独写入服务健康状态和日志，不停止原来的 RPC/飞书任务链路。

spool 不是无限存储：待投递文件上限 1000 个、64 MiB，磁盘写入失败或超限记录 `bridge-error.json`。必须处理异常，不能承诺磁盘故障时仍不丢事件。拒绝/损坏文件需人工核对后清理。已送达 outbox 正文沿用 M5 保留策略；本地捕获证据与配置备份含私人内容，应保存在被忽略的私有目录，验收后按需清理。

## 2. 已实现入口

```sh
# 只查看顶层通知配置，不读取登录令牌
pnpm gate:notify inspect

# 生成新计划目录、完整原始备份、待应用配置、固定版本 wrapper
pnpm gate:notify prepare \
  --directory /absolute/private/new-plan \
  --root /absolute/allowed/project

# 仅安装捕获模式；20 分钟窗口，至多 20 条，要求匹配专用测试标记
pnpm gate:notify install --directory /absolute/private/new-plan

# 恢复原 notify，保留安装后对其他配置项的修改
pnpm gate:notify restore --directory /absolute/private/new-plan

# 只生成待审核转发配置和令牌，不启用转发、不替换在线配置
pnpm gate:notify stage-forward \
  --directory /absolute/private/new-plan \
  --gateway-config /absolute/gateway.json \
  --project PROJECT_KEY
```

准备与安装分离。安装必须匹配计划保存的原配置、待应用配置和 wrapper 摘要；重复安装或并发配置变化会拒绝覆盖。恢复只替换本计划的 notify，其他程序改变 notify 后拒绝覆盖。工具保留配置文件 600，不修改现有 Codex Home 目录权限。为避免损坏复杂 TOML，当前仅支持顶层单行 JSON 兼容的命令数组；不支持的写法明确报错。

可选 `--config /absolute/config.toml` 指定 Codex 配置文件。该参数不是 Gateway 的 JSON 配置；`stage-forward` 的 `--gateway-config` 才是 Gateway 配置。

## 3. 当前 G3 人工验收

本轮计划目录为 `.artifacts/m6/gui-capture-r02`，已完成捕获及正常完成送达测试并恢复配置。原命令为现有 Computer Use 的 `SkyComputerUseClient turn-ended`；保留原始配置备份，未停止桌面应用或其他任务。

第一轮桌面任务 `01a0bea7-ec2f-7b51-b234-caccef1d9864` 的 turn `01a0bea7-f1dc-7ef2-8f89-e2b35b1755dd` 已确认于 19:53:05 完成，用户输入和最终文本实际是 `M6\_GUI\_86388E73`。下划线在富文本复制时被转义，第一版精确标记条件无法匹配。没有捕获 argv，所以原通知是否执行仍未知，不将“桌面任务完成”记为 G3 通过。第一轮配置已恢复并核对与原备份逐字节一致，旧记录保存在 `gui-capture-r01/gui-task-review.json`。

现已修复测试标记匹配：仅比较测试标记时兼容转义，转发给原通知程序的 argv 和保存的证据仍保持原样；新标记统一为纯字母数字。本轮捕获使用 `M6GUI073E1FF8`，原定窗口截至 2026-09-20 20:17:19（北京时间），已于 20:12:10 主动恢复配置并关闭桥接。

第二轮于 20:04:27 收到真实 GUI 通知，已通过完成事件契约验收：client 为 `Codex Desktop`，thread 为 `01a0beb2-52b6-7360-938b-d15c417df564`，turn 为 `01a0beb2-57ad-7952-95da-591cc17ba72c`，单个 JSON argv 中包含真实身份和正确结果。原命令数组匹配，原程序退出码 0；stdin 是字符设备，读取 0 字节。记录位于 `gui-capture-r02/capture-acceptance.json`。退出码成功不能单独代替原 Computer Use 功能的用户观察。

独立飞书探针使用专用标记 `M6NOTIFY34B09750`，正常完成链路已通过。桌面任务 `01a0beb6-b954-7342-844e-ee6e5baa4fc6` 的 turn `01a0beb6-c06d-7fd3-b16a-d5847f91425a` 于 20:08:32 完成；20:08:33 探针核实送达回执，随后用户确认“任务结束后收到卡片了”。真实 thread/turn、最终标记和卡片正文一致；1 条 inbox、1 条 delivered outbox、发送尝试 1 次，任务/RPC/执行锁均为 0，spool 已清空。

原始机器报告保留在 `gui-capture-r02/live-34b09750-254d-4835-889b-548fe981411b/report.json`，其中当时的用户确认状态不回填覆盖；后续用户确认及桌面记录核对写入 `gui-capture-r02/completion-acceptance.json`。在实际送达库的一致性备份上重放同一 GUI 事件两次，均返回 duplicate，记录数不变；重建事件字段的 SHA256 与原 inbox 审计值一致。该结果属于本地重放证据，不是平台自动重投证据，记录位于 `gui-capture-r02/duplicate-replay/report.json`。

探针已退出，全局 notify 已与原备份逐字节一致，bridge 为 disabled。回滚后的新桌面任务 `01a0bebc-9a09-70e2-a705-cd6a76c29340`，turn `01a0bebc-9f04-7191-b299-6f23f910cbb2`，于 20:15:11 正常完成并回复 `M6ROLLBACKOK`；用户随后确认“没有收到卡片了”。独立测试库仍只有原来的 1 条 inbox 和 1 条 outbox，没有该回滚标记的待发记录，spool 为 0。M5 的配置、dist、服务进程和 T12 起点再次核对均未变化。

回滚记录位于 `gui-capture-r02/rollback-acceptance.json`，证明配置恢复、新桌面任务正常完成和用户未观察到对应飞书卡片；不把“没有飞书卡片”当作原 Computer Use 通知功能正常的证据。原 Computer Use 功能观察、真实离线补投及打断/失败仍单独记录，G3-07 的原通知功能部分及完整 G3 继续待验收。早期 capture/completion 报告保留当时的 pending 状态，后续结果以本节及 M6-evidence.json 为准。

1. 桌面 Codex 选择 CodexConnector 项目，新建一个任务。
2. 发送验收负责人提供的专用消息，仅要求回复 `M6GUI…` 标记，不读取文件、不使用工具、不联网。
3. 等待桌面任务实际完成。记录该任务真实 thread/turn，与 `captures/*.json` 中的 argv 对齐，不能拿当前开发任务的完成事件代替测试任务。
4. 核对 payload 类型、字段、cwd、最终标记和原程序退出码。stdout/手工执行 wrapper、CLI 任务、App Server 任务只能作为辅助证据，不能独立将 G3 置为 PASS。
5. 捕获结束恢复原配置，核对原命令数组和原通知功能。当前任务可能缓存通知配置，因此恢复后仍需使用新任务确认；不会为此自动重启整个桌面应用。

如果新任务没有触发 wrapper，记录为“当前桌面调用尚未观察到”，先核对配置加载和版本，不猜测通知格式，不宣布该桌面版本不支持。捕获窗口届满后 wrapper 自动只调用原通知；如要重开窗口，恢复后使用新的计划目录。

完成、打断、失败分开记录。打断测试需对一个仍在执行的专用任务点击停止；失败只使用自然失败或受控失败，不能通过破坏全局配置制造故障。缺少事件应如实标为未覆盖，不据此实现未经验证的事件类型。

## 4. G3 通过后的部署与完整验收

先完成当前 M5/T12，或者明确结束并归档旧观察。不要在原 T12 观察期间覆盖 dist 或在线 Gateway 配置。

`stage-forward` 生成 `gateway.proposed.json` 和 `bridge.forward.proposed.json`，其中通知配置形如：

```json
{
  "notify": {
    "port": 43179,
    "tokenFile": "/absolute/private/plan/token",
    "spoolDir": "/absolute/private/plan/spool",
    "projectKeys": ["PROJECT_KEY"],
    "verifiedEvents": ["agent-turn-complete"]
  }
}
```

在受控部署窗口排空任务，保存一致性数据库备份、原 dist 和服务清单，停止并卸载自有两个 LaunchAgent，再构建 M6、应用审核后的 Gateway 配置、重新 prepare/install。完成监听与令牌核验之后，将 bridge 的设置改为已审核的 forward 配置，并通过新的通知配置计划安装原命令的 wrapper；不要复制早已失效的全局配置快照。Gateway 的 App Server 仍使用进程级 `notify=[]`。

真实验收必须覆盖：

| 用例                | 操作                                                     | 验收条件                                                          |
| ------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| G3-01 正常完成      | 桌面新建专用无工具任务                                   | 真实 GUI 调用、原通知成功、飞书提示卡到达；thread/turn 和回执一致 |
| G3-02 重复通知      | 重放已捕获的同一业务事件                                 | 一条 inbox、一条对应 outbox；不新增任务/RPC                       |
| G3-03 Gateway 离线  | 只停止自有 Gateway，再完成专用桌面任务，之后恢复 Gateway | 原通知仍可用；spool 保留；恢复后补投一次                          |
| G3-04 存储/传输故障 | 隔离测试目录注入写入失败、HTTP 断连或飞书回包丢失        | 不提前 ACK；未知发送不盲目重发；保留诊断和待核对状态              |
| G3-05 范围与隔离    | 非白名单 cwd、错误令牌、过大请求                         | 不发送、不创建任务；原 Gateway 功能正常                           |
| G3-06 打断/失败     | 分别操作专用 GUI 测试任务                                | 分别记录实际事件；无证据就不开放支持                              |
| G3-07 回滚          | 恢复原 notify，再执行新桌面任务                          | 原通知正常；不再新增 Gateway 通知                                 |

CLI 自动断言、用户桌面观察和用户飞书观察需要区分。正常完成的局部通过不代表失败/打断覆盖。M6 不影响 V0.2 的原功能范围；GUI bridge 不通过时保持关闭。

已提供正常完成链路的临时探针，先核实源捕获确实来自 GUI 再显式传入 `--gui-confirmed`：

```sh
pnpm gate:notify:live --live \
  --config /private/plan/gateway.proposed.json \
  --directory /private/plan \
  --capture-file /private/captures/actual-GUI.json \
  --gui-confirmed
```

探针生成新的测试标记，只转发最终答案精确等于该标记的事件。它使用独立 SQLite 和 spool、同一专用飞书单聊的 HTTP API，不启动 worker 或第二个飞书长连接。等待新的 GUI 任务后自动核对身份、无任务/RPC 写入及消息回执，并恢复原 bridge 设置。退出后仍需恢复全局 notify 并验证原通知。探针给出的 `PASS_COMPLETION_DELIVERY_API` 只是正常完成链路 API 回执通过；用户可见送达、打断/失败和回滚要另行确认。

## 5. 本地验证

入口：`tests/notify.test.mjs`。使用真实 SQLite、子进程、文件系统和 loopback HTTP，GUI 调用和飞书远端为模拟。

覆盖事务回滚、身份去重、Gateway 会话抑制、目录白名单、令牌/大小限制、参数及 stdin 透传、错误隔离、离线 spool、重开数据库、回包丢失核对、捕获期限、符号链接拒绝、配置摘要守卫和精确回滚。

本轮构建输出到 `.artifacts/m6/build`，不使用会覆盖在线 dist 的 `pnpm build` 或 `pnpm verify`。执行类型检查、lint、格式检查、全量测试和独立编译；结果写入 [M6 证据](./M6-evidence.json)。
