# 远程新建项目验收（2026-09-28）

已实现飞书 `/新建项目 名称` 和项目卡“新建项目 → 回复名称”流程。远程只接受名称；保存根目录、创建开关及新项目权限由本机预先配置。成功后选择新项目，不自动执行模型任务。操作步骤见 [App 使用说明](../DESKTOP_APP.md#从飞书新建项目)。

## 本地验证

- `pnpm test`：32 个文件，411 项通过；新增 27 项远程项目测试。
- `pnpm typecheck`、`pnpm desktop:typecheck`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 通过。
- 自动化使用真实临时目录和 Gateway SQLite，覆盖中文名称（含 64 字边界）、路径拒绝、重复消息、已有目录/符号链接、身份/会话边界、权限预设、本机覆盖、移除、目录替换、项目上限、按钮与取消、过期输入、重启恢复和 v9→v10 迁移。
- 故障注入覆盖目录创建后数据库保存失败，以及登记完成后回执事务失败。未知目录保留，不接管、不覆盖；已完成的登记重试不创建第二个项目，也不把名称当作模型任务。
- 隔离 Electron 窗口使用实际 renderer/preload、模拟 IPC 后端，验证默认关闭、开关展开、选择目录、切换权限及草稿缓存。结果和截图保存在 `.artifacts/remote-project-review`；未使用真实飞书或个人配置。
- `pnpm desktop:build` 通过，随包 Node 24.15.0 + SQLite 能从模拟入站消息创建项目，并把下一条需求排入正确目录（未调用模型）。根 `dist` 未改动。
- Electron Forge 打包、`codesign --verify --deep --strict`、`hdiutil verify` 通过。

## 产物

- DMG：`apps/desktop/out/make/CodexConnector-0.1.0-arm64.dmg`
  - SHA-256：`af61803bb21ad8957e8b065209d7535ad5cf72877ee70708d3cbab042b421710`
- ZIP：`apps/desktop/out/make/zip/darwin/arm64/CodexConnector-darwin-arm64-0.1.0.zip`
  - SHA-256：`c8a7b78bd04397e37adf2574d54ccbddbbedc925ecc4c61f76d1cc0e5a6438e6`

内部 Apple Silicon 包，未替换本机已安装 App。真实飞书收发、实际模型执行、跨重启继续对话仍待人工验收，不作为本轮已通过项。新数据库版本为 v10，旧程序不能直接打开迁移后的数据库。
