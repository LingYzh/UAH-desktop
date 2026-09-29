# UAH Desktop

新会话先读 [开发交接](docs/HANDOFF.md) 和 [项目规则](AGENTS.md)。

UAH Windows 桌面底座：**Electron + Vue 3 + Vite + Pinia + TypeScript 核心 + .NET 10 辅助进程**（方案 A）。视觉以 `design/UAH_PC_Prototype_v1` 为准。

## 启动

需要 Node.js 24+、npm；构建 Windows 原生观察组件需要 .NET 10 SDK。

```powershell
npm ci
npm run build:native
npm run build
npm start
```

开发模式：`npm run dev`。网页预览：`npm run dev:web`，没有本地执行能力。原型可直接打开 `design/UAH_PC_Prototype_v1/index.html`；改原型源码后运行 `npm run build:prototype`。

## UI 库与文档

开发服务的 `/ui.html` 提供组件分类、搜索、真实示例、源码、API、设计变量和交互约定。`npm run build:ui` 独立构建到 `dist/ui-docs/`，保留目录中的 HTML 与 assets，通过 HTTP 服务预览或部署。

UAH UI 保留原型外观，在按钮与 Tabs 中整合 `@vuetify/v0` 无样式交互基础。组件契约见 [UI README](https://github.com/LingYzh/UI#readme)。共享外观修改先更新 UI 库和 demo，经视觉验收、发布新版本后再升级业务依赖；具体规则见 [AGENTS.md](AGENTS.md)。

## 可验证的链路

选择“本地验证运行时（非 AI）”后发送。无目录时只生成说明文本；使用系统选择器绑定目录后，会申请新建独立的 `uah-check-<runId>.txt` 文件。批准仅对本次请求有效，拒绝或停止不会继续执行。面板可读取该轮保存的历史快照。

这是基础验收适配器，**不调用模型，不代表 Codex、Claude Code 或 UAH API Engine 已接入**。尚无任意 Shell、PTY、电脑点击输入、MCP/插件执行、凭据保存或正式模型请求。未接入的入口不显示假账号或假成功。

已实现 Vue 稳定组件、Pinia 界面状态、受限 IPC、独立运行进程、SQLite、审批身份绑定、目录互斥、不可变快照、取消与重启恢复。内置 HTTPS 浏览器按会话隔离 profile，远程页没有主界面 preload/Node 权限。.NET helper 按需读取前台窗口/UIA 根元素，没有桌面动作和进程组终止能力。

数据默认存于 Electron `userData`；测试通过 `UAH_DATA_DIR` 指定隔离目录。测试使用 `artifacts/` 中的工作目录与数据库，不读取已有账号和模型凭据。

## 验证

```powershell
npm run typecheck
npm test
npm run build:native
node --test tests/native/protocol.test.mjs
npm run build
npm run test:desktop
npm run test:browser
npm run test:appearance
npm run test:search
npm run test:ui
```

桌面测试启动真实 Electron，覆盖输入、审批、文件、快照、取消与重启，截图与报告输出到 `artifacts/desktop-*/`。浏览器测试需要访问 `https://example.com`，报告输出到 `artifacts/browser-*/`。本次证据见 [验收记录](docs/VALIDATION.md)。

外观测试在普通动效模式采样侧栏中间宽度，验证快速反向与系统减少动效，再采集浅色、深色、下拉面板和 100%/150%/200% 缩放截图，输出到 `artifacts/appearance-*/`。Windows 应用缩放使用 Electron 原生窗口截图，避免网页截图裁切造成误判。

全局搜索使用与原型相同的居中弹窗，从本机已保存会话的标题、工作目录以及快捷入口中筛选。`Ctrl+K` 打开，方向键选择结果，`Enter` 跳转，`Esc` 关闭。搜索不会扫描磁盘；未接入的管理能力保留禁用入口。搜索测试覆盖实际会话切换、草稿保留、设置离开提醒及缩放，输出到 `artifacts/search-*/`。

| 目录 | 所有权 |
| --- | --- |
| `src/renderer` | Vue/Pinia 界面投影，没有文件系统/进程 API |
| `src/shared` | 类型化契约与运行时输入校验 |
| `src/main` | 窗口、选择器、IPC、浏览器、进程生命周期 |
| `src/runtime` | 运行状态、审批、租约、适配器、SQLite |
| `native/UAH.NativeHelper` | Windows 只读观察与 JSON Lines |
| `design/UAH_PC_Prototype_v1` | 独立设计原型，不是正式引擎 |

见 [ADR-001](docs/ADR-001-electron-vue-foundation.md) 与 [版本化功能基线](design/UAH_PC_HARNESS_FUNCTIONAL_DESIGN.md)。

UI 组件和文档位于独立的 [UI 仓库](https://github.com/LingYzh/UI)。UAH 固定使用 npm 发布的 `@lingyzh/ui@0.1.0`；只需在 UAH 执行 `npm ci`，不要求相邻 UI 仓库。Vite 保持 Vue dedupe。UI 仓库可在 5174 独立预览；UAH 的 `/ui.html` 仍保留兼容入口。
