# Rust 桌面重写

本轮采用 Tauri 2 + Rust 宿主 + 现有 React 界面。当前交付是 **R1 过渡版本**：替换 Electron，同时继续使用已验证的 Node 网关；完整 Rust 网关属于下一阶段。不能把此版本称为已经移除 Node 的全 Rust 版本。

## 已实现的边界

| 模块                                      | 当前实现                                                         |
| ----------------------------------------- | ---------------------------------------------------------------- |
| 窗口、应用菜单、关闭与退出                | Rust / Tauri，macOS 系统 WKWebView                               |
| 原生目录选择、剪贴板、官方外链            | Rust 固定用途命令，界面没有通用文件/命令权限                     |
| 单实例、后端管道及退出等待                | Rust，异常断开不会自动重放任务                                   |
| macOS 登录项                              | Rust 调用 SMAppService，仅安装到 /Applications 后允许开启        |
| 凭据加密密钥                              | Rust 调用 macOS Keychain；私有管道交给后端，AES-256-GCM 加密落盘 |
| 飞书引导、项目、缓存、状态与日志 UI       | 复用 React 和 DesktopApi，增加 Tauri 适配层                      |
| 任务、会话、SQLite、Codex RPC、飞书长连接 | 继续使用 Node 后端；R2–R4 待迁移                                 |

另已建立独立 `crates/gateway-core`：Rust SQLite 打开/权限校验、v1–v12 事务迁移、校验和验证、一致性备份、任务状态转换规则及身份/请求/fingerprint 算法。该模块目前用于兼容门禁，**未接入活动网关**；任务调度、配置持久化和协议迁移仍需继续完成。

Rust 只接受本地控制台的固定命令，拒绝远程页面导航与新窗口。Tauri capabilities 未开放通用 shell、文件系统、HTTP 或剪贴板读取。授权链接由后端生成并在 Rust 二次检查；注册说明只允许固定的官方 SDK 文档地址。

Rust → Node 使用继承的 stdin/stdout 管道；Node → 原网关继续使用私有 fork IPC。Secret 与加密密钥不放入命令参数、环境变量或诊断摘要。父进程 EOF/SIGTERM 触发配置连接取消和网关停止，并等待自有后端真正退出。用户退出时先等待两种草稿缓存，实时核对未完成任务，再沿用原有中断与 unknown 规则；不关闭独立 Codex 桌面任务。

## 开发与构建

需要 macOS Apple Silicon、Xcode Command Line Tools、兼容 Node、pnpm 和 Rust。锁定的依赖要求 Rust 至少 1.90，当前实际验证 Rust 1.99.0、Tauri 2.12.1；Cargo.lock 固定解析结果。此工作区工具链已放入 `.artifacts/rust-toolchain`，不会修改系统 PATH，脚本优先使用它；其他开发者可按 [官方 rustup 安装说明](https://rust-lang.org/tools/install/)安装。

```sh
cd CodexConnector
pnpm install --frozen-lockfile
pnpm native:dev
```

`native:dev` 准备独立网关运行时后启动 Vite + Tauri：修改 React/CSS 通过 Vite 热更新，修改 Rust 自动重新编译。修改共享 Node 后端源码后需停止开发 App，再重新运行命令以更新过渡后端。不会覆盖 `dist`、Electron 运行时或现有常驻服务。

```sh
pnpm native:gate
pnpm native:gate:startup
pnpm native:test
pnpm native:clippy
pnpm native:fmt
pnpm native:typecheck
pnpm native:build
```

Rust 后端数据层的独立检查：

```sh
pnpm rust:core:test
pnpm rust:core:clippy
pnpm rust:core:fmt
pnpm rust:core:gate
```

`rust:core:gate` 在临时中文/空格路径创建 Node 数据夹具，验证 Rust 升级 v10、读写 v12 结构与 Node 重开、旧幂等请求重试、unknown 及执行锁保留。包含中文、emoji、控制字符和 Unicode 行分隔符的请求键对照。不会读取真实 Codex 数据、连接飞书或执行任务。数据层依赖 [rusqlite](https://docs.rs/rusqlite/0.40.2/rusqlite/) 的 bundled SQLite 与在线备份 API。

`native:gate` 使用独立中文/空格路径夹具，验证真实私有管道、飞书独立保存、项目草稿保留、加密重开、EOF 与子进程退出；不联网或执行模型任务。`native:gate:startup` 使用当前 Codex 和独立私有 socket，检查实际 App Server 隔离配置、就绪、登录状态读取及自有子进程清理；不连接飞书或执行模型任务。可指定 `--binary /绝对路径/codex`，也可用 `--runtime /绝对路径/runtime` 验收已打包后端。

`native:build` 构建 App、生成 ad-hoc 签名、启动隔离诊断窗口验证 React、图标资源、错误传递和 IPC，再制作并校验 DMG。诊断实例不参与正式 App 的单实例锁，使用临时档案且禁止启动正式服务；不会重定向至已打开的 App。构建产物分别在 `.artifacts/native-target` 和 `.artifacts/native-releases`，不安装、不切换部署、不自动提交。

启动诊断模式使用随机临时目录与内存密钥，屏蔽 Codex 项目读取及配置/任务操作，成功后自动删除夹具。发布检查需要能够打开 macOS 窗口和制作磁盘镜像；受限执行环境可能需要允许对应本机操作。

## 使用与数据

1. 安装 `CodexConnector Rust.app`，首次仍显示准备清单，默认不连接飞书。
2. 在新 App 中填写已有机器人的配置，或走创建流程；保存完成后应用其他草稿，再手动启动。
3. 同一机器人只能有一个活动网关；已有本机运行锁和服务检查仍会阻止重复连接。

开发数据在 `.artifacts/native-user-data`，安装数据在 `~/Library/Application Support/CodexConnector Rust`。与 Electron 数据完全独立。本版本**不自动导入 Electron 配置、凭据或历史**；它们保留在原位置。Electron safeStorage 密文不能直接作为新 AES-GCM 密文使用，不会尝试明文回退或删除旧历史。

应用更新可能重新请求 Keychain 授权。密钥不存在时才创建，Keychain 拒绝/锁定时显示错误，不能创建替代密钥覆盖现有记录。凭据仍只在本机配置，不开放飞书远程修改。

内部包未做 Developer ID 签名和公证，仍可能出现 macOS 来源确认；本机成品启动验证不等于通过所有分发环境的 Gatekeeper 检查。Intel、真实飞书收发、安装环境登录项及真实退出任务回归仍需单独验收。

`0.2.0-alpha.2` 修复安装版侧栏图标缺失，以及 Tauri 错误信息未显示的情况。项目协议检查已覆盖本机 `codex-cli 0.159.2`：只将运行时已经按开放字符串处理的套餐标签和错误码允许扩展，权限、审批、任务状态与错误对象结构仍严格校验。无项目普通聊天使用独立的版本及程序哈希门禁；`0.159.2` 尚未重新完成 NP0，不会因项目协议通过而自动开放。

## 后续完整 Rust 网关迁移

按模块推进，不在 R1 批量改写已验证行为：

| 阶段 | 交付与门槛                                                                                    |
| ---- | --------------------------------------------------------------------------------------------- |
| R1   | 当前：Rust 宿主、React 复用、独立运行时与可测试 App                                           |
| R2   | 已建立 SQLite/幂等兼容基础；继续迁移配置/凭据、会话与任务存储，并接入运行时                   |
| R3   | Rust Codex RPC、版本/能力检查、工作队列、中断、恢复、项目权限和无项目隔离；未知状态不自动重发 |
| R4   | Rust 飞书认证、官方长连接协议、注册/绑定、事件回执、卡片更新及 outbox；重复与丢失回包负例通过 |
| R5   | 移除 Node sidecar，备份数据副本迁移验收，真实飞书/桌面并行任务验收，重新测量包体积后切换      |

持久层必须保留迁移版本与校验和、请求键和 fingerprint 字节级兼容、任务/会话归属、未知 RPC 与 outbox 记录，不用重新执行任务来“补齐”迁移。正式数据切换前需提供一致性备份、旧密文转换方式、失败回退和禁止双网关机制。

协议层必须依据现有探针证据及官方协议实现，特别是飞书二进制帧、分片、心跳、重连、持久 ACK 和 Codex 双向审批请求。扫码 SDK 能获取凭据不能替代发布/权限/事件可用验证；普通聊天策略也继续 fail-closed。每个替换模块必须同时通过旧夹具和 Rust 夹具，核心行为未对齐前保留 Node 实现。

本轮证据见 [Rust 过渡验收](./gates/rust-desktop.md)。
