# M0 基础工程验收记录

> 日期：2026-09-15
> 状态：PASS（仅 M0 基础工程；G1/G2/G3 不在此结论内）。
> 工作目录：/Users/kex/Code/MyCode/CodexConnector

## 1. 交付范围

| 任务  | 交付                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------- |
| M0-01 | 单根包、TS/ESM、pnpm、构建/检查/测试入口、README、忽略规则                                                |
| M0-02 | 精确依赖与 lockfile、Node 基线、SQLite 连接与备份基础模块、真实临时库验证、路径/权限约定                  |
| M0-03 | 旧技术方案合并修订为技术契约，第 5 节成为唯一提交顺序，移除冲突 DDL 和伪接口                              |
| M0-04 | ThreadRecord / TaskRecord / ApprovalCorrelation：归属、执行目录、thread/turn/task 语义；实际业务落库在 M2 |
| M0-05 | 七种任务状态、独立 waiting 标志、failurePhase、终态不回退和 unknown 保留锁的状态守卫                      |
| M0-06 | 明确 launchd/App Server/Gateway/探针进程所有权；M0 只提供诊断 CLI                                         |
| M0-07 | 明确本机代理/工具与远端模型推理边界                                                                       |

## 2. 本机及依赖

平台为 macOS arm64；Node 路径由 process.execPath 返回 `/Users/kex/.local/share/mise/installs/node/24.15.0/bin/node`。这是本次记录，未来安装脚本仍需重新发现路径。

| 项目                                    | 实际版本                    |
| --------------------------------------- | --------------------------- |
| Node / pnpm / Codex CLI                 | 24.15.0 / 11.20.0 / 0.144.6 |
| TypeScript / typescript-eslint / ESLint | 6.0.3 / 8.70.0 / 10.10.0    |
| 飞书 SDK / ws                           | 1.74.0 / 8.21.3             |
| better-sqlite3 / 内嵌 SQLite            | 13.0.3 / 3.53.4             |
| Zod / Pino                              | 4.6.5 / 10.3.1              |
| Vitest / Vite（测试依赖）               | 5.0.1 / 8.3.0               |
| tsx / Prettier                          | 4.23.13 / 3.9.6             |

安装启用 strictPeerDependencies，成功生成并复用 lockfile。`pnpm install --frozen-lockfile` 通过，pnpm 对 252 项 lockfile 记录完成策略检查；依赖生命周期脚本关闭，未触发本机源码编译。pnpm 自动记录的三个 release-age 例外仅限 Vitest 5.0.1 及对应 mocker/spy 精确版本。

初次安装使用项目 store 参数，后续执行曾因 pnpm 的默认自动安装检查与 store 设置不一致而尝试联网；已将 storeDir 固定在项目配置，verifyDepsBeforeRun 设为 error，要求显式安装。未修改用户全局 pnpm 设置。

## 3. 检查入口与证据

`pnpm verify` 最终退出码为 0：类型检查、ESLint、Prettier、3 个文件内 15 个测试、生产构建全部通过。下表列出的其它分项命令也均返回 0；`pnpm start --help` 已验证构建产物命令入口可执行。文档本地链接和代码块配对检查通过。

| 命令                                                                                          | 覆盖                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pnpm typecheck`                                                                              | 生产/测试源码、全部生成类型，skipLibCheck=false     |
| `pnpm lint`                                                                                   | 类型感知 Promise 检查等                             |
| `pnpm format:check`                                                                           | 手写代码、配置和文档格式                            |
| `pnpm test`                                                                                   | 配置边界、任务状态不变量、真实 SQLite 基础能力      |
| `pnpm build`                                                                                  | 生产 JS 输出与运行基线资源                          |
| `pnpm run doctor`                                                                             | 本机 Node/Codex 版本、五项运行依赖加载、内存 SQLite |
| `node dist/index.js doctor`                                                                   | 构建产物实际加载与本机诊断                          |
| `pnpm config:check --config /Users/kex/Code/MyCode/CodexConnector/config/config.example.json` | 无密钥样例结构                                      |
| `pnpm protocol:check`                                                                         | 使用本机固定 CLI 重新生成并比对                     |
| `pnpm check:sqlite`                                                                           | 临时数据库与延迟样本，详见附录 JSON                 |

测试不是飞书/RPC Mock 联调，当前不实现网络适配器。SQLite 用例使用真实驱动和临时磁盘文件，包含唯一键回滚、关闭后重开、只读拒写、WAL 备份与完整性、250 ms 锁等待配置、外部库初始化拒绝。配置/状态测试覆盖远端 RPC 地址拒绝、放宽审批策略拒绝、重复项目 key、错误输入不回显、早到终态与 unknown 禁止重新排队。

## 4. 协议与兼容性处理

固定 CLI 生成 671 个 TypeScript 文件和一份完整 JSON Schema；[生成清单](../../src/codex/generated/manifest.json) 记录命令、版本和 SHA-256。默认策略通过生成的 ThreadStartParams 与 ThreadResumeParams 共同类型检查。

生成器只把相对导入转换成 `.js` 或 `/index.js`，不改 wire 字段；`--check` 在临时目录重新生成后比对。Schema 的 experimental 字段只用于描述能力，M1 仍需显式握手和真实验证。

Vitest 的 tinybench 6.1.4 声明引用 DOMHighResTimeStamp；在 tests/compat 中补充与 TypeScript lib.dom 相同的 number 别名，未向生产编译引入 DOM，也未跳过声明检查。

`pnpm doctor` 是包管理器内置命令，项目必须用 `pnpm run doctor`。tsx CLI 的辅助 IPC 在沙箱中触发 EPERM，入口改为 `node --import tsx`，只读命令无需监听 socket。

## 5. SQLite 延迟与限制

本次 [SQLite 检查样本](./M0-sqlite.json) 中，30 次临时小事务 P95 为 0.08 ms；锁竞争等待 308.78 ms，对应事件循环延迟 309.45 ms。设置的 busy timeout 为 250 ms，实际墙钟时间还包含调度开销。该数据只证明本机小样本结果，不构成飞书 ACK、慢磁盘或生产负载 SLA。

备份恢复返回 integrity_check=ok，库和备份为 0600；临时目录由检查与测试清理。M4/M5 仍需验证进程强杀、实际业务恢复、权限目录生命周期、迁移及长期运行。

## 6. 未覆盖与下一步

- 本轮没有启动 App Server、创建真实 turn、发送飞书消息或处理真实审批；G1/G2/G3 均不能标为 PASS。
- 没有读取 credentials.json/auth.json，没有创建 `~/.codex-feishu`、写 Codex 内部库、修改 notify 或安装 LaunchAgent。
- 业务表、编号迁移、Repository、inbox/outbox、调度和重连在 M1/M2 之后实现；M0 类型和状态守卫不能代替持久化实现。
- 未初始化 Git、提交或推送。

下一步按开发计划进入 M1，先实现 G2 传输与生命周期探针。飞书凭据未就绪时不阻塞这一部分。
