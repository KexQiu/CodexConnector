# 本机项目权限与并发配置（CFG-01 / CFG-02）

## 在 App 中配置

1. 等待当前任务结束，点击 **停止连接**。停止会取消尚未执行的队列；运行任务需等到确认终态。仍有 `unknown` 时先恢复并核对，不能通过改配置清掉锁。
2. 打开 **本地项目**，逐项选择远程权限：**禁止远程执行**、**只读分析**、**允许修改项目文件**。新项目默认禁止执行。
3. 对允许执行的项目选择是否 **允许任务联网**。
4. 页面底部选择 **最多同时执行**（1～8 个任务，默认 1）。这不是历史会话数量。
5. 点击 **应用配置**，然后 **启动连接**。运行时可以保存草稿，草稿不会改变有效策略。关闭重开后设置保留。

飞书 `/项目`、`/当前` 展示有效权限。选择项目、切换会话、任务审批不会修改权限或并发数；没有远程配置入口。

## 配置文件

命令行部署的示例：

```json
{
  "maxConcurrentTasks": 2,
  "projects": [
    {
      "key": "analysis",
      "name": "只读分析项目",
      "root": "/absolute/path/to/project-a",
      "remotePermissions": { "mode": "read-only", "networkAccess": false }
    },
    {
      "key": "development",
      "name": "开发项目",
      "root": "/absolute/path/to/independent-project-b",
      "remotePermissions": { "mode": "workspace-write", "networkAccess": true }
    }
  ]
}
```

这是完整配置中的两个字段，其余飞书、Codex 和目录字段仍需保留。`remotePermissions.mode` 可取 `disabled` / `read-only` / `workspace-write`，`networkAccess` 必须显式填写布尔值。

旧 `remoteWrite: false` 仍禁止任务执行；旧 `remoteWrite: true` 保留原来的 workspace-write / on-request 单次审批流程。它不是新的严格权限策略。已有配置在 App 中标注“旧版”，需在本机明确选择新的权限才能切换。`remoteWrite` 和 `remotePermissions` 必须二选一，不能同时配置。旧配置缺少 `maxConcurrentTasks` 时补为 1；保存保留已有并发数。

全局 codex.sandbox / approvalPolicy 保持原示例基线；新权限由项目策略在执行时覆盖，不需要修改这两个兼容字段。

CLI 修改需先停止两个服务，确认数据库无未决任务，修改配置、运行 `pnpm config:check -- --config /绝对路径/config.json`，再按原服务流程重新准备和安装（清单会校验配置哈希）。手工修改正在运行的文件不会热更新。排队任务在领取前会再次核对当前配置；权限关闭或目录改变时拒绝执行。

## 权限的实际范围

| 策略            | 是否接收任务         | 文件修改   | 命令联网 / 网页搜索   |
| --------------- | -------------------- | ---------- | --------------------- |
| disabled        | 否，可查看项目和历史 | 否         | 不执行任务            |
| read-only       | 是                   | 禁止       | 由 networkAccess 控制 |
| workspace-write | 是                   | 项目范围内 | 由 networkAccess 控制 |

新策略在 `thread/start`、`thread/resume` 和每次 `turn/start` 显式下发。使用 `approvalPolicy: never`：沙箱内允许的操作可直接执行，超出范围的操作不能靠飞书审批升级；网关也拒绝权限扩展回调。普通补充问题仍可在飞书回答。继续旧会话时同样覆盖权限；服务端回执不满足本机策略则拒绝启动模型任务。

联网开关不关闭模型服务或飞书连接。关闭时限制沙箱命令联网并关闭网页搜索。网关禁用插件、hooks、apps、子代理；若项目层还启用了未隔离的 MCP 工具，会在创建会话前拒绝该任务，需在本机检查该项目的 Codex 配置。

只读模式限制**写入**，不承诺只允许读取项目目录；读取范围由当前 Codex 沙箱基线决定。可写项目不能包含网关配置、凭据或数据目录；桌面开发数据位于源码的 `.artifacts` 下，因此开发模式下不能同时把整个源码目录设为严格可写项目。请选择独立测试目录。App Server 的启动目录与配置、数据库隔离。

旧审批策略为兼容而保留，无法提供新策略的硬限制。不要把一次“批准命令”理解成修改持久配置，也不要把旧策略的按需联网审批理解成严格禁网。

## 并发、排队与恢复

- 名额在 SQLite 同一事务中计数并领取，`starting`、`running`、`unknown` 都占名额。等待审批、等待输入仍属运行任务。
- 同一 Codex 会话始终串行。同一 checkout 的所有任务也串行，包括只读任务；不会并行读取正在被另一个任务修改的 checkout。
- 目录先做真实路径规范化；同一 Git checkout 的不同子目录、路径别名与嵌套目录不能绕过互斥。独立 worktree 的 `.git` 文件代表独立工作目录，可以并行。
- 调度器按队列顺序寻找可执行任务：队首被目录锁挡住时，可派发其他独立项目。线程创建和 turn 提交仍逐个记账、发送，模型执行可同时进行。
- 只有确认终态才释放名额和锁。断线、丢失回包、重启不会重新发送已有 `turn/start`。中断 ACK 不等于终态。
- 降低并发数不会驱逐已有任务；占用数降到新上限以内才继续派发。App 的“应用配置”仍要求先解决未决任务。

## 验证与手动验收

自动化（允许本机 socket 监听的终端）：

```sh
pnpm test
pnpm typecheck
pnpm desktop:typecheck
pnpm lint
pnpm format:check
node --import tsx scripts/gates/local-policy.mjs
pnpm desktop:build
```

最后一个探针使用独立 CODEX_HOME、临时目录和本机 HTTP 端口，不使用登录、不调用模型、不发送飞书消息。它核对线程策略回执，以及四种权限组合的沙箱写入/越界写入/联网结果；报告位于 `.artifacts/local-policy/`。这不代替完整真实飞书任务验收。

真实验收需要两个**不同 checkout** 的专用测试项目 `cfgA`、`cfgB`，不要使用正式项目。配置两者为允许修改、禁止联网，并发 2，启动服务后分开发送：

```text
/新建 cfgA 这是 CFG_A 验收。仅在当前测试目录向 cfg-a-once.txt 追加一行 CFG_A_ONCE（只追加一次），然后执行 /bin/sleep 30。等待实际结束后只回复 CFG_A_OK。不联网，不读其他文件。
```

```text
/新建 cfgB 这是 CFG_B 验收。仅在当前测试目录向 cfg-b-once.txt 追加一行 CFG_B_ONCE（只追加一次），然后执行 /bin/sleep 30。等待实际结束后只回复 CFG_B_OK。不联网，不读其他文件。
```

两张卡应在前一任务结束前进入执行；两个文件各一行。再向同一个 `cfgA` 连发两个类似任务，应有一个排队。任务结束后停止服务，将并发改为 1、应用、启动，使用新的文件名重复两个项目测试，应串行。不要用相同文件名重测并据此判定重复执行。

随后停止服务，将 `cfgA` 改为只读，应用并启动，发送：

```text
/新建 cfgA 这是 CFG_READONLY 验收。尝试在当前测试目录创建 cfg-readonly-must-not-exist.txt。不要联网；无法写入则只回复 CFG_READONLY_BLOCKED，不尝试提权或申请额外权限。
```

预期文件不存在，不出现允许扩大权限的按钮。再在本机把 `cfgA` 改为禁止执行，应用后 `/新建 cfgA 测试` 应被拒绝。自动化覆盖断线重启、未知占位、权限回执不符、旧数据恢复和审批不可越权；真实多任务退出/重连仍应结合桌面 App 验收清单完成。
