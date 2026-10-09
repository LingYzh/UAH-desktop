# 官方 npm 源与项目代理

最新交接授权：用户要求 UI 与 UAH 分别提交推送 `codex/handoff-component-alignment-20261008`，无需离线包。UAH 本次交接仅保留原有源/代理、依赖与记录；业务代码不变，仍消费官方 UI 0.3.2。恢复及完整检查结果见 docs/HANDOFF.md、docs/VALIDATION.md 顶部；以下未提交状态属于先前阶段，不能当作当前 Git 状态。

提交前 Node24.19.0/.NET10.0.401 完整typecheck/build通过，原始Electron UI复跑25组/60路由通过；首次搜索中间opacity采样失败保留日志，未修改动画断言或生产代码。完整串行单测与失败专项复跑统计见docs/handoff-validation-20261008.json，完整UI report在docs/handoff-ui-20261008.json。桌面烟测仍在已确认旧基线也失败的会话滚动smoke:133处失败（此前6组通过），保留问题交接，不宣称全门禁全绿。

完整单测最终1045项：1039通过、4失败、2跳过；3项随机localhost端口listen EACCES、1项记忆索引写入EPERM。四个原失败项专项复跑4/4通过，无产品/断言修改，原全量失败仍保留。UAH依赖树npm ls正常且UI为官方固定0.3.2。对应UI分支提交784a46f的完整门禁全绿；本仓只交接此前依赖变更和记录。

- 当前项目 `.npmrc` 固定 `registry=https://registry.npmjs.org/`，`proxy` 和 `https-proxy` 均为 `http://127.0.0.1:7890`；覆盖用户级镜像配置，安装时需要本地代理运行。
- 固定依赖更新为 MCP SDK 1.32.1、Electron 44.7.0、Playwright 1.64.0、Vite 8.3.3；`@types/node` 保持 `^24.0.0`，锁定 24.19.1。`@lingyzh/ui` 保持 0.3.2，已安装目录由旧 0.1.0 同步到声明版本；Vue 3.5.43 保持 dedupe。
- 锁文件全部 resolved URL 使用官方 npm 域名。UI 独立仓库原有 package-lock.json 修改保持原样；此次没有共享组件或视觉能力缺口，没有修改 UI 源码、提示词或运行时能力。
- 本机默认 Node 22.19.0 不符合项目 engines；本轮使用已有 bundled Node 24.19.0，未切换系统 Node。npm 命令通过该 Node 执行 npm-cli.js，脚本 PATH 也使用同一 Node。
- Electron 44.7.0 二进制在首次引用包时才下载。npm 的代理配置不等于 Electron 下载器代理：下载前在当前进程设置 HTTP_PROXY、HTTPS_PROXY 为 http://127.0.0.1:7890，并设置 ELECTRON_GET_USE_PROXY=true，单独运行 node node_modules/electron/install.js 后再运行桌面测试，避免下载占用 Playwright 的启动期限。
- 本轮 ci、typecheck、Electron 主进程/preload/worker 与 Vue 构建、依赖树检查通过。全量 1036 项：1018 通过、16 失败、2 跳过；13 项依赖缺失的 .NET 10 原生执行组件，3 项为随机端口 EACCES，原失败项复跑通过。复跑另遇一项随机端口错误，单独复跑通过。
- 升级 SDK 前仅有 .NET SDK 9.0.302，完整 build 因 NETSDK1045 未通过；没有降低 net10.0-windows 目标或修改测试断言。桌面烟测前 6 项通过，滚动位置断言失败；隔离目录使用升级前 HEAD 完整 package/lock、旧 Electron 44.4.5 重装并重建后复现相同断言失败，属于此次升级前已存在的问题。
- npm audit 当前报告 3 项 low（@lingyzh/ui、mermaid、其嵌套 katex 依赖链），fixAvailable=false。未强制替换 UI 的固定依赖。
- 证据为 artifacts/npm-official-* 日志。未提交、推送或发布。

## 同日补充：安装 .NET 10 SDK

- 用户明确要求更新本机 .NET。从微软官方 builds.dotnet.microsoft.com 通过 7890 代理下载 SDK 10.0.401 Windows x64 安装包，Authenticode 状态 Valid，签名组织 Microsoft Corporation；安装退出码 0，无需重启。
- 系统安装目录为 C:/Program Files/dotnet，默认 dotnet --version=10.0.401。SDK 9.0.302 保留；已有 .NET/ASP.NET Core/Windows Desktop 10.0.12 运行时已是当前稳定版本，不卸载旧运行时。
- 完整 npm run build（含 ExecutionHelper）及 NativeHelper Release 构建通过。此前受阻的 command-privacy-loop、execution-backend、managed-command、workspace-tools 四个测试文件串行复跑 54/54 通过；未修改业务代码或断言。
- 证据：artifacts/dotnet-sdk-10.0.401-install.log、dotnet10-info.log、dotnet10-full-build.log、dotnet10-native-helper-build.log、dotnet10-execution-tests.log。此前缺少 SDK 的环境阻塞已解除；没有再次宣称全量或桌面烟测全部通过，滚动断言问题仍见上文。
