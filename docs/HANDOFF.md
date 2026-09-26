# UAH / UI 新会话交接

更新日期：2026-09-26。本文记录本轮结束时的状态；新会话先检查实际 Git 状态和用户最新要求。

## 开始下一步前

1. 阅读两个项目的 AGENTS.md，以及本文。用户尚未指定下一步具体业务任务，不要自行扩展为完整 AI 引擎接入。
2. 检查 `D:/UAH`、`D:/UI` 的分支、提交、工作区和已有开发服务，不覆盖新会话前的用户修改。
3. 先盘点任务需要的组件：对照 UI 的公开导出、API 与真实 demo，记录可以复用的组件和缺口。
4. 有缺口就先在 UI 完成组件、demo、文档页和调试，root 视觉验收并记录后，才接入 UAH。子代理发现缺口必须上报 root，暂停相关实现，不先在业务页另造组件。
5. 视觉样式由 root 亲自写，或交给至少 GPT-6 Sol medium；不能委派给 Luna/Terra。已验收组件的组装、数据绑定和非视觉逻辑可以下放低级模型。经济优先偏好继续有效，但不得降低视觉任务的模型下限。

## 两个仓库及检查点

| 项目 | 本地目录 | 远程 | 本轮交接前的功能检查点 |
| --- | --- | --- | --- |
| UAH | D:/UAH | git@github.com:LingYzh/UAH-desktop.git | dc3b9d1 |
| UI | D:/UI | git@github.com:LingYzh/UI.git | 4eb946a |

两个仓库均在 main。上述检查点是本地提交，尚未推送；本次交接文档及规则将在后续本地提交中保存。以 `git log -1` 获取包含交接资料的最新提交，不把表中功能基线当成最新 HEAD。

## UI 如何被 UAH 引用

- UAH 的 package.json 使用 `"@lingyzh/ui": "file:../UI"`，依赖两个目录保持相邻。
- 当前 `D:/UAH/node_modules/@lingyzh/ui` 是指向 `D:/UI` 的目录联接（Junction）。组件唯一实现保留在 UI，没有复制回 UAH。
- UI 的 package.json exports 将包入口映射到 `src/ui/index.ts`，样式映射到 `src/ui/styles.css`。这是私有 Vue/TypeScript 源码包，需要 Vue/Vite 构建，不是已经发布的 npm 包，也不是从 GitHub 在线加载。
- UAH 的 vite.config.ts 配置 `resolve.dedupe: ['vue']`，确保 UI 与宿主使用同一 Vue 实例。
- 业务文件从 `@lingyzh/ui` 导入组件；UAH 的 `src/renderer/main.js` 先加载业务 styles.css，再加载公共 UI 样式。tokens 也通过包导出引用。
- 修改 UI 源码会由使用该包的 Vite 项目读取，通常通过 HMR 更新；修改依赖清单、exports 或链接后需重新安装依赖或重启开发服务。生产应用需要重新构建。

```js
import { UiButton, UiInput, UiTabs, UiTable, UiDataTableServer, UiPagination } from '@lingyzh/ui';
import '@lingyzh/ui/styles.css'; // 仅在应用入口加载一次
```

首次安装，在 D:/UAH 执行：

```powershell
npm --prefix ../UI ci
npm ci
```

UI 独立开发：在 D:/UI 执行 `npm run dev`，端口 5174，入口 `/#/overview`。构建产物为 `dist/docs` 和 `dist/lib`；`npm run preview` 默认端口 4174。

UAH 网页预览：`npm run dev:web`，端口 5173；`/ui.html` 是兼容入口，通过包导出加载同一个 UI 文档页面，不是一套独立副本。桌面开发用 `npm run dev`；生产构建/运行用 `npm run build`、`npm start`。原生辅助组件需要 .NET 10 SDK 和 `npm run build:native`。

## 已完成的 UI 工作

- 25 个文档路由、16 个文档化组件；公开入口另导出 UiIcon、vRipple、snackbar 及相关类型。
- 组件包括表单、按钮、Tabs/TabPanel、Dialog、Collapse、Card、ScrollArea、CodeBlock、SnackbarHost，以及 Table、DataTableServer、Pagination。
- 支持适用组件的 dense、ghost、直角变体，各自页面有演示；浅深主题、语法高亮、工具类、ripple 和减少动效已实现。
- 滚动区域允许向父容器传递无法消费的滚动；垂直 Tabs 支持 indicator-side=start/end。
- 表格排序使用上下三角 SVG；ghost 按钮 hover 无边框，使用主题文字色 7% 透明覆盖，按下 12%，保留键盘焦点。
- UAH 右侧工作面板 Tabs 使用 dense。设置页点击主题即时预览，保存后保留，放弃离开恢复最近保存的主题；取消离开保留当前预览。
- 服务端表格由调用方请求数据；文档模拟延迟、失败和请求竞态，组件本身不请求网络或二次分页。不包含行选择、分组、多列排序、虚拟滚动。

## 实现边界

UAH 是 Electron + Vue + Pinia + TypeScript 核心 + .NET 辅助进程的方案 A 底座。本地验证适配器可验证流式事件、审批、新文件、快照和停止恢复，但不调用 AI。官方 CLI、模型引擎、PTY、凭据保存、MCP/插件执行、电脑动作和正式发行仍待实现；不要将界面演示当成真实能力。

关键资料：`docs/ADR-001-electron-vue-foundation.md`、`docs/VALIDATION.md`、`design/UAH_PC_HARNESS_FUNCTIONAL_DESIGN.md`、原型目录及其 REVIEW_FIXES.md。原型历史截图和旧交接文件不代表拆库后的最新结构。

## 验证基线

- UI：类型检查、文档/库构建通过；单元 2/2、独立界面 20/20。证据 `D:/UI/artifacts/ui-uX7okq`。
- UAH：类型检查、构建通过；单元 16/16、UI 集成 25/25、外观 7/7、搜索 5/5、桌面 8/8、原生浏览器 7/7。
- 对应证据依次为 UAH artifacts 下的 ui-mVri9k、appearance-WBy9qo、search-GYBsL7、desktop-NZUHtb、browser-wOeOEa。root 已检查三角排序图标、ghost 浅深主题和表格截图。
- 这些是上一轮功能基线，本轮主要更新工作规则及交接资料，并修复未使用的 forms.css 兼容入口仍指向搬迁前路径的问题。不要称为全套回归已在每次文档变更后重跑。
- 测试证据、node_modules、dist、IDE 配置被忽略，不在 Git 中；换机器后需要重新构建/测试。UI 独立测试使用隔离 Electron 宿主，无 UAH 依赖。

下一会话根据实际变更选择必要测试，不机械重跑全部。新增/改动共享视觉能力时，始终先在 UI 文档中验收，再验证 UAH 集成。
