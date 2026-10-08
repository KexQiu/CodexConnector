# 第三方许可与来源

项目原创代码采用 MIT，第三方组件保留各自原始许可，详见根目录 [NOTICE](../NOTICE)。

`openai-codex` 保存官方 Codex 的 Apache-2.0 许可与 NOTICE，`SOURCE.json` 固定原文来源提交。仓库中的 Codex 生成类型与协议快照不改为 MIT，生成脚本保留上游头部，仅转换模块导入。

`license-overrides.json` 仅用于发行包缺失许可文件的依赖，按 **包名与精确版本**匹配。`licenses` 内保存上游原文，来源优先采用包内 `.cargo_vcs_info.json` 或 npm 发布 `gitHead` 对应的公开提交。selectors 未附完整文本，使用 Mozilla 官方 MPL 2.0 文本；其原始版权声明保留在随包源码中。

`scripts/native-licenses.mjs` 按锁定的生产依赖、前端依赖和 macOS Rust 依赖收集许可，不读取用户配置。MPL-2.0 组件的完整原始 `.crate` 归档随 App 提供，并与 Cargo.lock 的 SHA-256 校验；只下载二进制的用户也能获取对应源码。其余许可与 Node 原始 LICENSE/NOTICE 同样保留。

构建结果的 `Contents/Resources/runtime/THIRD_PARTY_NOTICES.txt` 包含可独立阅读的原始许可文本与相对路径索引；`licenses/inventory.json` 为机器可读清单。不包含本机源码路径或密钥。缺少许可或源码校验不符时停止打包，不自动推断版权人或生成替代许可。

更新依赖后需核对新增许可。确实需要 fallback 时，保存对应上游原文及固定来源，并更新精确版本映射；不得复用不对应版本的文件来绕过检查。
