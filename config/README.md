# 本机飞书联调配置

填写本目录下的 `feishu.local.json`。该文件已被 `.gitignore` 和格式化工具忽略，创建时权限为 `600`，只允许当前用户读写。不要把 App Secret 粘贴到聊天、提交到版本库或放进报告。

| 字段            | 填写内容                                              |
| --------------- | ----------------------------------------------------- |
| `appId`         | 企业自建应用的 App ID                                 |
| `appSecret`     | 同一应用的 App Secret                                 |
| `tenantKey`     | 允许使用 Gateway 的租户标识                           |
| `allowedOpenId` | 允许操作的用户 open_id，必须是该应用下的标识          |
| `testChatId`    | 专用机器人单聊 chat_id；M3 Gateway 也仅允许此会话收发 |

用户已指定在此填写凭据与测试会话。探针先校验文件权限、完整性和 ID 格式，再按授权范围进行真实收发；不要把凭据内容复制到诊断输出。

```sh
# 本机校验，不联网、不发送消息
pnpm gate:feishu
# 只验证长连接，连接成功后退出
pnpm gate:feishu --connect
# 人工参与的真实收发、卡片、存储失败与重连测试
pnpm gate:feishu --live --timeout 900
# 只发送一次指定文本，验证存储失败后的平台自动重投
pnpm gate:feishu --retry-message --timeout 600
```

运行正式探针前先停止之前的临时接收脚本，避免同一应用的多个连接分走事件。`--live` 会显示本轮随机测试文本；由允许的用户在专用单聊中发送，租户、应用、用户和单聊校验全部通过后，才向该单聊发送测试消息及卡片。卡片回调需订阅 `card.action.trigger` 并生效。具体步骤及覆盖边界见 [G1 报告](../docs/gates/G1-feishu.md)。

上面的 G1 探针不执行 Codex 任务，也不安装后台服务。填写配置不自动发送消息；G1 只有显式执行 `--live` 才进入收发测试。

在新 checkout 创建文件时执行：

```sh
cp -n config/feishu.example.json config/feishu.local.json
chmod 600 config/feishu.local.json
```

`feishu.example.json` 是无密钥模板；`config.example.json` 是整个 Gateway 的配置模板，两者用途不同。此本机联调文件不代表已经安装或启用后台服务。M5 可直接引用现有私有凭据文件，也可停服务后迁移到 `~/.codex-feishu/credentials.json` 并更新配置；本机当前继续引用现有文件。

## M3 Gateway

本机已准备 `gateway.local.json`（权限 600、被忽略），通过 `feishu.credentialsFile` 引用上述凭据文件；其中的 appId、tenantKey、allowedOpenId 必须一致。项目 `remoteWrite` 默认为 false，只有明确开启的项目才能提交任务。

M3 还需要会话历史只读权限 `im:message.history:readonly`，用于发送回包丢失时找回原卡片；权限变更须发布/审批生效。启动时先检查历史读取权限，再连接飞书与 Codex。不要同时运行同一应用的 G1 探针、M3 探针或 Gateway，以免事件被分流。

`pnpm gate:gateway --live --timeout 900` 会启动临时 Codex 项目进行人工参与验收；`pnpm dev gateway` 则启动正式前台服务，处理此单聊的任务命令。两者都可能执行真实模型任务。独立 App Server、配置环境变量及补收指令见 [M3 操作说明](../docs/gates/M3-gateway.md)。

## M5 常驻服务

本机已安装两个用户 LaunchAgent，配置、日志、备份及试运行操作见 [M5 部署说明](../docs/gates/M5-deployment.md)。`service` 为可选运维策略，默认每份日志 5 MiB、保留 5 个轮转文件，每 24 小时备份、保留 7 份，已结算内容 30 天后分批清理。修改配置前先卸载服务，再重新准备并安装；不要在常驻服务运行时启动同一应用的临时探针。
