# UAH 使用 npm 版共享 UI

- UAH 的 `@lingyzh/ui` 依赖固定为公开发布的 `0.1.0`，锁文件必须有 `registry.npmjs.org` 的 tarball 与 integrity，不得保留 `file:../UI` 或 `../UI` link 条目。
- 使用 `npm ci` 安装；不需要相邻 UI checkout。`npm run typecheck` 只检查 UAH，自 UI 源码仓库验收后发布的新版本需单独升级 UAH。
- Vite 的 `resolve.dedupe: ['vue']` 保留，npm 包仍通过 `src/ui` 的 Vue/TypeScript 源码导出。共享 UI 改动遵循 UI demo 与视觉验收先行，再发布和升级消费者。
- 2026-09-29 迁移前，UAH 锁文件已存在平台可选包元数据的本地改动；迁移时保留这部分既有差异，不把它当作本次依赖修改的清理对象。
- UI 文档页现有两个弹窗示例，桌面测试必须定位已打开的“共享弹窗”；Markdown 示例也有自身 h1，文档标题不要用全局唯一 h1 断言。剪贴板写入是异步的，先等待按钮反馈“已复制”再读 Electron 剪贴板。
- Windows 的 Git 检出会把 portable prompt Markdown 变成 CRLF，而内嵌模板为 LF；逐字单测读取磁盘内容后需统一换行符。Node 24.19.0 验证：类型检查、263 单测、生产构建、UI 集成 25 项与桌面烟测 8 项通过。
