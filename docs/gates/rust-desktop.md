# Rust 桌面过渡验收

日期：2026-10-08，macOS arm64。

首次 R1 验证的是 Rust/Tauri 宿主与原网关的组合，尚未验证完整 Rust 网关。当时没有切换现有部署，没有迁移真实数据，没有发送飞书消息或启动真实模型任务。后续安装版修复与更新见下文 alpha.2 记录。

## 自动化与本机证据

- TypeScript 完整回归：43 文件、612 测试通过。受限沙箱禁止本机 WebSocket/Unix socket，完整回归在允许本地监听的环境中运行。
- Rust `cargo check`、Clippy（警告视为错误）、rustfmt 及私有目录/外链边界测试通过。
- 根项目、Electron 和 Tauri 前端类型检查、ESLint、Prettier 通过。
- 新增凭据负例：不同随机 nonce、密文篡改、错密钥、旧 Electron 格式；快照不回传 Secret。
- 私有管道门禁：实际启动独立 Node 后端，保存与重开、仅合入飞书字段且保留项目/并发草稿、父管道 EOF、后端子进程退出、诊断模式隔离通过。
- 成品启动发现 Tokio reactor 作用域问题，修复后重新运行实际 App，而非仅依赖编译和签名检查。
- 安装夹具解析 macOS `/var` 临时目录别名后，保留 Tauri 的符号链接保护。启动准备失败会展示原生错误提示并清理后端，不再让 setup 错误直接触发 panic。
- 签名后成品 App 的 WKWebView、React、DesktopApi IPC 及正常停止状态通过隔离冒烟；DMG SHA-256 与 `hdiutil verify` 通过。最终产物以 `.artifacts/native-releases` 中的 `release.json` 为准。
- 只读挂载最终 DMG，复制到源码目录外的中文/空格路径后，签名和实际窗口/IPC 启动检查通过；`release.json.installedSmoke` 保留结果。
- Vite + `tauri dev` 的实际开发窗口启动、React 与 IPC 冒烟通过；标准 `pnpm native:dev` 启用前端热更新和 Rust 文件监听。
- Rust 数据基础另有 7 项测试通过：迁移幂等、校验失败回滚、存活租约拒绝、新版/未知/漂移结构拒绝、WAL 一致性备份、私有目录/文件和 unknown 状态规则。该模块尚未替换活动网关。
- Node ↔ Rust 数据兼容门禁通过：v10 升至 v12、现有 v12 重开、旧 fingerprint 与 request-key 重试、unknown/执行锁/RPC ID/回执保留，以及 Unicode 哈希输入；Node 可以使用 Rust 初始化的数据库。仅操作临时夹具。

最终验收产物：`.artifacts/native-releases/0.2.0-alpha.1/20261008T035311Z`。DMG 为 55,571,159 字节，SHA-256：`fc6bb73d7739d5fc4c08ec2eb7b08eebebc7add37009d7e10819d6971c50ddfc`。

## 体积与当前限制

第一轮成品约 149 MiB（文件逻辑体积），App 磁盘占用约 157 MiB；DMG 约 53 MiB。对比旧版约 505 MiB 的磁盘占用，下降约 69%。这是本机实测，不是全 Rust 版本的预估值。

主要剩余体积：Node 约 114 MiB、生产依赖约 30 MiB、Rust 可执行文件约 8 MiB。依赖按版本去重，并只保留 macOS arm64 SQLite 二进制；安装者仍不需要外部 Node/pnpm。

待验收：真实飞书新建与续聊、扫码配置、取消运行任务与独立桌面任务隔离、安装环境 Keychain 授权、SMAppService 登录项、网络断开与睡眠恢复、Intel。旧网关测试通过不能替代这些新宿主真实验收。

旧 Electron 档案和安装 App 保留；新版本使用独立档案，不具备旧凭据/历史自动迁移入口。Rust 数据基础已验证，但活动网关持久层、Codex RPC 和飞书传输尚未切换，见 [R2–R5](../RUST_REWRITE.md)。

## 0.2.0-alpha.2：安装反馈修复

本机安装后发现侧栏品牌图标缺失、点击启动未显示具体失败原因。定位与修复：

- Tauri 前端未指定共享的 `publicDir`，导致 `connector-mark.svg` 未进入成品。现使用 `apps/desktop/public`；成品验收要求所有页面图片实际完成加载，不能只判断 HTML/React 已打开。macOS App 的 ICNS 原本存在。
- Tauri IPC 拒绝值为字符串，原界面只展示 `Error.message`，因此统一显示“操作失败”。适配层现在保留已脱敏错误文本；未知对象使用通用提示，不能把包含 Secret 的对象序列化到界面。
- 本机 Codex 已是 `0.159.2`，核心协议因 `PlanType` 新增 `promax`、`CodexErrorInfo` 新增 `flexUnavailable`/`tooManyDenials` 被拒绝。沿真实解析代码核对：套餐仅用于展示，错误码按开放值保存并映射通用失败；现仅允许这两处字符串枚举扩展，类型、错误对象变体、权限、审批与任务状态仍受门禁限制。保留当前 CLI 实际导出的 schema，四个捕获版本均通过。
- 安装版正在打开时，发布诊断曾被单实例插件重定向至旧窗口，无法得到隔离验收结果。诊断模式改为独立临时实例，不改变正常 App 的单实例限制；该模式禁止启动服务、读 Codex 数据或修改用户配置。

证据：

- 43 文件、615 项 TypeScript 回归通过；根项目/Electron/Tauri 类型检查、ESLint、Prettier、协议 profile 校验通过。
- Rust Clippy、rustfmt 及 2 项宿主测试通过。私有管道与加密/缓存/父进程清理门禁通过。
- 新增实际启动门禁：源代码及最终 App 随包 Node/后端均能启动 `codex-cli 0.159.2`，核对隔离配置、就绪与登录状态，停止后自有租约及子进程全部退出。使用临时私有 socket，未连接飞书、未执行模型任务。
- 最终 DMG 只读挂载、中文/空格目录复制安装、签名和实际 WKWebView 检查通过；报告中的 `assetsLoaded` 与 `errorsVisible` 均为 `true`。
- 本机 `/Applications/CodexConnector Rust.app` 已更新至 alpha.2；更新后的实际安装路径亦通过图标、错误提示、React 与 IPC 隔离诊断。更新前确认真实运行档案为空，停止并等待旧 App 的自有后端退出；保留旧 App 备份及全部用户数据，不启动正式服务。

最终产物：`.artifacts/native-releases/0.2.0-alpha.2/20261008T073547Z`。DMG 55,992,045 字节，SHA-256：`e40307b814bbb41dd9dc9667f71ff4a7b755ffce77a5625925337e074d5f9813`。旧安装版备份位于 `.artifacts/native-installed-backups/3c1a5926-9b16-4a51-ac0e-253bc5f19301`。

普通聊天继续独立 fail-closed：`0.159.2` 未完成 NP0，不会因项目协议通过而开放新版本的无项目工具能力。初次打包检查时，真实配置连接和窗口目视验收尚未完成；后续结果见下节。

## alpha.2：本机安装版实际验证

使用 `/Applications/CodexConnector Rust.app` 及现有配置，直接操作原生窗口。未替换凭据或调整权限，未发送测试消息，未执行模型任务。

1. 目视确认侧栏品牌图标、总览中央图标和导航图标显示正常，界面版本为 `0.2.0-alpha.2`；保存的 6 个项目仍可见。
2. 检查到旧 Electron 开发版遗留的两台 App Server：旧 supervisor PID 47083 已退出；开发档案租约仍引用进程组 79634、79734。核对用户、父进程、进程组、Codex 路径和 socket，且两台服务器的 `thread/loaded/list` 均为空，才停止这两台自有孤立服务器。未按名称批量终止进程，未修改旧任务数据。
3. 实际点击「启动连接」后，总览显示「长连接在线」「执行后端就绪」。健康文件确认两个组件均为 ready，RPC 与飞书长连接在线、错误为空。当前档案与 socket 运行锁仅有当前后端的一组租约。原先安装环境的 `app_server_unavailable` 由旧服务器占用 socket 导致；独立夹具不会覆盖这一现场。
4. 点击「停止连接」后，两个组件进入 stopped，档案及 socket 租约释放，自有 App Server 27610 已退出。
5. 使用 `⌘Q` 正常退出，自有宿主及 Node 后端 20984、21119、21120 全部退出；独立 Codex 桌面后端 96521 仍存活。配置文件哈希在退出前后一致；SQLite quick_check 正常，schema v12，任务、执行锁、失败事件与 outbox 均为零。
6. 重新打开 App，原配置与 6 个项目保留，默认处于「已停止」，没有自动连接。测试结束保持此状态，供用户自行启动。

脱敏证据保存在 `.artifacts/native-verification/legacy-orphans.json`、`installed-running.json`、`installed-stopped.json` 和 `installed-quit.json`，仅含状态、统计、配置哈希与进程归属；没有凭据或对话正文。

本轮已覆盖真实安装版图标、现有凭据使用、正式飞书连接、Codex 后端启动及正常停止/退出/重开。仍未覆盖真实消息与卡片收发、运行任务中断、异常退出和登录项。无项目普通聊天界面正确显示「暂不可用」，原因仍是 `0.159.2` 未完成 NP0；项目连接功能正常。
