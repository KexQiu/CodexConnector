<img src="apps/desktop/public/connector-mark.svg" width="72" alt="CodexConnector">

# CodexConnector

通过飞书单聊管理个人 Mac 上的 Codex 任务：选择项目、连续对话、处理任务交互，并接收执行结果。桌面 App 负责本机配置、授权和服务启停。

[下载 macOS 预览版](https://github.com/KexQiu/CodexConnector/releases/tag/v0.2.0-alpha.2) · [安装与使用](./docs/GETTING_STARTED.md) · [参与贡献](./CONTRIBUTING.md) · [问题反馈](https://github.com/KexQiu/CodexConnector/issues)

## 下载与要求

当前版本 **0.2.0-alpha.2**：Apple Silicon、macOS 13.5+，复用本机已经安装并登录的 Codex。安装者不需要 Node、pnpm、Rust 或源码。

这是 **Rust/Tauri 宿主 + 过渡 Node 网关**，目前尚未完成全 Rust 后端迁移。使用系统 WKWebView，不再随包分发 Electron/Chromium；每次构建的实际大小、源提交和 SHA-256 见 Release 的 `release-metadata.json`。

下载版使用 ad-hoc 签名，**尚未完成 Developer ID 签名与 Apple 公证**。macOS 可能要求来源确认，处理步骤见 [安装指南](./docs/GETTING_STARTED.md)。目前没有 Intel 安装包或自动更新。

## 开始使用

1. 下载 DMG，将 **CodexConnector Rust.app** 拖入“应用程序”并打开。
2. 在 **应用设置** 检查 Codex 路径、协议和登录状态。
3. 在 **飞书连接** 按“接入机器人 → 完成飞书设置 → 绑定单聊 → 检查并保存”完成配置。可接入已有机器人，也可试用扫码创建；手动教程保留在各步骤中。基础连接检查可跳过，保存后不自动启动。
4. 在 **本地项目** 添加或选择目录，并明确设置远程权限。新项目默认禁止执行；项目、权限和并发修改停止服务后应用。
5. 回到总览 **启动连接**。在机器人专用单聊发送 `/项目`、选择项目，之后直接描述任务；后续消息继续当前会话。

`/当前` 展示项目、会话、模型、上下文与队列；`/会话` 切换历史；`/额度` 单独查看账号用量；`/帮助` 查看完整操作。

关闭窗口或 `⌘Q` 会停止网关，并对未完成任务进入确认和终态核对流程。只清理 App 自己持有的服务，不关闭独立 Codex 桌面任务；无法确认的执行保留未知状态，不自动重复提交。

## 功能与边界

- 飞书分步配置、单聊绑定、基础检查、离线教程和本地草稿缓存。
- 本机项目自动发现、只读/写入权限、并发设置和可选远程新建项目。
- 连续会话、任务卡片、原卡分页与刷新、状态和诊断。
- Keychain 密钥加密保存 Secret，权限配置仅在本机修改。
- 稳定任务 ID、持久队列、幂等收发和未知状态恢复。

当前 `codex-cli 0.159.2` 可通过项目核心协议和 App Server 启动检查。**无项目普通聊天使用独立版本、二进制哈希及策略门禁，对 0.159.2 暂不可用**，不会因为项目检查通过而放开工具限制。其他版本按实际协议检查，未通过时明确拒绝，详见 [兼容策略](./docs/CODEX_COMPATIBILITY.md)。

预览版已验证实际安装的图标、配置、飞书长连接、Codex 后端、正常停止和重开。新宿主上的完整消息/卡片、运行任务中断、异常退出、登录项、新 Mac 环境与扫码端到端仍有待验收项目，见 [验收记录](./docs/gates/rust-desktop.md)。

## 本地数据

安装版数据保存在 `~/Library/Application Support/CodexConnector Rust`，开发版保存在 `.artifacts/native-user-data`。配置、任务数据库、日志与备份留在本机；消息和模型调用仍通过飞书及 Codex 服务，项目没有额外中转云服务。

Rust 与旧 Electron 档案独立，当前不自动导入旧凭据或历史。更新前停止连接并备份数据，不同时运行同一机器人的两个网关。Secret 不经渲染层回传、不放入命令参数或日志；Keychain 不可用时不降级为明文。

## 开发

需要 macOS Apple Silicon、Node.js 22.14+（22.x）或 24.x、pnpm 11.20.0、Rust 1.90+ 和 Xcode Command Line Tools。

```sh
git clone https://github.com/KexQiu/CodexConnector.git
cd CodexConnector
pnpm install --frozen-lockfile
pnpm native:dev
```

React/CSS 热更新，Rust 修改自动编译；Node 后端修改后重启开发 App。`pnpm native:build` 生成独立 DMG，不自动安装或切换运行中的服务。

目录、完整验证和构建命令见 [开发指南](./docs/DEVELOPMENT.md)；Rust 迁移路线见 [R1–R5](./docs/RUST_REWRITE.md)；发布规范见 [Release 流程](./docs/RELEASING.md)。CLI 保留为源码开发与诊断入口，尚未单独发布。

## 许可与贡献

原创代码采用 [MIT License](./LICENSE)。Codex 生成协议、Node、Rust 和其他第三方组件保留各自许可，详见 [NOTICE](./NOTICE) 与 [第三方说明](./third_party/README.md)；下载包内提供许可原文及必要源码。

欢迎 Issues 和 Pull Requests，提交前阅读 [贡献指南](./CONTRIBUTING.md)。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告，勿公开凭据或会话正文。

这是独立社区项目，与 OpenAI 或飞书没有官方隶属关系。
