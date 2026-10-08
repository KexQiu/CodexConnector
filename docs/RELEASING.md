# GitHub Release 流程

首个公开版本为 `v0.2.0-alpha.2`，Apple Silicon 预览版。当前没有自动发布或自动更新。

## 发布前

1. 核对版本在 `apps/native/package.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 和 `tauri.conf.json` 一致。
2. 完成开发指南中的相关静态检查、自动化、私有管道和实际启动门禁。更新版本说明，区分已验证与未覆盖场景。
3. 审查 Git diff 与完整公开历史，不包含凭据、真实任务正文、数据档案或私有报告。检查新依赖许可证及来源。
4. 提交并推送准备内容，确认工作树干净，记录源提交。
5. 执行 `pnpm native:build`。保留 `release.json` 本地验收结果；发布使用无本机绝对路径的 `release-metadata.json`。

## 产物

每次原生构建生成：

- `CodexConnector-Rust-<version>-arm64.dmg`
- `release-metadata.json`：版本、平台、源提交、运行时、签名状态、校验和与验收摘要
- `THIRD_PARTY_NOTICES.txt`：第三方许可原文和索引；App 中还包含必要的源码归档
- `SHA256SUMS`：以上三个下载文件的 SHA-256

公开上传前确认 `release-metadata.json` 的 `source.dirty` 为 `false`，commit 与已推送源提交一致；DMG 来源是本轮目录，不使用其他轮次的旧产物。检查 App 资源仅含构建所需内容，没有用户配置或数据库。

## 发布操作

按 `v<version>` 创建 tag，指向已经验收的源提交，正常推送。先创建 GitHub draft Release，上传四个文件，核对名称、大小与摘要；最后发布为 **prerelease**。正文使用对应的 `docs/releases/<version>.md`，注明 macOS/架构要求、未公证、过渡 Node 和能力限制。

不要上传整个 `.artifacts`、本地 `release.json`、真实档案或安装版备份。不要强制覆盖已公开 tag 或替换同版本已下载的二进制；后续修复增加版本号。GitHub 自动生成的 Source code 下载包含 tag 对应源码与许可证。

发布后从公开下载地址下载 DMG，核对 SHA-256，确认仓库可匿名访问、Release 非草稿、tag 和元数据 commit 一致。未做 Developer ID 签名和公证的包不能宣称已经通过 Gatekeeper 分发验收。
