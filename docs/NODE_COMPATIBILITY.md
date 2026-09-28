# Node 兼容与桌面运行时

更新日期：2026-09-28。

## 支持范围与内置版本

源码开发、测试和后端运行支持 `^22.14.0 || ^24.0.0`，只包含稳定的 Node 22、24，不自动接受奇数主版本、预发布版本或未来主版本。建议使用受支持分支的最新安全补丁；最低版本用于兼容回归，不是安装推荐。

`src/runtime-baseline.json` 的 `nodeSupported` 定义支持范围，`nodeApiMinimum` 定义原生 API 下限；`node` 仍是 App 固定携带的 `24.15.0`。`package.json` 的 engines 与支持范围由测试校验一致。`.node-version` 保留默认开发版本，不代表只有该补丁可以运行。后续更新 App 内置补丁时单独修改 `node` 和 `.node-version`，完成打包回归，不必改变源码支持范围。

安装后的 App 使用包内 Node，用户不需要安装 Node，也不受系统 Node 版本影响。Electron 自身的 Node 与后端运行时仍然隔离。

## 为什么最低不是 22.13

当前 `better-sqlite3 13.0.3` 使用 Node-API 10。虽然其 engines 只写 `>=22`，Node-API 10 实际从 Node 22.14.0 开始支持，见 [Node 官方版本矩阵](https://nodejs.org/api/n-api.html#node-api-version-matrix)。仅根据包的 engines 放开 22.13 会遗漏原生模块边界。

当前驱动发行包包含按系统/架构分发的 Node-API 预编译文件，可以在满足 Node-API 版本的 Node 22、24 间复用，不需要仅因切换主版本就重编译。仍须在目标运行时执行数据库测试；不能把这个结论套到其他 V8 ABI 原生模块或将 Electron 构建结果用于后端。

类型定义固定为 `@types/node 22.20.2`，约束到 Node 22 API 系列。22.13.0 的类型定义在当前 TypeScript 6 严格检查下存在上游类型冲突，因此不采用，也不通过关闭库检查掩盖错误。最低小版本的实际可用性由真实 Node 22.14.0 回归验证。

## 启动检查

`doctor` 同时检查稳定版本范围、`process.versions.napi`、SQLite 的实际加载/查询、SDK 导入和 Codex 协议。Node 不兼容时不加载 SQLite 原生绑定；绑定加载失败时返回明确诊断，不伪装成 Codex 协议不兼容。Codex 协议门禁、项目权限、进程归属和数据库恢复规则保持原有约束。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm check:sqlite
```

## 用 Node 22 构建桌面 App

```sh
pnpm desktop:build
pnpm --filter @codexconnector/desktop start
```

构建脚本使用当前 Node 编译源码，但始终将固定版本的独立 Node 放入 App。宿主就是固定版本时复用本机完整安装，否则从 Node 官方下载对应的 macOS arm64 包、校验官方 SHA-256，并缓存到 `.artifacts/node-runtimes`。不会替换系统 Node 或修改全局 PATH。

离线构建可以提前准备缓存：

```sh
pnpm runtime:setup
```

也可显式指定已安装的完整 Node 24.15.0 发行包中的二进制路径（安装根目录需有 LICENSE）：

```sh
CODEXCONNECTOR_BUNDLED_NODE=/absolute/node-v24.15.0-darwin-arm64/bin/node pnpm desktop:build
```

指定版本、系统或架构不匹配时立即拒绝，不会静默把 Node 22 打进 App。生产依赖复制到独立后端目录后，用**包内 Node**实际创建 SQLite 表、执行事务并读取结果；失败则构建失败。`runtime.json` 同时记录构建 Node、内置 Node、Node-API 和支持范围。

`desktop:setup` 中 DMG 的构建辅助模块使用宿主 Node；切换宿主版本后需重新运行该命令，它会检查模块能否被当前宿主加载，必要时只重编译对应模块。后端 SQLite 和已部署根 `dist` 不参与这一步。

## 回归流程

```sh
pnpm test:node-matrix
```

默认使用真实 Node `22.14.0`、`24.0.0`、`24.15.0`，依次执行后端/桌面类型检查、全部自动化测试、SQLite 持久性检查和独立后端编译。可追加精确版本参数，只检查指定候选版本。下载遵循上述校验规则；依赖使用当前 checkout 已安装的锁定版本，编译结果保存在 `.artifacts/node-matrix`，不覆盖根 `dist`。

自动化包含启动/停止竞态、父进程与子进程归属、未知状态不重放、恢复、WAL 一致性备份等夹具测试；这不等于真实飞书/模型任务联调。

GitHub Actions 的 `node-compatibility.yml` 在独立 macOS arm64 runner 上分别测试最低版本和 22/24 分支最新补丁，使用 frozen lockfile 全新安装并构建桌面端。工作流需提交并推送后才会执行；本地创建文件不等于远端 CI 已通过。

Node 支持变更应同时检查依赖 engines、实际使用的 API、Node-API、类型和构建工具；先跑矩阵再宣布兼容。新主版本不能仅修改 engines 后直接放行。

## 本机验收记录（2026-09-28）

环境：macOS arm64。新增 27 项 Node 版本/原生 API/诊断边界测试，合计 34 个测试文件、459 项测试。

| 实际运行版本               | 全部自动化 | 后端与桌面类型检查 | SQLite 事务、只读、WAL 备份恢复 | 独立后端编译 |
| -------------------------- | ---------- | ------------------ | ------------------------------- | ------------ |
| Node 22.14.0 / Node-API 10 | 459 通过   | 通过               | 通过                            | 通过         |
| Node 24.0.0 / Node-API 10  | 459 通过   | 通过               | 通过                            | 通过         |
| Node 24.15.0 / Node-API 10 | 459 通过   | 通过               | 通过                            | 通过         |

- Node 22.14.0 下从本地 pnpm 内容缓存，以 frozen lockfile、关闭安装脚本的方式创建独立 `node_modules`，安装成功。
- 在该独立副本中使用 Node 22.14.0 构建桌面端，并指定本机完整 Node 24.15.0 作为内置运行时；记录的 `buildNode=22.14.0`、`node=24.15.0`，随包 SQLite 事务检查通过。
- Node 22 构建出的后端通过真实私有 IPC 执行 doctor，当前 Codex 核心协议通过；断开父进程 IPC 后退出码为 0。Node 24 宿主构建也通过相同检查。
- 独立副本中的 DMG 辅助模块在 Node 22 下编译并加载成功。
- Node 22/24 运行时归项目内缓存管理；系统 Node 未切换。现有根 `dist` 的 SHA-256 与变更前一致。

本地原始日志位于被忽略的 `.artifacts/node-matrix/`。本轮未执行真实飞书/模型任务、GUI 人工验收或新 DMG 安装验收；GitHub Actions 文件已准备，尚未推送运行。
