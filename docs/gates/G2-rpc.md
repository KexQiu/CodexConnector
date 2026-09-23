# G2：Codex RPC 门禁

- 日期：2026-09-17；平台：macOS arm64。
- 结论：**PASS，允许进入 M2 的 Gateway 自有会话闭环开发**。不代表 M1 的 G1、生产部署或整个 Gateway 已完成。
- 执行基线：Node 24.15.0、pnpm 11.20.0、`ws 8.21.3`、Codex `0.154.0-alpha.6.2`。
- Codex 路径：`/Applications/ChatGPT.app/Contents/Resources/codex`。全局 PATH 中的 `codex 0.144.6` 保持原状。
- 脱敏证据：[G2-evidence.json](./G2-evidence.json)。原始调试日志仅在被忽略且受保护的 `.artifacts/g2/` 中。

## 实际覆盖

| 用例                                 | 结果与证据范围                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 隔离 Home，loopback WS / Unix Socket | PASS；真实 App Server 握手、空列表和请求拒绝；WS health/ready 均 200                                                                        |
| 真实 Home，loopback WS / Unix Socket | PASS；使用现有 ChatGPT 登录，不读取或复制 `auth.json`                                                                                       |
| initialize / initialized             | PASS；请求 ID 从数字 0 开始，等待 response 后才发送 initialized；时序另有夹具断言                                                           |
| legacy 历史                          | PASS；`thread/read(includeTurns: true)` 读取真实持久化 turns，正文不写入脱敏报告                                                            |
| paginated 历史                       | PASS；`thread/turns/list(itemsView: full)` 显式读取分页内容，不能对所有会话硬用 legacy 读取方式                                             |
| 真实完成                             | PASS，Unix Socket；收到 `completed`、固定回答，并从历史补读到同一 turn                                                                      |
| steer                                | PASS，Unix Socket；响应确认同一 turn，最终生成包含补充指令要求的标记                                                                        |
| interrupt                            | PASS，Unix Socket；等到真实命令 `item/started` 后打断，收到 `interrupted`                                                                   |
| 审批接受                             | PASS，Unix Socket；实际服务端请求 ID 为数字 0；单次 accept 后命令 exitCode 0，输出符合预期                                                  |
| 审批拒绝                             | PASS，Unix Socket；实际 offered decisions 提供 cancel，回传 cancel 后命令 declined、无执行输出，turn interrupted                            |
| 断线与恢复订阅                       | PASS，Unix Socket；运行中关闭客户端，新 epoch 握手、`thread/resume`、历史补读，同一 turn 的 completed 在新连接收到                          |
| pending 请求生命周期                 | PASS，Unix Socket；真实执行中的 `command/exec` 断连后变为 unknown，pending 清空，未自动重放                                                 |
| 请求拒绝与 failed 终态               | 不存在的 thread 导致 RPC 请求拒绝；旧 CLI 的模型兼容错误发生在 turn 开始后，收到真实 failed 终态。新版未再故意注入模型 failed，留待 M4 扩展 |
| 进程与目录清理                       | PASS；所有选入证据的自有 App Server 已退出、临时目录已删除；真实 Home 的测试历史保留                                                        |

loopback 的完整模型生命周期、断线时仍待用户处理的审批、服务端崩溃/重启、文件/权限/用户输入审批和长时间稳定性，不包含在本次通过范围；对应 M4/M5 继续验收。已有 GUI 会话只读，没有接管或提交任务。

## 已解决的兼容问题与实现约束

1. **M0 的 CLI 不能运行当前模型。** `0.144.6` 已接受 turn/start，但最终收到服务端明确错误：`gpt-6-astra` 需要新版 Codex。App 内 `0.154.0-alpha.6.2` 随后真实完成了相同任务。项目改用此已验证二进制，不自动安装、替换或升级全局 CLI。它是 alpha 版本，App 更新后必须重新核对版本、生成协议并跑门禁。
2. **生成类型不等于全部运行时能力。** 旧版本对分页历史返回 `paginated_threads is not supported yet`；新版使用分页 API 通过。Gateway 新会话显式使用 legacy 历史模式；读取已有会话必须按 historyMode 分流。
3. **开始回包不等于已可控制。** 新版的一次立即 interrupt 返回 `no active turn to interrupt`。复测改为先等待执行事件再打断。M2/M4 必须处理 starting 阶段控制请求，不得把该错误误报成任务完成，也不应盲目开启新 turn。
4. **审批必须遵循实际可选项。** 命令实际带 `/bin/zsh -lc` 包装；G2 只匹配固定 printf 的精确包装和当前测试目录。拒绝按实际可选项使用 cancel，其语义可使 turn 进入 interrupted。测试不请求 acceptForSession 或规则修订。该预授权只属于门禁夹具，生产客户端没有自动批准逻辑。
5. **配置表会合并。** `mcp_servers={}` 不会清除现有条目。探针读取配置中的服务名称和 enabled 标志，逐项对自有进程传禁用参数，核对生效；插件、hooks、apps、多 Agent 和 notify 仅在探针进程关闭，不改全局配置。
6. **沙箱监听错误单列。** 首次受限环境绑定 loopback 得到 EPERM；在允许本地监听的执行环境中复测通过。没有归因为 Origin 或协议缺陷。

## 协议与代码交付

协议已由最终二进制重新生成：**847 个 TypeScript 文件**。保留 `schemas/codex/0.144.6/` 作为旧版本记录，当前 Schema 位于 `schemas/codex/0.154.0-alpha.6.2/`。生成文件仅做确定性的 NodeNext 导入规范化。

- 类型摘要：`a27994c066a66779a70ae7c312951b7a5f4bc4411ff1b69450c30326a6183d15`
- Schema 摘要：`24df528acec2952e6b96c1c2b061f98e60177d059e12c90cf318621380c9de9e`

候选验证在提升基线前运行，证据里保留 `candidate: true` 和当时旧生成版本；已核对消费的 8 个 v2 定义，没有删除消费字段，随后完成完整重新生成和类型校验。不是绕过版本检查后直接部署。

`src/codex/rpc-client.ts` 实现本地端点限制、WebSocket/Unix Socket、握手、请求关联、双向消息、连接 epoch、审批过期、响应边界校验和有限队列。每个客户端只拥有一条连接，不负责拉起服务器、不重试业务请求。发送结果未知和请求明确拒绝使用不同错误类型。

`scripts/gates/rpc.mjs` 提供可重复实测；代码测试另覆盖数字/字符串 ID 区分、早到事件、迟到响应、超时、旧连接审批、畸形输入、启动重试与测试审批范围。夹具测试不能替代上表真实证据。

## 复测命令

本次工程验收已通过：`pnpm verify`（6 个测试文件、35 个测试，含类型/静态/格式检查和构建）、`pnpm protocol:check`、源码及 dist 的 doctor、配置样例校验、dist 帮助入口。提升基线后再次直接执行 `pnpm gate:rpc`，两种传输通过。最终未发现遗留的探针临时目录；飞书本机文件权限为 `600`。

```sh
pnpm run doctor
pnpm protocol:check
pnpm verify
pnpm gate:rpc
pnpm gate:rpc --home existing
pnpm gate:rpc --home existing --transport unix --live
```

默认使用 `src/runtime-baseline.json` 中的应用内二进制；`CODEX_BINARY` 可以指定其它路径，但版本必须匹配。探针的 `--candidate-version` 只用于明确版本的兼容评估，不能代替更新基线和协议校验。诊断命令只检查本机依赖，不自动重跑或重新认定门禁。

G1 状态见 [飞书门禁](./G1-feishu.md)。M2 可以按计划实现持久化闭环；仍不可宣称已经实现飞书机器人或后台常驻服务。
