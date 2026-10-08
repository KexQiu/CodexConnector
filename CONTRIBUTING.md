# 参与贡献

欢迎提交问题和 Pull Request。建议先阅读 [README](./README.md)、[开发指南](./docs/DEVELOPMENT.md) 和对应模块的验收记录。

## 本地环境

macOS Apple Silicon、Node.js 22.14+（22.x）或 24.x、pnpm 11.20.0。原生 App 还需要 Xcode Command Line Tools 和 Rust 1.90+。使用 `pnpm install --frozen-lockfile`，保持 pnpm/Cargo lockfile 一致。

请使用独立测试项目与数据档案。不要把源码根目录同时设为严格可写的远程项目，开发数据位于它的 `.artifacts` 下。不要同时运行同一机器人的两个网关。

## 修改与验证

- 提交聚焦一个问题；先理解现有任务归属、幂等、执行锁和恢复逻辑。
- 不手工修改 `src/codex/generated` 或协议快照。生成脚本和兼容策略见 [Codex 兼容说明](./docs/CODEX_COMPATIBILITY.md)。
- 提交前运行类型检查、ESLint、格式检查及相关测试；完整命令见开发指南。
- Rust 修改还需通过 `native:test`、`native:clippy`、`native:fmt`；持久层修改需通过 `rust:core:gate`。
- Commit 使用 Conventional Commits，例如 `fix(desktop): preserve Feishu draft when saving projects`。
- PR 说明问题、最终行为和实际验证；未测范围明确列出，不将夹具测试写成真实飞书验收。

## 敏感信息

不要提交 Secret、授权链接或验证码、真实会话正文、SQLite、用户配置、私有日志和安装产物。 `.artifacts` 与本机配置已被忽略，但提交前仍需检查 diff。反馈问题优先使用 App 的脱敏诊断摘要，再人工检查其中的路径和身份信息。

贡献的原创代码采用项目 MIT 许可证。第三方代码需保留原始许可与来源；新增原生运行依赖时应确保安装包的许可收集通过。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。
