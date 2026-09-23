# CodexConnector 技术选型

> 决策日期：2026-09-15
> 状态：M0 至 M4 阶段功能已验收。本地 158 项测试通过，真实审批、输入、手机控制、通知兜底及桌面人工交接证据见 M4 报告；M5 已安装并验证常驻服务，系统场景与 24 小时人工值守验收仍待完成，见 [M5 报告](./docs/gates/M5-deployment.md)。G1 自动重投仍待补测。
> 适用范围：macOS、个人使用、飞书单聊、Gateway 自有 Codex 会话。
> 关联文档：[立项说明](./PROJECT_CHARTER.md) · [开发计划](./DEVELOPMENT_PLAN.md)

## 1. 选型结论

采用 **Node.js 24 + TypeScript + 飞书官方 SDK + Codex App Server + SQLite**，在一个根包内按模块组织。优先让任务提交、审批和恢复行为可以追踪、测试和解释。

| 层次            | 采用方案                                                       | 用途                                      |
| --------------- | -------------------------------------------------------------- | ----------------------------------------- |
| 运行环境        | Node.js 24 LTS；首测 24.15.0                                   | 长连接、异步 I/O、本地文件与进程集成      |
| 语言与模块      | TypeScript 6.0.x、strict、ESM、NodeNext                        | 检查协议调用和业务状态类型                |
| 包管理          | pnpm 11.20.0，单根包，精确版本与 lockfile                      | 可复现安装和构建                          |
| Codex 接入      | 独立 App Server；当前固定 `0.155.0-alpha.9.2`（应用内二进制）  | thread/turn、事件流、审批和控制           |
| RPC 传输        | `ws`，优先 WebSocket over Unix socket                          | 持续连接、服务端请求、重连                |
| 飞书接入        | `@larksuiteoapi/node-sdk` 的 Client、WSClient、EventDispatcher | 消息/卡片事件、OpenAPI、连接与 token 管理 |
| 本地持久化      | SQLite + `better-sqlite3`；首测 13.0.3                         | 幂等、任务状态、审批、执行锁和发送队列    |
| 数据访问        | 参数化 SQL、Repository、编号迁移                               | 明确事务边界和数据库约束                  |
| 调度            | SQLite commands/outbox + 进程内调度循环                        | 持久化排队、恢复和受控重试                |
| 配置与边界校验  | JSON + Zod 4                                                   | 配置、飞书动作和已消费协议字段校验        |
| 本地 HTTP / CLI | `node:http` / `node:util.parseArgs`                            | 健康检查、诊断和后续 notify 接收          |
| 日志            | Pino，结构化 JSON                                              | 任务关联、错误分类和脱敏日志              |
| 构建 / 开发     | `tsc` 产出 dist；`tsx` 开发与探针                              | 生产执行 JS，开发直接运行 TS              |
| 测试            | Vitest，Node 环境                                              | 状态机、数据库、异步竞态与故障注入        |
| 静态检查 / 格式 | ESLint + typescript-eslint / Prettier                          | 类型感知规则、TS/JSON/Markdown 格式       |
| 本机部署        | 两个 launchd LaunchAgent                                       | 分别管理 Gateway 和 App Server            |

表中“首测版本”已完成 M0 本机基础验证，实际精确版本已写入 package.json 和 lockfile，详见 [M0 验收记录](./docs/gates/M0-foundation.md)。这不代表已部署或真实门禁已通过，部署不能使用浮动 latest。

2026-09-17 的 Codex 调整来自真实 G2 证据：旧 CLI 0.144.6 无法运行当前 gpt-6-astra；现有 ChatGPT 应用内 0.154.0-alpha.6.2 通过核心生命周期、审批和重连验收。默认二进制及版本固定在 `src/runtime-baseline.json`，重新生成 847 个协议类型文件；全局 CLI 未替换。该版本为 alpha，App 更新后须检查版本漂移并重跑门禁。具体覆盖见 [G2 报告](./docs/gates/G2-rpc.md)。

2026-09-20 应用内二进制已更新为 `0.155.0-alpha.9.2`。M4 探针的版本门禁先拒绝旧基线，核对差异后重新生成 865 个类型及 Schema；审批/权限/输入/控制接口不变，新增 thread 元数据兼容现有解析。已通过生成产物比对、隔离 RPC 和真实 M4 控制回归；其余真实覆盖见 [M4 验收](./docs/gates/M4-interactions.md)，旧版报告不自动继承为新版的完整验证。

## 2. 运行环境与工程工具

### 2.1 Node.js 与 TypeScript

选择 Node.js 便于直接使用飞书官方 Node SDK 和 Codex 生成的 TypeScript 协议类型，也适合本项目以网络等待为主的任务。首期不增加另一门服务端语言或第二套运行时。

工程使用 `type: module`、`module: NodeNext`、`moduleResolution: NodeNext`，明确 `target: ES2023`、`lib: [ES2023]` 和 Node 类型。开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 和 `noEmitOnError`；源码相对 import 使用对应产物的 `.js` 扩展名。构建入口固定为 `node dist/index.js`，M0 提供命令帮助和诊断，常驻业务在后续实现。[TypeScript 模块选项](https://www.typescriptlang.org/tsconfig/module)

TypeScript 固定为 6.0.3，实际安装的 typescript-eslint 8.70.0 声明 TypeScript peer 范围为 `>=4.8.4 <6.1.0`，安装与编译已验证。7.x 升级留待整套工具链支持后评估。[解析器版本约束](https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/typescript-estree/package.json)

### 2.2 构建与质量检查

- `tsc` 负责类型检查与生成 JS，SQL 迁移和必要静态资源由构建脚本复制；发布包必须包含这些资源。
- `tsx` 只用于开发与探针；最终验收包含直接运行 dist，发现开发解析器掩盖的 ESM 或资源路径问题。
- Vitest 使用独立配置和 Node 测试环境，锁定版本已经 M0 验证。后续假时钟测试退避/超时，真实临时文件库测试事务与恢复；网络、进程测试使用真实时钟。[Vitest 文档](https://vitest.dev/guide/)
- ESLint 开启 `no-floating-promises`、`no-misused-promises` 等类型感知规则。后台任务必须有明确错误处理，不能用 `void promise` 隐藏拒绝。Prettier 统一排版，避免再引入另一套格式化器。[规则源码与行为说明](https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/docs/rules/no-floating-promises.mdx)
- 生成的协议代码单独存放，不手工修改；业务静态检查与生成代码排版规则分开，但生成类型仍参与 typecheck。

## 3. Codex 接入决策

### 3.1 使用 App Server

Gateway 连接独立 App Server，不直接承担模型请求和工具执行。所需能力集中在长期 thread、turn 事件、审批和运行中控制，选用 App Server 作为唯一 Codex 执行入口。

生产优先 Unix socket；loopback WebSocket 用于门禁和诊断。`ws` 已提供 Unix socket 客户端能力，传输层负责把服务端的 `unix://PATH` 配置转换为客户端对应形式。Unix socket 上仍有 WebSocket 握手和分帧，不能当普通 JSON 字节流；具体路径、鉴权和握手行为由 G2 验证。[App Server 官方文档](https://learn.chatgpt.com/docs/app-server)、[ws IPC 文档](https://github.com/websockets/ws/blob/master/doc/ws.md#ipc-connections)

不使用 shell 的 `codex exec` 输出作为主协议，也不使用 GUI 自动点击实现控制。stdio 可用于独立诊断，但不作为常驻连接，因为生产要求 Gateway 重启与 App Server 生命周期分离。

### 3.2 协议与权限边界

- 从固定 CLI 生成 TypeScript 类型和 JSON Schema；保存版本、生成命令及产物摘要。生成命令以本机帮助为准，不能复制网站的新字段到旧 CLI。
- RpcClient 负责握手、ID、超时、连接代次、事件和服务端请求分发；Domain 负责操作是否可以执行。
- Gateway approvalId 与原始 RPC request ID 分离；保存 ID 的类型和值及连接代次。跨连接的审批恢复必须依据 G2 证据。
- 使用项目白名单和显式权限策略；正常写任务采用 workspace-write 与人工审批，不提供飞书修改任意沙箱策略的入口。
- 模型不作为 Gateway 的新依赖。复用用户在 Codex 中配置的模型与登录方式，M0/G2 记录实际配置的非敏感标识；Gateway 不读取或复制登录凭据内容。

launchd 拥有两个常驻进程。Gateway 仅连接、重连和核对；门禁脚本可以启动自己拥有的临时 App Server，并负责清理。

## 4. 飞书接入决策

使用企业自建应用和官方 Node SDK，默认走长连接。M3 使用 WSClient + EventDispatcher 接收事件，发送、更新、历史与单消息读取使用固定飞书域名的 HTTP 适配器；业务侧自己维护 durable inbox、commands 和 outbox。

官方 Channel 高层封装包含去重、批处理、发送重试和降级等行为。为了明确命令何时持久化、失败是否可重试，首期不把这些业务语义交给 Channel。低层 SDK 的内部重试和确认行为同样需要查看固定安装版本并实测，选择底层接口本身不等于已获得可靠投递保证。[飞书 Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)

确定的接入约束：

1. 读取原始 tenant/app/open_id、事件身份和 message/card 关联，不混用 user_id、union_id 的静默 fallback。
2. 合法命令提交 inbox 与 commands 的短事务后才返回成功确认；业务执行和卡片发送在异步调度中完成。
3. G1 必须验证 handler 的完成/抛错如何影响协议 ACK；如果 SDK 提前确认或吞掉持久化错误，先修适配方式，不能按现有设计宣称可靠。
4. 选择新版卡片 schema，按真实 `card.action.trigger` 实现回调响应；进行中与终态优先使用同一消息更新，流式卡片放到基础闭环以后。
5. SDK 负责长连接握手及重连；HTTP 适配器独立缓存 tenant token，在进入持久化发送阶段前鉴权。变更请求不自动重试，由 outbox 按 HTTP 和业务码分类处理；结果未知时只读核对远端回执，找不到回执仍保持 unknown。

M3 未新增依赖，使用 Node 原生 fetch 并限定官方域名、超时和禁止重定向。卡片 DSL、动作 nonce 和回执标记先持久化；新卡通过历史消息核对，更新卡通过原 message_id 核对。需要启用 `im:message.history:readonly`，启动时验证该权限。平台失败事件自动重投仍未观测，提供按原 message_id 核实并补收的命令，不依赖用户重新发送正文。

长连接卡片门禁失败时，保留本地核心开发；完整 V0.1 仍被阻塞。文本控制可以作为范围缩减后的试用，公网 HTTPS webhook 则需要单独确定部署边界。

## 5. 数据库、调度与恢复

### 5.1 SQLite + better-sqlite3

Gateway 数据放在本机 SQLite 文件中，不运行独立数据库服务。数据库负责保存控制事实，不复制整套 Codex 对话存储。

| 持久化职责                       | 对应业务价值                                 |
| -------------------------------- | -------------------------------------------- |
| inbox / commands                 | 消息重推可识别，进程退出后未处理命令仍可查   |
| threads / tasks / rpc_operations | 保存归属、任务状态和已发起但结果待核对的操作 |
| approvals                        | 记录审批身份、关联请求、有效性和已选择结果   |
| outbox                           | 飞书故障后继续发送，防止旧卡片更新覆盖终态   |
| execution_locks / user_context   | 隔离同目录任务，防止上下文切换后操作串台     |

选择 better-sqlite3 的短同步事务、参数化语句和 backup API，将驱动封装在 persistence 模块。固定 13.0.3 的 macOS arm64 本机加载、只读/事务/备份及锁竞争验证已通过，内嵌 SQLite 为 3.53.4。[驱动 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)、[本机验证记录](./docs/gates/M0-foundation.md)

比较 Node 内置 `node:sqlite`：Node 24.15.0 的文档将它标为 Stability 1.2 / Release candidate。它可以减少外部驱动依赖，但首期优先选择已有事务与备份使用模式的 better-sqlite3。这是 API 成熟度和部署成本的取舍，不意味着 SQLite 数据库引擎不可靠。[Node 24.15.0 SQLite 文档](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)

better-sqlite3 的原生模块是部署成本：记录 Node、macOS、CPU 架构、驱动与内嵌 SQLite 版本，验证目标机器的发行包可加载。按实际包决定是否需要构建脚本或编译工具，不能照旧教程默认执行 node-gyp，也不能为安装一个包全局放开所有依赖脚本。安装失败时先定位版本/架构/脚本问题；驱动替换需要更新本决策并重跑存储测试。

### 5.2 数据访问和持久性

采用参数化 SQL + 小型 Repository，不引入 ORM。当前核心是唯一键、短事务、条件状态迁移和核对，直接 SQL 便于审查这些约束。所有可变值绑定参数，标识符只从本地受控列表选择。

Gateway 库初始配置为 WAL、`foreign_keys=ON`、`synchronous=FULL`，启动时读取确认实际值；busy timeout 使用有界小值，初值 250 ms。WAL + NORMAL 在断电时仍可能回退已提交事务，因此不会仅为降低确认耗时而采用 NORMAL。[SQLite 同步级别](https://www.sqlite.org/pragma.html#pragma_synchronous)

主线程只执行有界短查询和事务；不持有事务等待网络、模型或人工审批。同步驱动在慢磁盘或锁竞争下会阻塞事件循环，G1/存储测试要同时测 ACK 与事件循环延迟。先做索引、分页和查询优化；仍不能满足预算时把重查询移到 Worker Thread，不能通过提前 ACK 回避持久化问题。

迁移使用编号 SQL 和 schema_migrations 记录版本/校验和。启动前检查版本并迁移；失败停止写服务，未知较新 schema 拒绝旧程序写入。在线备份使用驱动 backup API，恢复后检查完整性、外键和业务状态；不复制活跃 WAL 库的单一主文件。

### 5.3 Codex 数据源独立隔离

Gateway 自有库与 Codex 内部库使用不同连接、不同访问接口。Codex 库仅以只读方式打开，不执行迁移或设置 journal_mode；不能给活跃库使用 `immutable` 假设以规避锁。

会话列表与历史优先使用已验证的 RPC；本机项目目录等 RPC 未覆盖的元数据由只读适配层补充。发现表/列后验证 schema，按规范化 cwd 关联，分页查询；不写死 state_5.sqlite 为永远有效的路径。内部 schema 漂移时降级并显示原因，仍允许使用显式配置的已授权项目。

### 5.4 调度和一致性

使用 SQLite 保存排队状态，进程内循环负责唤醒和执行；首期不需要 Redis、BullMQ 或外部工作流引擎。内存队列只优化调度，不作为唯一事实源。

状态规则、早到事件、unknown 保留锁和审批连接代次以开发计划 M0 的可靠性契约为准。数据库、Codex 和飞书之间没有统一事务：目标是可恢复、可核对、按业务身份幂等，不承诺跨系统 exactly-once。

## 6. 配置、诊断和部署

### 6.1 配置和模块边界

运行文件约定在 `~/.codex-feishu/` 下，目录权限 700，敏感文件/数据库/日志权限 600：

| 文件             | 内容                                                    |
| ---------------- | ------------------------------------------------------- |
| config.json      | 项目白名单、操作人、并发、路径和连接选项                |
| credentials.json | 飞书凭据；后续需要的本地通知凭据单独限定作用域          |
| gateway.sqlite   | Gateway 状态及必要 prompt、审批内容；WAL/SHM 同样受保护 |
| logs/、backups/  | 脱敏日志与受保护备份                                    |
| app-server.sock  | 私有连接端点；生命周期由明确的服务所有者管理            |

配置读取路径按 CLI 参数、专用环境变量、默认路径的顺序解析。配置结构由 Zod 校验，启动发现错误直接提示字段；样例只使用占位符。选择 JSON 是为了避免增加 TOML/YAML 运行时解析依赖；Codex 自己的 config.toml 保持其独立配置体系。[Zod 文档](https://zod.dev/)

领域模块不导入 SDK 或数据库驱动。通过 CodexPort、FeishuPort 和具体业务 Repository 接口注入依赖；类型从 config/适配层进入 Domain 后已校验。不引入依赖注入框架、通用插件系统或通用事件总线。

### 6.2 HTTP、日志和服务管理

M5 使用私有心跳文件和 CLI 区分进程存活、RPC 就绪、飞书连接及数据库只读诊断，没有新增 HTTP 端口。后续 notify 入口需要时再用 node:http，并单独做令牌、body 上限和超时控制；诊断只暴露必要状态。第一期没有前端或公开 REST API，因此无需 Web 框架。

Pino 保留为既有日志依赖。M5 监督服务用内置同步写入器输出受控 JSONL，默认每份 5 MiB，当前文件外保留 5 份；只有状态、计数及错误类别，不记录完整 prompt、凭据、审批正文或原始 SDK payload。SDK logger 静默，必要恢复事实写数据库。默认 24 小时在线备份、保留 7 份，对超过 30 天且已结算的任务分批清理正文，保留去重墓碑和未决记录；实际边界见 M5 报告。

launchd 运行构建后的 JS，使用安装时解析出的 Node/Codex 绝对路径和显式配置路径，不能依赖交互式 shell。两个服务各自保活，Gateway 处理启动顺序不确定和重连。LaunchAgent 的使用条件是用户已登录；睡眠期间的持续在线能力依赖本机电源策略及实测。

## 7. 依赖与版本管理

### 7.1 最小直接依赖

运行时直接依赖固定为以下五项，增加其它依赖需要说明具体用途：

- `@larksuiteoapi/node-sdk`
- `ws`（Gateway 直接使用，不能依赖飞书 SDK 恰好传递安装）
- `better-sqlite3`
- `zod`
- `pino`

开发依赖：`typescript`、`tsx`、`vitest`、`eslint`、`@eslint/js`、`typescript-eslint`、`prettier`，以及实际缺少的 `@types/node`、`@types/ws`、`@types/better-sqlite3`。需要覆盖率时添加与 Vitest 同版本的 `@vitest/coverage-v8`。不把只用于测试的 Vite 依赖变成生产构建链。

### 7.2 版本固定方法

1. 当前工程基线：Node 24.15.0、pnpm 11.20.0、应用内 Codex 0.155.0-alpha.9.2；已通过协议和真实控制回归，其余覆盖见 M4 报告。旧 CLI 及 0.154.0-alpha.6.2 的验收结果保留历史记录，不自动继承到新版本。
2. M0 固定 Node 版本文件、`packageManager` 和 `engines`，记录所有依赖精确版本与 lockfile。TypeScript 选择 6.0.x；其余包按兼容稳定版本解析，不根据 GitHub main 的版本号推定包已发布。
3. 在目标 Mac 执行 `pnpm install --frozen-lockfile`、类型检查、静态检查、测试、构建和 dist 启动检查。按固定 pnpm 版本支持的字段限定必要构建脚本。
4. 生产不自动升级 Codex。启动比较实际版本与验证记录，不匹配时进入诊断/只读状态，直到完成对应协议验证。
5. 升级 Node/驱动要验证原生模块及备份恢复；升级 Codex 要重新生成类型并执行 G2；升级飞书 SDK 要执行 G1。记录变更前后版本和回滚条件。

M0 已查询正式注册表并完成依赖解析、精确锁定、frozen-lockfile 安装及组合验证。依赖脚本默认关闭，store 固定在项目内；pnpm 运行前发现依赖不一致时明确报错，避免隐式安装。安装时使用了受限环境之外的联网权限，本机工程检查可在沙箱内执行。

## 8. 替代方案及重新评估条件

| 当前未采用                            | 原因                                         | 何时重新评估                          |
| ------------------------------------- | -------------------------------------------- | ------------------------------------- |
| Python / Go / Bun                     | Node 已覆盖 SDK、协议类型和 I/O 需求         | 出现实际运行瓶颈或明确平台要求        |
| node:sqlite                           | 本机版本仍为候选稳定 API，首期选外部成熟驱动 | API 稳定、接口和部署验证完整后        |
| Prisma / Drizzle                      | 当前表和查询有限，事务语义需要直接可见       | Schema/查询维护成本显著上升时         |
| Redis / BullMQ                        | 单机单进程的队列可与 SQLite 状态一起提交     | 多机调度或量级超出本机存储能力时      |
| NestJS / Fastify / Express            | 首期仅少量本地端点                           | 出现公开 webhook 或较大 HTTP API 面时 |
| React / Web 后台                      | 第一入口为飞书，诊断使用 CLI                 | 用户明确需要复杂可视化管理时          |
| Docker / PM2 / Kubernetes             | 当前运行目标是 macOS 登录会话                | 新增 Linux 服务或多机部署目标时       |
| LangChain / Agents SDK / 直接模型 API | 当前执行入口统一为 Codex App Server          | 产品目标转为自建 Agent 执行引擎时     |

## 9. 选型落地的验证清单

M0 基础验证、G2、M2、M3 和 M4 阶段功能验收已完成；G1 自动重投及后续生产可靠性仍待验证，具体执行顺序见开发计划：

| 检查点      | 必须提供的证据                                                | 阻塞范围            |
| ----------- | ------------------------------------------------------------- | ------------------- |
| M0 工程组合 | 依赖精确版本、无未解决 peer 冲突、生成类型编译、dist 可启动   | 工程基线            |
| M0 SQLite   | 原生加载、事务回滚/唯一键、只读拒写、备份恢复、锁竞争下的延迟 | 持久化实现          |
| G2          | Unix socket 和实际 thread/turn、审批、控制、重连核对          | 真实 Codex 任务闭环 |
| G1          | 新版卡片动作、落库后 ACK、重复投递、存储失败时不成功确认      | 完整飞书闭环        |
| M4/M5       | 未知结果不重跑、卡片不倒退、锁与备份恢复、值守运行            | 日常使用            |
| G3          | 真实 GUI 通知契约和原程序兼容性                               | GUI 扩展            |

M2 已采用现有组件实现正式 SQL 迁移、任务/事件/RPC 意图/锁/outbox 和 CLI，没有新增依赖；真实新建、续跑与 worker 重启恢复结果见 [M2 验收](./docs/gates/M2-tasks.md)。M3 新增 schema v2、飞书命令和通知适配器，102 项本地测试通过，真实结果见 [M3 验收](./docs/gates/M3-gateway.md)。升级前先停止旧 worker、备份 v1，再执行编号迁移；旧程序不能写 v2 数据库。任何实际不兼容都先记录证据、调整对应决策，再更新开发计划。
