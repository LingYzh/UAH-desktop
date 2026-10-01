# D05 历史界面盘点

2026-10-01：UAH 固定使用 `@lingyzh/ui@0.2.1`。已核对 `D:/UI/src/ui/index.ts`、`UiButton.vue` 和 `src/ui/docs/content.js` 中按钮真实示例。加载旧轮次复用 UiButton 的 ghost/sm、disabled、原生 click 与键盘语义，不新增组件或共享样式。

聊天区先挂载最近 50 个可见根轮次，按 50 轮扩展；加载前记录滚动高度与位置，加载后保持原来的阅读位置。轮次序号仍对应完整可见会话。分支继承消息和计划状态不改变。此阶段限制 DOM 挂载，不能宣称运行时或 IPC 已完全分页；SQLite 分页另行验证。

真实 Electron 功能证据：`npm run build` 后 `node tests/desktop/harness-performance.mjs` 最终21项通过，[完整报告](../artifacts/harness-desktop-performance-exzmo0/report.json)。隔离真实 SQLite 保存1000轮，默认容量允许第1001轮准入。初始DOM恰50轮（第951–1000轮）；鼠标加载后100轮，原第951轮顶部漂移0.1875px；原生focus+Enter后150轮（第851–1000轮），可滚至末尾并输入。末轮文件改动与回复动作也验证为第1000轮；深色加载按钮在实际滚动视口内后才截图。没有1000次Provider调用。

初始ready1687.43ms；150轮测量时179个相邻rAF间隔p95为12.10ms，输入dispatch到第二rAF为63.60ms。Renderer JS heap为68434374bytes，working set为303000KiB，均是单次阶段采样；不同规模基线与边界详见[性能文档](HARNESS-D00-DESKTOP-PERFORMANCE.md)。runtime/IPC仍为完整会话，尚未完成端到端分页。

视觉证据供root最终验收：[浅色初始50](../artifacts/harness-desktop-performance-exzmo0/list-1000-light-initial-50.png)、[浅色加载100](../artifacts/harness-desktop-performance-exzmo0/list-1000-light-loaded-100.png)、[浅色末尾](../artifacts/harness-desktop-performance-exzmo0/list-1000-light-end.png)、[深色末尾](../artifacts/harness-desktop-performance-exzmo0/list-1000-dark-end.png)、[深色按钮](../artifacts/harness-desktop-performance-exzmo0/list-1000-dark-earlier-control.png)。深色使用真实设置radio并保存。root已看前轮浅深末尾截图且布局通过；本轮更新全局序号和真正顶部按钮截图，最终视觉判定仍由root记录。

Root 最终视觉验收：已直接查看 exzmo0 深色顶部按钮截图；按钮位于真实视口、对齐既有消息区域，前后轮次与文件改动/动作栏编号一致，无遮挡。结合浅色加载后位置保持截图及21项行为断言，本次复用组件的界面改动验收通过。预算停止理由继续复用现有 muted/small 状态文字，后续 journal 专项补验。
