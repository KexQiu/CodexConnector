# M5 完整测试流程与操作手册

版本：2026-09-20。适用于本项目当前已安装的两个 macOS 常驻服务。

**当前进度：T11 已通过，包含 12 个真实任务的备份与离线恢复记录一致。T12 已从 2026-09-20 19:21:47（北京时间）开始，最早 2026-09-21 19:21:47 复核，当前为 OBSERVING，尚未通过 24 小时验收。** `m5fixture` 可执行、原 `codexconnector` 保持只读；T05、T09（调整计数基线）、T10 的证据保留在各节。其他用例以各自验收记录为准。以下步骤保留作为完整操作指南，已完成项目无需重做。

本轮准备记录：[setup-report.json](../../.artifacts/m5/manual-R01-QYS752/setup-report.json)。旧试运行起点已归档，新观察及抽查进度见 [T12 观察记录](../../.artifacts/m5/manual-R01-QYS752/T12-R01-observation.json)。

## 1. 你需要做什么

推荐采用协作方式：我负责本机准备、进程操作、数据库核对和记录；你只在**之前那个专用飞书机器人单聊**中发送文本、操作当前任务卡片。每完成一项告诉我结果，我核对通过后再进入下一项。

| 顺序 | 内容                  | 你要做的事                     | 我在本机做的事                              | 预计用时     |
| ---- | --------------------- | ------------------------------ | ------------------------------------------- | ------------ |
| P00  | 准备独立测试项目      | 等待环境准备完成               | 备份、增加测试目录、重新部署、确认就绪      | 5–10 分钟    |
| T01  | 只读项目保护          | 向只读项目发送一条测试命令     | 确认没有创建模型任务                        | 1 分钟       |
| T02  | 新建模型任务          | 复制一条 `/新建`               | 核对 task/thread/turn 和通知                | 1–3 分钟     |
| T03  | 回复卡片续跑          | 引用 T02 卡片，发送一条正文    | 核对同一 thread、新 turn、上下文            | 1–3 分钟     |
| T04  | 显式继续及刷新        | 发送 `/继续`，点击刷新         | 核对新 turn 及刷新不会执行任务              | 1–3 分钟     |
| T05  | 文件写入              | 发送一条限定目录的任务         | 核对真实文件内容及变更范围                  | 1–3 分钟     |
| T06  | 排队                  | 按顺序发送 A、B 两条任务       | 确认 A 执行期间 B 排队，每项执行一次        | 2–4 分钟     |
| T07  | 补充指令              | 向正在运行的任务发送 `/补充`   | 分别核对同 turn 投递和模型执行效果          | 2–4 分钟     |
| T08  | 打断                  | 点击一次「打断当前任务」       | 等待 interrupted，确认锁释放                | 1–3 分钟     |
| T09  | Gateway 执行中重启    | 发送任务，之后等待结果         | 只重启 Gateway，核对原 turn 和写入次数      | 2–4 分钟     |
| T10  | App Server 执行中重启 | 发送任务，之后等待结果         | 只重启专用 App Server，核对不重跑及最终状态 | 2–5 分钟     |
| T11  | 备份恢复              | 无需飞书操作                   | 在线备份、恢复到离线副本、比对记录          | 1–3 分钟     |
| T12  | 24 小时试运行         | 分时发送简单探测任务并确认结果 | 定时人工抽查日志、任务、通知和备份          | 至少 24 小时 |

主动操作时间通常约 25–45 分钟，取决于模型响应，不含 24 小时观察。长任务会主动等待 120 秒，给你留出操作时间；不是让你等待 120 秒后再发送补充或打断。

**已通过且本轮不重复要求你操作：**锁屏恢复、Wi-Fi 断开重连、休眠唤醒、空任务库下的进程保活与安装卸载。跨网络切换因暂无条件保留待测；重新登录按你的要求跳过，不再安排退出登录。历史验收范围见 [M5 证据](./M5-evidence.json)。

## 2. 统一操作规则

1. 下方 `text` 代码块中的内容发到飞书；`sh` 代码块中的命令在 Mac 终端执行。不要把终端命令发给机器人。
2. 普通 `/新建` 命令直接在输入框发送，先取消输入框上方已有的引用。**只有 T03 明确要求引用回复卡片。** 否则残留引用可能影响目标判定。
3. 每条任务只发一次。再次发送同样文字会得到新的飞书消息 ID，可能创建第二个任务；这不是消息重投，也不是去重测试。
4. 任务卡中的“任务”是 task ID；不要把 thread、turn 或卡片回执 `GW-…` 当作任务 ID。飞书支持至少 8 位且唯一的任务短 ID；本机 `task` 命令使用完整 task ID。
5. 含 `<T02任务ID>` 等尖括号的代码块是模板，必须替换后再发送，尖括号不保留。协作执行时，我会给你填好实际 ID 的整条命令。
6. 卡片显示“执行完成”只证明模型结束，还要检查预期文本、文件或记录。旧卡片仍可见，不代表旧按钮或旧审批还有效。
7. 15 秒未看到新卡片时先记录现象，60 秒仍没有进展时告诉我；这两个时间是排查提示，**不是可以重发任务的依据**。正常长任务按本项预计时间等待。
8. 本轮标识统一为 `R01`，只用于识别测试内容，不提供幂等保证。需要重测时记录原因并使用新的 `R02` 等标识和新文件名，不覆盖旧证据。
9. 任务处于“结果待核对”时暂停后续执行用例，由我核对原 turn；不要手动清锁、删库或复制原指令重发。

## 3. P00：本机准备，由我执行

### 3.1 固定测试范围

| 项目           | 值                                                                |
| -------------- | ----------------------------------------------------------------- |
| 项目目录       | `/Users/kex/Code/MyCode/CodexConnector`                           |
| 运行配置       | `/Users/kex/Code/MyCode/CodexConnector/config/gateway.local.json` |
| 运行数据       | `/Users/kex/Code/MyCode/CodexConnector/.artifacts/gateway-local`  |
| 新测试项目 key | `m5fixture`                                                       |
| 新测试项目目录 | `/Users/kex/Code/MyCode/CodexConnector/.artifacts/m5-workspace`   |
| 原项目权限     | `codexconnector` 保持 `remoteWrite=false`                         |
| 新项目权限     | 仅 `m5fixture` 设置 `remoteWrite=true`                            |

测试只使用已有专用单聊和凭据，不把 Secret 放进命令、飞书消息或报告。目录作为业务执行白名单；底层沙箱仍依当前 Codex 配置执行，不把白名单描述成操作系统层面的完全隔离。

### 3.2 执行顺序

本节已在本机执行，当前只需完成 3.3 的飞书确认，**不要再次卸载服务或创建同名目录**。以下命令保留用于复核；本轮 `M5_RUN_DIR` 为 `/Users/kex/Code/MyCode/CodexConnector/.artifacts/m5/manual-R01-QYS752`，后续新终端使用本轮记录时应直接设置该路径，不再执行下方 `mktemp`。

先打开一个专用于本轮测试的终端，之后命令沿用该终端的变量：

```sh
cd /Users/kex/Code/MyCode/CodexConnector
umask 077
export CODEX_FEISHU_CONFIG="$PWD/config/gateway.local.json"
export M5_DATA_DIR="$PWD/.artifacts/gateway-local"
export M5_TEST_ROOT="$PWD/.artifacts/m5-workspace"
export M5_RUN_DIR="$(mktemp -d "$PWD/.artifacts/m5/manual-R01-XXXXXX")"
pnpm start service-status
pnpm run doctor --config "$CODEX_FEISHU_CONFIG"
```

先确认没有 starting/running/queued/unknown 任务，没有待处理审批、未决通知和锁；若有则先核对。本轮准备前任务数为 0，六条已有测试回复均 delivered，待处理审批、命令、控制、RPC、通知及锁均为 0；后续重新部署时须再次检查。

随后逐条执行，每一步成功再继续：

```sh
# 保存现有配置和试运行范围；不会打印凭据
cp -p "$CODEX_FEISHU_CONFIG" "$M5_RUN_DIR/config-before.json"
cp -p "$M5_DATA_DIR/services/trial.json" "$M5_RUN_DIR/trial-before.json"
pnpm start service-maintain
pnpm start service-uninstall
```

`service-maintain` 返回备份路径，写入本轮记录。`service-uninstall` 只卸载自有服务，保留数据库及凭据。确认卸载成功后，再创建测试目录、编辑配置；若卸载失败，先处理原因，不能直接改在线配置。

```sh
mkdir -m 700 "$M5_TEST_ROOT"
```

如果目录已存在，不覆盖或清空；先核对是否属于旧测试，重新选目录及轮次。编辑现有配置的 `projects` 数组，**保留原项**，只增加以下项：

```json
{
  "key": "m5fixture",
  "name": "M5 验收项目",
  "root": "/Users/kex/Code/MyCode/CodexConnector/.artifacts/m5-workspace",
  "remoteWrite": true
}
```

保存后核对文件权限仍为 600，确保没有把原 `codexconnector` 改成可写，也没有两个 key 指向同一目录。

```sh
chmod 600 "$CODEX_FEISHU_CONFIG"
pnpm config:check --config "$CODEX_FEISHU_CONFIG"
pnpm start service-prepare
pnpm start service-install
pnpm start service-status
```

本轮只调整配置，可复用现有已验证 dist。若同时变更代码或依赖，必须在卸载后完成 `pnpm verify`，再 prepare/install；**不要对运行中的 dist 执行 build 或 verify**。

`service-status` 必须同时显示 `healthy=true`、`ready=true`、`feishuConnected=true`、`database.status="ok"`；启动中先等约 10 秒复查，持续 60 秒不就绪时排查。

P00 配置变化后，旧的 2026-09-20 17:04 观察仅保留为旧配置证据，当时报表为 `NEEDS_REVIEW`。该记录现已在 T12 归档，当前 `trial.json` 保存 19:21:47 的新起点，并保留“跳过重新登录”的决定；不要重新执行初始化来覆盖本轮起点。

### 3.3 你确认准备完成

我确认服务就绪后，你在飞书发送：

```text
/项目
```

必须看到 `m5fixture · M5 验收项目 · 可执行`，同时 `codexconnector` 仍显示只读，才进入 T01。如果没有这项或显示只读，停在 P00，不继续发送模型任务。

## 4. 飞书逐项操作

### T01：原项目仍然只读

直接发送一次，不引用卡片：

```text
/新建 codexconnector 不使用工具、不读取文件、不联网。只回复 M5_READONLY_R01。
```

**预期：**收到“命令未执行”及“项目未开启 remoteWrite”提示。不会真的输出模型回答。由我确认任务数量没有增加、没有 `turn/start`。这是预期拒绝，记为用例通过，不记作服务故障。

反馈：`T01 已看到只读拒绝`。

### T02：新建一个真实模型任务

```text
/新建 m5fixture 这是 M5_T02_R01 验收。不使用工具、不读取文件、不联网。请记住本次验收口令 M5_CTX_R01_A7，并且这次只回复 M5_NEW_R01_OK。
```

**预期：**收到新的任务卡，最终显示“执行完成”，结果为 `M5_NEW_R01_OK`。任务卡通常会依次显示排队/启动/执行状态，但较快任务可能看不到每个中间状态，不因此判失败。

记录该卡片的任务 ID，称为 **T02任务ID**。我核对：新增一个 task、绑定一个 thread 和一个 turn；对应 `turn/start` 没有第二次提交；最终卡片回执或明确的终态补充通知已确认送达。

反馈：`T02 收到 M5_NEW_R01_OK，任务ID：…`。

### T03：引用同一张卡片，验证上下文续跑

1. 找到 **T02 的完成卡片**，不要用别的任务卡。
2. 手机长按卡片 →「回复」；电脑在该消息菜单中选择「回复」。
3. 确认输入框上方出现 T02 卡片的引用。仅点击「刷新状态」不等于选择回复对象。
4. 发送以下正文，前面**不加** `/新建`：

```text
这是 M5_T03_R01 验收。不使用工具、不读取文件、不联网。只回复上一条任务要求你记住的验收口令。
```

**预期：**产生一张新任务卡，结果为 `M5_CTX_R01_A7`。新 task ID 和 turn ID 与 T02 不同，thread ID 与 T02 相同。续跑本来就应产生新任务和新 turn，并不是“重复执行”。

反馈：`T03 收到口令，任务ID：…`。如果直接在输入框发送而没有引用，本项不算完成，需要核对实际目标。

### T04：显式继续，并检查刷新不重新执行

把下面的 `<T02任务ID>` 换成实际任务 ID，再直接发送，不带任何卡片引用：

```text
/继续 <T02任务ID> 这是 M5_T04_R01 验收。不使用工具、不读取文件、不联网。只回复 M5_CONTINUE_R01_OK。
```

**预期：**新的任务卡完成并显示 `M5_CONTINUE_R01_OK`，仍为 T02 的 thread，再新增一个 turn。

在这张新完成卡上点一次「刷新状态」，卡片更新后再点一次。预期依然是原任务、原结果；任务数量和 `turn/start` 数量都不增加。若原按钮已过期，可发送 `/刷新 <T04任务ID>` 获取新状态。

两次点击可能来自不同卡片版本、具有不同 nonce，本项只验证“刷新不会执行模型”，不把它当成平台重复事件去重证据。

反馈：`T04 继续及两次刷新正常`。

### T05：验证确实能在测试目录写文件

**R01 验收：PASS。** 任务 `edcf1852` 已完成；文件为 15 字节，精确等于 `M5_FILE_R01_OK\n`；一次 `turn/start`，最终卡片 delivered，锁已释放。工具记录有两次命令尝试：首次 heredoc 临时文件创建被拒，未运行 Python；随后使用 `python3 -c` 排他创建并读回成功，没有覆盖或重复成功写入。第二次仍有 Python/xcrun 临时缓存权限提示，已记录，不影响本项实际结果。验证未修改测试文件、重发消息或启动新任务。证据见 [T05 验收记录](../../.artifacts/m5/manual-R01-QYS752/T05-R01-acceptance-1789899735013.json)。以下为原用例，勿重复发送 R01。

先由我确认 `m5-proof-r01.txt` 不存在。然后发送：

```text
/新建 m5fixture 这是 M5_T05_R01 验收。仅在当前测试目录新建 m5-proof-r01.txt，内容为一行 M5_FILE_R01_OK，末尾带换行。文件若已存在，不要覆盖，停止并说明。只读取刚创建的这个文件核对内容，不读取其他文件、不联网、不修改其他文件。成功后只回复 M5_FILE_R01_OK。
```

**预期：**任务完成、文件真实存在、内容精确匹配。不能只凭模型说“写好了”通过。

我在本机核对：

```sh
cat "$M5_TEST_ROOT/m5-proof-r01.txt"
```

如果出现审批，只检查本任务的当前测试目录及指定文件变更；无法确认范围时先告诉我。当前沙箱内写文件可能无需审批，因此“没有弹出审批卡”不算失败；审批专门回归见第 7 节。

反馈：`T05 收到完成结果`，由我补充文件核对结论。

### T06：两个任务排队，分别执行一次

先发送 A：

```text
/新建 m5fixture 这是 M5_T06_A_R01 验收。不读取文件、不联网。只调用一次终端工具执行 /bin/sleep 120。命令结束后只回复 M5_QUEUE_A_R01_OK。
```

看到 A 的卡片显示“执行中”后，立即发送 B，不用等 A 完成：

```text
/新建 m5fixture 这是 M5_T06_B_R01 验收。不使用工具、不读取文件、不联网。只回复 M5_QUEUE_B_R01_OK。
```

**预期：**A 仍在执行时，B 为排队中；A 完成后 B 才开始并完成，两项分别得到对应结果。B 会有自己的任务卡，不能因为有两张卡就认为重复。

如果 A 意外立即完成，或模型没有执行等待命令，本次没有覆盖实际排队窗口，记为“未覆盖”，不靠补发同一条消息假装通过。由我核对后决定是否用新轮次重测。

我核对：两个 task、各一个 `turn/start`，B 的执行没有与 A 重叠，最终锁释放且两个终态通知已结算。

反馈：`T06 A、B 均完成`，或说明 B 是否曾排队。

### T07：正在执行时补充要求

先发送：

```text
/新建 m5fixture 这是 M5_T07_R01 验收。不读取文件、不联网。只调用一次终端工具执行 /bin/sleep 120，命令结束后只回复 M5_STEER_BASE_R01。
```

我确认终端等待命令已开始、turn 仍在执行后，会给你填好实际 ID 的以下命令；收到后立即发送：

```text
/补充 <T07任务ID> 将本任务最终回复改为 M5_STEER_APPLIED_R01。不要再调用工具。
```

**预期分两层检查：**

- 投递：补充被送入原 turn，没有新建 task 或新 turn，控制请求为 accepted。
- 效果：原任务完成后结果为 `M5_STEER_APPLIED_R01`。

仅出现“已送入当前 turn”不能证明模型采用了要求。如果任务已结束，系统应明确拒绝，不创建新 turn；该次不算补充成功，记录为操作窗口未覆盖。

反馈：`T07 最终结果是 …`。

### T08：打断正在执行的任务

```text
/新建 m5fixture 这是 M5_T08_R01 验收。不读取文件、不联网。只调用一次终端工具执行 /bin/sleep 120，命令结束后只回复 M5_INTERRUPT_R01_FINISHED。
```

我确认等待命令已开始后，你在**这张任务卡**上点击一次「打断当前任务」。不是旧审批卡的「取消」，也不是直接回复“已取消”。

没有看到按钮时使用我填好 ID 的命令：

```text
/打断 <T08任务ID>
```

**预期：**最终状态为“已打断”（interrupted），不是仅停留在“已请求打断，等待终态”。我核对原 turn 已结束、锁已释放、没有额外 `turn/start`。若点击前任务已完成，属于窗口未覆盖，不记打断成功。

反馈：`T08 卡片已显示已打断`。

### T09：Gateway 重启时不重复执行

**2026-09-20 验收：PASS_WITH_BASELINE_ADJUSTMENT。** 第一条 R01 任务 `40995b2f` 在检查时已结束，未覆盖执行中重启。请求的新一轮 R02 实际仍收到 R01 原文，形成另一条独立消息和任务 `6340c897`，因此没有继续沿用“一行总数”的判定，而是记录旧任务一行、本任务再加一行。北京时间 19:03:00.970，在本任务写入且等待命令仍执行时只重启 Gateway；监督进程从 60369 变为 47446，App Server 60366 及子进程 60472 不变，19:03:06.959 日志记录整体就绪。原 turn 在 19:04:53 完成，等待命令退出码 0，最终结果 `M5_GATEWAY_RESTART_R01_OK` 的原卡更新 delivered，锁释放。重启前后均为两行、没有第三行，两个用户消息各只有一次追加，本任务只有一次 `turn/start`。本项证明重启恢复和不重复执行；原手册“单次发送、文件总计一行”的操作没有严格照做，不能省略该差异。证据见 [T09 验收记录](../../.artifacts/m5/manual-R01-QYS752/T09-acceptance-1789902352528.json)。R01 文件及历史证据保留，不再重发该消息；R02 检测已停止且未创建 R02 任务。

先由我确认 `m5-gateway-once-r01.txt` 不存在，再发送：

```text
/新建 m5fixture 这是 M5_T09_R01 验收。仅在当前测试目录执行一次终端操作：向 m5-gateway-once-r01.txt 末尾追加一行 M5_GATEWAY_ONCE_R01，随后执行 /bin/sleep 120；只追加一次，不读取其他文件、不联网。等待结束后只回复 M5_GATEWAY_RESTART_R01_OK。
```

你发完后等待即可，不需要关闭终端、应用或电脑。我先确认文件已有且只有一行、task 已绑定原 thread/turn，再**仅重启 Gateway**，保持专用 App Server 运行。具体管理命令见第 6 节。

**预期：**Gateway 自动恢复并核对原 turn；任务最终完成、结果送达，文件仍只有一行。恢复可能有额外 `thread/resume`，但本任务的 `turn/start` 仍只能有一次，task/thread/turn 不变。

若卡片暂时不更新，先由我核对服务和 outbox；不要重新发送任务。未知 PATCH 后收到独立终态补充通知时，单独记录“结果已送达、旧卡仍未核实”，不能写成“旧卡已更新”。

反馈：`T09 收到 M5_GATEWAY_RESTART_R01_OK`，再由我确认写入次数和恢复记录。

### T10：App Server 重启后安全核对原任务

**R01 验收：PASS，实际终态为 interrupted（已打断）。** 任务 `936acd29` 写入一行后仍在执行等待命令；北京时间 19:12:11.993 仅重启专用 App Server。监督进程 60366 → 59887、子进程 60472 → 59946，Gateway 47446 保持运行；19:12:22.734 App Server 就绪、19:12:27.106 Gateway 恢复整体就绪。恢复后的只读 `thread/read` 确认原 thread 只有原 turn，状态 interrupted，与 Gateway 一致。本任务只有一次 `turn/start` 和一次恢复用 `thread/resume`，文件重启前后均为一行，终态原卡 delivered，锁释放。无需等待或补发 `M5_SERVER_RESTART_R01_OK`；本项验收的是安全恢复，不是命令必须完成。记录见 [T10 验收证据](../../.artifacts/m5/manual-R01-QYS752/T10-R01-acceptance-1789902884612.json)。以下为原用例，勿重复发送 R01。

先确认 `m5-server-once-r01.txt` 不存在，再发送：

```text
/新建 m5fixture 这是 M5_T10_R01 验收。仅在当前测试目录执行一次终端操作：向 m5-server-once-r01.txt 末尾追加一行 M5_SERVER_ONCE_R01，随后执行 /bin/sleep 120；只追加一次，不读取其他文件、不联网。等待结束后只回复 M5_SERVER_RESTART_R01_OK。
```

由我确认已经写入一行且任务仍在执行后，仅重启专用 App Server。不要同时操作 GUI 会话。

**这一项不要求一定继续跑完。** App Server 退出可能终止正在执行的工具，必须以原 turn 的真实快照为准：

| 观察结果                                                                              | 判定                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 原 turn 已完成/已打断/失败，本地任务与之相符，锁释放，通知已结算，没有新 `turn/start` | 安全恢复通过，记录实际终态                                     |
| 原 turn 仍在运行，恢复订阅后最终核对到终态，没有重新提交                              | 安全恢复通过                                                   |
| 仍为 unknown，保留锁，没有重跑                                                        | 防重复保护成立，但任务恢复尚未验收通过；暂停后续用例，由我核对 |
| 新建了第二个 turn，或文件被重复追加                                                   | 失败，停止本轮并保留现场                                       |

反馈实际卡片文字，例如 `T10 显示已打断` 或 `T10 显示结果待核对`。不要把“执行失败”统一当成重复执行，也不要把 unknown 统一当成通过。

## 5. T11–T12：备份与持续试运行

### T11：带真实任务记录的备份恢复

**R01 验收：PASS。** 已在线备份并恢复到新的离线数据库：12 个任务（10 completed、2 interrupted）及 16 张业务表，与备份前后运行库完全一致，完整性、外键及 schema 校验通过。比较包含 task/thread/turn、RPC、outbox、审批、控制和执行锁；仅排除两个进程运行租约表。运行数据库未替换，恢复副本没有启动 worker，两个服务 PID 不变且继续就绪。见 [T11 验收记录](../../.artifacts/m5/manual-R01-QYS752/T11-R01-acceptance-1789903251782.json)。以下为原操作步骤，本轮无需再次执行。

由我执行。前提：T02–T10 的任务已核对结束，没有未处理的 unknown/锁/审批。此处关闭执行窗口后再比对，避免备份之后又有新任务导致数量自然变化。

```sh
pnpm start service-maintain
mkdir -m 700 "$M5_RUN_DIR/restore"
```

从维护结果中复制 `backup` 的完整绝对路径，替换下面的占位值后执行：

```sh
M5_BACKUP='/这里替换为维护命令返回的完整备份路径'
pnpm start service-restore-check \
  --backup "$M5_BACKUP" \
  --destination "$M5_RUN_DIR/restore/gateway.sqlite"
```

**通过条件：**integrity 为 ok、schema 一致，task/thread/turn、终态、RPC 次数、outbox 和锁记录一致；备份中确实包含本轮任务。恢复目标为新的离线副本，不覆盖运行库、不启动它的 worker。命令自带完整性及数量检查，记录的逐项比对由我补充完成。

### T12：固定配置后观察至少 24 小时

**本轮初始化已完成，勿重复归档或重设起点。** 起点为 **2026-09-20 19:21:47**，最早复核为 **2026-09-21 19:21:47**（北京时间）；满时长仍须核对任务、通知、日志缺口及新自动备份，不能直接判 PASS。后续查看使用不带 `--start` 的命令。旧配置记录保存在 `manual-R01-QYS752/trial-previous-deployment.json`，跳过重新登录的决定已复制到新记录。

**CHECK_01 已通过，不要重发。** 任务 `9e065e6e` 于 19:22:41 入库、19:24:21 完成，精确返回 `M5_R01_CHECK_01_OK`；一次 `turn/start`、原卡 delivered、锁为 0。见 [首次抽查记录](../../.artifacts/m5/manual-R01-QYS752/T12-CHECK_01-acceptance-1789903463287.json)。后续三个抽查点仍待执行。

主动故障用例结束、配置和构建固定、服务 ready 后开始。旧观察起点已属于旧配置，不能直接沿用“9 月 21 日 17:04”作为新配置验收时间。

由我在同一终端归档旧起点并记录新的真实时间：

```sh
mv -n "$M5_DATA_DIR/services/trial.json" "$M5_RUN_DIR/trial-previous-deployment.json"
pnpm service:trial --config "$CODEX_FEISHU_CONFIG" --start
```

必须先确认归档成功、旧路径不存在，再执行 `--start`；如果已存在新试运行文件，该命令不会覆盖起点。把原来跳过重新登录的决定复制到新记录，**不修改 startedAt**：

```sh
node --import tsx --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readPrivate, writeJson } from './src/service/files.ts';
const archive = join(process.env.M5_RUN_DIR, 'trial-previous-deployment.json');
const path = join(process.env.M5_DATA_DIR, 'services/trial.json');
const previous = JSON.parse(readPrivate(archive));
const current = JSON.parse(readPrivate(path));
assert(previous.skippedManualEvidence.some(item => item.case === 'user-login-autostart' && item.status === 'SKIPPED_BY_USER'));
current.skippedManualEvidence = previous.skippedManualEvidence;
writeJson(path, current);
JS
pnpm service:trial --config "$CODEX_FEISHU_CONFIG"
```

起点与 `earliestReviewAt` 写入本轮记录。这只是服务自身日志加人工抽查，不创建提醒或后台 Codex 定时任务。

| 抽查点                    | 飞书操作                 | 本机检查                                    |
| ------------------------- | ------------------------ | ------------------------------------------- |
| 9 月 20 日 19:21 起点附近 | 下方 CHECK_01 命令，一次 | 新任务完成、回执、服务状态、基线计数        |
| 9 月 20 日约 21:22        | CHECK_02，一次           | 新任务终态、无未核对故障、日志              |
| 9 月 21 日早上方便时      | CHECK_03，一次           | 原约 8 小时点在凌晨，可顺延并记录真实时间   |
| 9 月 21 日 19:21:47 之后  | CHECK_04，一次           | 全部任务/通知核对、自动备份、完整试运行摘要 |

四条消息分别在对应抽查点发送，不要现在一次发完：

```text
/新建 m5fixture 不使用工具、不读取文件、不联网。只回复 M5_R01_CHECK_01_OK。
```

```text
/新建 m5fixture 不使用工具、不读取文件、不联网。只回复 M5_R01_CHECK_02_OK。
```

```text
/新建 m5fixture 不使用工具、不读取文件、不联网。只回复 M5_R01_CHECK_03_OK。
```

```text
/新建 m5fixture 不使用工具、不读取文件、不联网。只回复 M5_R01_CHECK_04_OK。
```

抽查时使用：

```sh
pnpm start service-status
pnpm service:trial --config "$CODEX_FEISHU_CONFIG"
```

**最终检查：**时间确实达到 24 小时；配置/构建摘要未漂移；抽查任务均有明确终态和通知回执；无无法解释的 unknown、重复执行、未释放锁和 failed 事件；自动备份有新记录且可验证。维护检查每小时进行一次，自动备份可能在到达间隔后的下一个检查点产生，不能因为刚满 24 小时就假称第二份自动备份已生成。

日志缺口和未就绪样本必须逐项解释，睡眠、断网和人为故障都要标注实际时间。若修复代码或变更部署配置，保留旧轮次并在新稳定版本上重新观察。报告返回 `NEEDS_MANUAL_ACCEPTANCE` 表示“到时间、待审核”，不是自动 PASS。

## 6. 本机核对与故障操作，供执行者使用

### 6.1 每项需要记录什么

| 字段        | 记录内容                                             |
| ----------- | ---------------------------------------------------- |
| 用例 / 轮次 | 例如 T09 / R01                                       |
| 实际时间    | 开始、注入故障、恢复、结束                           |
| 目标        | task ID、thread ID、turn ID、项目 key                |
| 操作证据    | 用户实际反馈；对应入站消息 ID 或动作身份留在私有报告 |
| 执行证据    | `turn/start` 次数、控制状态、文件内容/行数、终态     |
| 通知证据    | 原卡/补充通知对应的 delivered、failed、unknown 状态  |
| 结果        | PASS、FAIL、BLOCKED、未覆盖、用户跳过；必须写明原因  |

建议每项在 `$M5_RUN_DIR` 保存独立 JSON/Markdown 记录，目录 700、文件 600。公开文档只保留摘要，原始事件正文和凭据不放入报告。历史失败不覆盖成成功，复测使用新记录。

### 6.2 查询具体任务

```sh
pnpm start tasks
# 下面的 ID 必须替换成完整 task ID；不要填 thread 或 turn ID
pnpm start task '<完整任务ID>' --result
pnpm start service-status
```

已固定 schema 的现有运行库可以用这些 CLI 诊断；需要严格只读核对时用下面的 SQLite 查询。不要在常驻服务运行时另启动 `worker` 或 `recover`，它们会尝试持有 worker 租约。

```sh
/usr/bin/sqlite3 -readonly -header -column "$M5_DATA_DIR/gateway.sqlite" <<'SQL'
SELECT task_id,thread_id,turn_id,status FROM tasks
WHERE project_key='m5fixture' ORDER BY created_at;
SELECT r.task_id,r.method,r.state,count(*) AS calls
FROM rpc_operations r JOIN tasks t USING(task_id)
WHERE t.project_key='m5fixture'
GROUP BY r.task_id,r.method,r.state ORDER BY r.task_id,r.method;
SELECT c.task_id,c.kind,c.state,count(*) AS controls
FROM task_controls c JOIN tasks t USING(task_id)
WHERE t.project_key='m5fixture' GROUP BY c.task_id,c.kind,c.state;
SELECT state,count(*) AS records FROM outbox GROUP BY state;
SELECT task_id,lock_key FROM execution_locks;
SELECT state,count(*) AS commands FROM feishu_commands GROUP BY state;
SQL
```

`not_sent` 操作和实际已上线路径要分开统计；不能只看 operation 行数就声称有重复执行。本轮正常条件下每个新任务应只有一次已提交的 `turn/start`。`superseded` 的未发送旧卡片版本是合并结果，不等于通知丢失；unknown 必须保留并核对。

### 6.3 精确重启单个常驻服务

仅用于 T09/T10，执行前先确认测试任务及原 turn 已绑定，并核对 `launchctl print` 中 `path` 是本项目 `~/Library/LaunchAgents/io.codexconnector.*.plist`，与部署清单 hash 匹配。不要操作桌面应用自己的进程。

T09，只重启 Gateway：

```sh
launchctl print "gui/$(id -u)/io.codexconnector.gateway"
launchctl kickstart -k "gui/$(id -u)/io.codexconnector.gateway"
pnpm start service-status
```

T10，只重启专用 App Server：

```sh
launchctl print "gui/$(id -u)/io.codexconnector.app-server"
launchctl kickstart -k "gui/$(id -u)/io.codexconnector.app-server"
pnpm start service-status
```

启动后可先显示未就绪，按 10 秒间隔人工检查，超过 60 秒仍异常先排查。`service-stop` 会停两个服务，不能替代 T09 中“只重启 Gateway”的步骤。没有服务归属证明时，不执行上述故障注入。

现有 `pnpm gate:services --live --config …` 仅支持**项目全部只读且任务库为空**的生命周期探针，已经通过。启用 m5fixture 或创建任务之后不能再直接运行它，更不能删除现有任务库来满足前置条件。

## 7. 项目全量回归与历史门禁

M5 主线沿用已有 M0–M4 证据；没有版本/协议变更时，不要求你把全部审批再点一遍。以下作为必要时的完整回归入口，**不是声称本轮已执行**。

| 范围                                      | 本轮状态 / 使用方式                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 类型、lint、格式、179 项本地测试、构建    | 已有通过证据；变更代码后在停服务状态下重新 `pnpm verify`                                          |
| M3 收发、回复续跑、发送回包丢失后找回原卡 | 已有真实证据；必要时 `pnpm gate:gateway --live --timeout 1800`                                    |
| M4 命令审批允许/取消                      | 已有真实证据；`pnpm gate:interactions --live --suite approvals --timeout 1800`                    |
| M4 逐题输入/取消                          | 已有真实证据；`--suite inputs`，按当前卡片的题号和动态审批 ID 回答                                |
| M4 权限子集/取消                          | 已有真实证据；`--suite permissions`，只选择当前请求列出的子集                                     |
| M4 文件变更允许/取消                      | 已有真实证据；`--suite files`，只使用本轮临时路径                                                 |
| M4 手机补充/打断                          | 已有真实证据；`--suite phone-controls`；该探针仅证明原 turn 控制投递/打断，不证明模型完成补充要求 |
| G1 平台自动重投                           | 仍 PARTIAL；用下方独立用例验证，不能用手动重发或本地模拟代替                                      |
| M6 GUI 通知                               | 本轮范围之外，M5 收尾后再制定专门用例                                                             |

上述 M3/M4 探针是独立运行环境；部分脚本会执行 `pnpm build`。如需复测，先在任务已终态并核对后 `service-uninstall`，再运行探针；所有临时连接退出后重新 prepare/install，并确认构建摘要及试运行范围。探针的 `--config` 指**飞书凭据配置**，常驻服务的 `--config` 指 **gateway 配置**，不能混用。默认探针从 `config/feishu.local.json` 读取，不在命令中写 Secret。

### G1 自动重投补测的实际操作

独立安排，不混入 T02–T12。任务清空执行窗口后，先停止常驻接收端：

```sh
pnpm start service-stop
pnpm gate:feishu --retry-message --timeout 600
```

1. 等待探针输出**本轮新生成的完整测试文本**，由我复制给你；旧轮次的 `G1 …` 文本不能使用。
2. 在专用单聊只发送一次这条文本。
3. 等待报告；不要重复发送，不要再开另一份接收脚本。
4. 程序仅对该条测试消息首次注入写库失败；通过标准是观测到平台再次交付同一事件/消息，并最终只提交一次命令。
5. 600 秒没有观察到自动重投则记录未观察到，不宣布“平台一定不重投”，也不宣布通过。
6. 探针退出后 `pnpm start service-start`，核对常驻状态，并记录本次人为停服务窗口。

若真实业务消息需要恢复，先恢复存储，再由我查到原 `om_…` 消息 ID，使用 `pnpm start feishu-recover-message --message-id <原消息ID>` 入库，由现有 Gateway 处理。恢复原消息和平台自动重投是不同验收项；不要额外启动第二个 Gateway。

## 8. 遇到问题时如何反馈

| 现象                               | 你先做什么                         | 本机核对 / 判定                                                                                    |
| ---------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| 没有卡片或回复                     | 告诉我用例号、发送时间；先不要重发 | 查入站、任务和 outbox，区分未接收、排队、已执行但通知未确认                                        |
| 「目标回调服务未在线」             | 停止点旧按钮，报告对应卡片         | 查常驻状态及是否有旧探针分流；新探针不能自动接管旧卡                                               |
| 「审批/按钮已过期」                | 不再反复点；给出任务 ID            | 查原请求和连接代次；刷新不会复活已失效审批                                                         |
| 「结果待核对」                     | 停止发送新任务，保留卡片           | 按原 thread/turn 核对；不手改状态、不清锁、不重跑                                                  |
| 「会话被占用」                     | 不在桌面打开该测试 thread          | 核对持有者；不终止其他用户任务或强制删除锁                                                         |
| 「执行失败」                       | 提供任务 ID 和卡片文字             | 查看 failurePhase/errorCode，区分预期故障和非预期错误；工具命令非零退出不必然使整个模型任务 failed |
| 原卡旧状态，但收到独立终态补充通知 | 两条消息都保留                     | 结果送达与原 PATCH 核实分开记录，unknown 不被覆盖                                                  |
| 某项来不及操作，任务已结束         | 告诉我“操作前已结束”               | 记未覆盖，核对后用新轮次重测，不能按成功处理                                                       |

最简反馈格式：`T07，已发送补充，最终显示 M5_STEER_BASE_R01，任务ID：…`。不需要你读取数据库或拼装技术日志，也不要发送 App Secret。

## 9. 收尾与结论

测试结束后先确认所有测试任务有明确终态，完成备份和证据归档；unknown 未解决时不能通过删目录或删库收尾。`.artifacts/gateway-local` 是运行目录，不能当普通测试产物清理。

若后续不再使用 m5fixture：在完成任务核对后卸载自有服务，将此项目 `remoteWrite` 改为 false，再 prepare/install；保留目录和历史结果。若决定转入实际项目使用，另行明确项目范围后配置，不能把测试项目授权扩展为所有项目可写。

最终报告分别列出：实现/本地测试、常驻真实任务、故障恢复、通知、备份、24 小时观察、已跳过和未覆盖项目。重新登录仍为用户跳过，跨网络仍为待测，G1 自动重投沿用实际结果；不把这些项目自动写成通过，也不把 M5 的功能通过等同于完整可靠性门禁通过。

**当前阶段：T12 观察中，CHECK_01 已通过；后续按上述时间分别发送 CHECK_02–04，不要一次发送全部消息。**
