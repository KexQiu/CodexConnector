# 开发与验证

## 工程结构

| 目录                                    | 职责                                                |
| --------------------------------------- | --------------------------------------------------- |
| `apps/native`                           | 当前 Rust/Tauri 桌面宿主、React 适配与安装包        |
| `apps/desktop`                          | 共享 React UI、DesktopApi，以及保留的 Electron 宿主 |
| `src`                                   | 当前 Node 网关、任务、飞书、RPC、配置与持久层       |
| `crates/gateway-core`                   | 独立 Rust 持久/兼容基础，尚未接入活动网关           |
| `scripts`                               | 独立构建、探针与门禁；产物落到被忽略的 `.artifacts` |
| `schemas/codex` / `src/codex/generated` | 官方协议快照与生成类型，保留 Apache-2.0 许可        |
| `tests` / `docs/gates`                  | 自动化与实际验收证据，公开记录需脱敏                |

完整 Rust 迁移边界和后续阶段见 [Rust 重写说明](./RUST_REWRITE.md)。当前仍包含随包 Node，CLI 保留为开发/诊断入口，未单独发布。

## 开发模式

需要 macOS Apple Silicon、Node.js `^22.14.0 || ^24.0.0`、pnpm 11.20.0、Xcode Command Line Tools 和 Rust 1.90+。

```sh
git clone https://github.com/KexQiu/CodexConnector.git
cd CodexConnector
pnpm install --frozen-lockfile
pnpm native:dev
```

React/CSS 由 Vite 热更新，Rust 修改自动编译。修改 Node 后端后停止开发 App，再重启 `native:dev` 更新独立运行时。开发数据在 `.artifacts/native-user-data`，与安装版数据独立。

首次原生准备需要下载官方 Node 发行包（SHA-256 校验）及锁定的 Cargo 依赖。已有 `.artifacts/rust-toolchain` 时脚本使用工作区工具链；其他环境使用已安装的 Cargo。依赖安装脚本默认关闭，不需要全局修改 Node 或自动安装 Codex。

## 回归

```sh
pnpm typecheck
pnpm desktop:typecheck
pnpm native:typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm native:test
pnpm native:clippy
pnpm native:fmt
pnpm native:gate
pnpm native:gate:startup
```

`pnpm test` 的 WebSocket/Unix socket 夹具需要允许本机监听。`native:gate` 仅操作私有临时档案，不联网或执行模型任务；`native:gate:startup` 只读检查本机 Codex 登录及自有 App Server 生命周期，不连接飞书。Rust 持久层修改另外执行 `rust:core:test`、`rust:core:clippy`、`rust:core:fmt`、`rust:core:gate`。

带 `--live` 的飞书/RPC 门禁可能发送消息或产生模型用量，只对专用测试账号、会话、项目和独立数据执行。不要在运行中的旧 CLI 部署使用 `pnpm build`/`pnpm verify` 覆盖它正在使用的 `dist`；原生构建不会覆盖该目录。

## 构建与发布

```sh
pnpm native:build
```

产物位于 `.artifacts/native-releases/<version>/<UTC时间>/`。脚本收集原始第三方许可证、验证 MPL 源码归档，生成 ad-hoc 签名，执行实际 React/图标/IPC 冒烟、DMG 校验和、中文/空格安装路径验证。不会自动安装、切换部署、提交或上传。

每次构建记录 source commit 与工作树状态。公开 Release 必须来自干净且已推送的提交，与 tag 对齐；发布操作流程见 [RELEASING](./RELEASING.md)。增加依赖后缺少许可文本会明确阻止打包，固定来源补充规则见 [第三方许可说明](../third_party/README.md)。

其他设计文档：[技术选型](../TECH_STACK.md)、[技术契约](../codex-feishu-gateway.md)、[开发计划](../DEVELOPMENT_PLAN.md)、[后续待办](../TODO.md)。历史验收只证明所列版本和场景，不替代新版本真实验证。
