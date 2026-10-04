# 本次验收记录

日期：2026-09-26。环境：Windows，Node.js 24.19.0，Electron 44.4.5，.NET SDK 10.0.400。方案 A 底座与独立设计原型分别验收。历史 `TEST_REPORT.md` 中的 71 项检查和 142 张截图不自动计入本次结果。

## 桌面底座

| 验证 | 结果与范围 |
| --- | --- |
| `npm run typecheck` | 通过，严格检查 IPC、Main、Runtime 和 TypeScript 测试 |
| `npm test` | 14/14，通过命令 schema、IPC 来源/URL、异步发送目标、流式/停止、审批身份、目录互斥、重启、独占写入和快照完整性检查 |
| Windows 目录边界 | 大小写别名共用租约；junction 被拒绝；已有目标文件不会被覆盖 |
| `npm run build:native` | Release 构建通过，0 警告、0 错误 |
| `node --test tests/native/protocol.test.mjs` | 通过 JSON Lines、错误请求与有确认的退出；另实际调用过只读前台窗口/UIA 根元素观察，未在日志输出窗口内容 |
| `npm run build` | Electron main/preload/utility worker 与 Vue/Vite 生产构建通过 |
| `npm run test:desktop` | 8/8，真实 Electron 输入/焦点/选区、设置脏状态、单次文件批准、不可变快照、等待审批时停止、800px 布局、长会话滚动和重启 |
| `npm run test:browser` | 7/7，真实 HTTPS 页面与主 UI 隔离、标签切换宿主保留、150% 应用缩放、A/B 会话独立 profile、管理页隐藏和显式关闭 |
| `npm run test:appearance` | 6 组动态/视觉检查，输入区/SVG 居中、两侧栏实际中间宽度、快速反向、关闭时 inert、系统减少动效，以及主题/表单/缩放截图 |
| `npm run test:search` | 5 组，原型 800px 全局搜索弹窗、标题/目录筛选、空结果、键盘与焦点、会话草稿、未保存设置，以及深色/200% 缩放 |

桌面测试的系统文件夹选择器由测试替身返回隔离临时目录；主进程权限校验、审批、文件写入、SQLite 和重启运行的是实际代码。这不能替代手动点选 Windows 文件夹对话框的验收。

## 视觉基线与修正

- 原型 UAH 标志与 67 个 SVG 图标直接复用，保留暖白、暖灰、陶土色与衬线标题。
- 对照原型校正 35px 标题栏、254px/57px 导航、48px 首页标题栏、470px 工作面板、底部单行输入区。
- 输入区恢复目录/仓库信息行、Agent/模型/权限/思考栏、右侧上下文状态和居中的底部说明；未接入能力明确禁用，不虚构模型/分支/上下文用量。单行输入、附件按钮和发送按钮的垂直中心相同，SVG 在按钮内双轴居中；首次发送前后位置、宽高均通过实测。
- 设置页恢复分栏导航、浅色/深色/系统主题预览卡、带分隔线的设置行。下拉弹层、开关、输入框、焦点、禁用和按钮均使用统一样式。
- 下拉选择器和 `::picker-icon` 明确使用纵向居中，紧凑模型选择器去除多余上下内边距；截图检查关闭与展开两种状态。
- 搜索恢复原型的居中弹窗和“会话 / 快捷入口”分组；匹配实际标题与目录。弹窗打开时隐藏原生网页，关闭后恢复同一个宿主；未接入入口明确禁用。搜索框避免全局表单样式造成重复边框。
- 左右侧栏在持续存在的网格节点上进行 240ms 宽度过渡；快速反向由 CSS 转向最新目标，没有提交业务状态的动画回调。关闭立即设置 inert 并隐藏远程网页，浏览器宿主不销毁。800px 窄窗口主动展开左栏时关闭右栏，完整导航保持可达。
- 系统和用户减少动效采用 OR；不创建非必要无限动画，停用过渡后到达相同终态。
- 检查浅/深主题、展开的下拉框、800px 窗口、100%/150%/200% 应用缩放。高缩放使用完整 Electron 窗口截图，并检查设置页能滚动到保存按钮。

本地证据（`artifacts/` 是忽略入库的可重新生成测试输出）：

- [全局搜索报告](../artifacts/search-IID0RZ/report.json)，5 组通过、无页面异常；[浅色搜索](../artifacts/search-IID0RZ/01-search-all.png)、[目录匹配](../artifacts/search-IID0RZ/02-search-directory.png)、[深色搜索](../artifacts/search-IID0RZ/03-search-dark.png)、[200% 滚动结果](../artifacts/search-IID0RZ/04-search-200.png)。
- [桌面流程报告](../artifacts/desktop-vP9cMQ/report.json)，8 项通过、无页面异常。
- [浏览器隔离与宿主报告](../artifacts/browser-vfwcye/report.json)，7 项通过，包含搜索弹窗隐藏/恢复原生网页。
- [外观与动态指标](../artifacts/appearance-vxvRTe/report.json)，6 组通过；包含实际中心线坐标与过渡中间宽度。
- [主页](../artifacts/appearance-vxvRTe/01-home.png)、[分栏](../artifacts/appearance-vxvRTe/02-split-panel.png)、[浅色设置](../artifacts/appearance-vxvRTe/03-settings-light.png)、[展开的下拉框](../artifacts/appearance-vxvRTe/04-select-open.png)。
- [深色设置](../artifacts/appearance-vxvRTe/05-settings-dark.png)、[150%](../artifacts/appearance-vxvRTe/06-settings-150.png)、[200%](../artifacts/appearance-vxvRTe/06-settings-200.png)、[200% 滚动后的设置](../artifacts/appearance-vxvRTe/07-settings-200-scrolled.png)。

## 验收边界

本地验证适配器真实运行在独立进程，完成流式事件、审批、新文件、快照和停止恢复，但它不调用 AI。官方 CLI、模型请求、PTY、OS 凭据引用、Agent 网站动作、电脑点击输入、发行打包与签名仍是后续接入工作。

没有进行真实 Windows 中文/日文输入法组合输入、跨显示器 DPI、系统主题切换与辅助技术的人工验收。保留了 IME 防误发、键盘导航、焦点指示和系统偏好监听；自动化通过不等于上述平台专项已经完成。

文件与数据库之间的强制崩溃窗口见 [ADR-001](ADR-001-electron-vue-foundation.md)。当前新文件保护不是任意 Shell 的文件系统沙盒。

独立原型已在本轮重建后运行 `tests/interactions.py`：71/71，通过且无页面 JavaScript 异常、无外部网络请求；见 [本轮报告](../design/UAH_PC_Prototype_v1/tests/interactions.json)。历史 142 张截图没有整套重新生成。

原型测试需要 Python 和 Playwright，当前使用仓库隔离的 `.venv-prototype`（Playwright 1.63.0），通过 `CHROMIUM_PATH` 指向系统 Chrome 可执行文件，以全新临时浏览器上下文运行，不使用用户浏览器 profile。测试脚本启动仅监听 loopback 的临时 HTTP 服务，以便实际验证 localStorage。

独立原型的 UAH-01～09 修复说明与专项回归结果由 [REVIEW_FIXES.md](../design/UAH_PC_Prototype_v1/REVIEW_FIXES.md) 记录。

本轮专项最终 **9/9 通过**，见 [review_regressions.json](../design/UAH_PC_Prototype_v1/tests/review_regressions.json)。覆盖跨表单草稿和保存失败、面板关闭竞态、六类导入/撤销及失败回滚、单会话导出导入、手动模型持久化和供应商改名、会话与计划滚动恢复、通知悬停/焦点、减少动效、字体与搜索设置刷新恢复。两套原型脚本在失败时均返回非零退出码。


## 2026-09-26 · UI 库、搜索动效与 Snackbar

本轮 UI 代码、外观和最终截图验收由 root 完成，没有将 UI 实现委派给 Luna。

- 新增项目内 `src/renderer/ui`：按钮、输入框、选择器、开关、表单行、Tabs/TabPanel、Dialog、Collapse、SnackbarHost 与全局 snackbar 服务；搜索/设置/工作面板/审批动作已迁移。
- 输入框视觉状态统一归外壳，搜索框 hover 覆盖图标和整个控件。移除全局表单 hover 和重复通用按钮样式。
- 弹窗有真实进入/退出中间帧，退出结束才关闭并恢复焦点；快速重开不会被旧回调关闭。原生 WebContentsView 在整个 modal 生命周期保持隐藏。
- 工作面板 Tabs 使用 underline 变体，底部两角为 0；共享控件、选择器弹层、标签内容、页面、菜单、Snackbar 使用适合的过渡。系统与应用减少动效均生效。
- Snackbar 支持六个方位、全局 JS/TS 调用、默认配置、手动关闭、每方位最多 3 条、独立的指针/焦点暂停与剩余时间恢复。
- 类型检查及生产构建通过；`npm test` 16/16；UI 专项 9/9；搜索 5/5；外观 6/6；桌面 8/8；原生浏览器 7/7。
- 最新 UI 专项：`artifacts/ui-70QWmC/report.json`，包括 hover、浅深色组件库、工作面板 Tabs 和 Snackbar 截图；真实中间帧在 `motion.json`。
- 搜索：`artifacts/search-BvvyAm`；外观：`artifacts/appearance-ma0RRt`；桌面：`artifacts/desktop-AB1kdX`；浏览器：`artifacts/browser-NM1erD`。
- root 已查看搜索 hover、浅/深主题组件库、Tabs、Snackbar、设置页截图。外观测试覆盖 100%/150%/200% 缩放；尚未新增真实读屏器或中文输入法人工专项。

组件 API 与动效边界见 [UAH UI 文档](../../UI/src/ui/README.md)。开发预览入口 `/ui.html` 不进入正式生产构建；业务页面仍使用同一组件实现。`vue-tsc` 使用独立 TypeScript 6 兼容别名，主进程保留 TypeScript 7。


## 2026-09-26 · Vuetify0 接入与完整 UI 文档

- 按用户指定由 GPT-6 Sol high 实现文档，root 审查组件契约、修正问题并完成视觉验收。
- 固定运行依赖 `@vuetify/v0@1.2.3`。UiButton 使用 Button.Root；UiTabs 使用 Tabs.Root/List/Item 提供选中、键盘和焦点行为。其余组件仍为 UAH/原生实现；未引入 Material 皮肤，未调整 Electron 安全边界。
- 文档有 16 页：接入/概览、10 个组件、全局 Snackbar、设计变量、可访问性、动效。真实示例、源码复制/换行、API 表、站内搜索、hash 导航、当前页目录、主题、减少动效和窄屏导航均实现。
- 独立 HTML 产物为 `dist/ui-docs/ui.html` 与同目录 assets，通过 HTTP 服务访问；正式工作台构建仍分离。开发入口 `/ui.html`。
- root 修正文档 CSS 加载顺序导致桌面误显示移动导航按钮的问题；为 UiButton 暴露稳定 element/focus 接口，修正 v0 renderless 根节点下 Escape 回焦问题；补齐页面与遮罩过渡。
- 类型检查、工作台生产构建和文档构建通过。单元 16/16、UI 13/13、外观 6/6、搜索 5/5、桌面 8/8、原生浏览器 7/7。
- UI 最终报告：[ui-tweqcb/report.json](../artifacts/ui-tweqcb/report.json)。测试直接加载文档构建产物，遍历 16 个路由，并验证双轴 Tabs、焦点/ARIA 关联、源码剪贴板文本、移动搜索及 Escape 回焦、Snackbar 六方位、200% 缩放和 800px 窗口。测试宿主使用独立 userData，避免历史缩放污染验收。
- root 查看了文档浅深主题、Tabs、源码、200% 和窄屏设计变量截图，并在应用浏览器检查按钮及输入文档。图标、暖色调、控件中心线、Tabs 底角、代码/表格滚动和标题层级符合当前 UAH 规范。
- 其余本轮证据：`artifacts/appearance-eCEEj9`、`artifacts/search-VIdT50`、`artifacts/desktop-KOPNSs`、`artifacts/browser-5wfSuB`。
- 当前接入使工作台 JS gzip 从约 53.20 kB 增至 75.58 kB；UAH 公共接口与既有业务行为保持一致。未声称其余组件全部迁移至 v0，也未新增业务引擎能力。
- UI-first 顺序已写入项目 AGENTS.md 和用户全局 AGENTS.md：原型 → tokens/组件库/真实 demo → 视觉验收记录 → 系统实现。此后的共享改动先更新库和文档。


## 2026-09-26 · UI 文档第二轮迭代

本轮 UI 实现、视觉规格及验收由 root 完成；Luna 仅只读排查选择器示例根因。

- 文档扩展为 21 页、13 个公开组件，按操作/表单/导航/容器/反馈/内容类型分组；顶部移除减少动效开关，使用 UiSwitch 切换浅深主题。减少动效示例保留在专门文档内。
- Tabs 参考 Vuetify 的整体形制，默认 underline；单一绝对定位指示条水平贴底、垂直贴右边，跟随尺寸和选中状态平滑滑动。继续由 v0 提供键盘/选中行为，保留 soft 兼容变体。
- 新增 vRipple 指令及 UiButton/UiTabs 的 ripple 属性，默认启用；支持位置/居中、颜色、指针与键盘、按住/释放、取消/失焦清理、禁用和减少动效。
- 新增 UiCard、UiScrollArea、UiCodeBlock。文档示例容器使用真实 Card；表单、Tabs、代码和底部操作共享布局约定。全局应用原生细滚动条；局部滚动区域保留键盘及原生滚动语义。
- CodeBlock 使用 highlight.js 11.12.0 的按需语法模块与 --code-* tokens，支持 Vue/XML/JS/TS/CSS/JSON；复制原始文本，未知语言安全转义。代码高亮模块未进入当前工作台 JS 产物。
- 提供 d-flex 等显示/对齐/宽高工具类、4px 步长的 0–16 级 margin/padding/gap、逻辑边与 auto margin，以及 sm/md/lg 的显示和 flex 方向类。支持范围有明确文档，不声称等同 Vuetify 全量工具类。
- 修复 UiSelect 无模型时首项被 Vue 清空、禁用项空白的问题。错误示例增加明确模型与实际校验并同步源码。指针选项提交后释放焦点，包括重复选择当前项；处理 Chromium 原生弹层关闭后的焦点恢复。键盘操作保留焦点，blur-on-select=false 可关闭指针失焦。
- 类型检查、工作台构建、文档构建通过。UI 专项 17/17、外观 6/6、搜索 5/5、桌面 8/8、原生浏览器 7/7 通过。UI 包含真实原生 option 点选、重复点选、垂直指示条几何位置、滑动中间帧、默认 ripple 与清理、21 个路由、源码复制/高亮、Card 表单、滚动和工具类。
- 核心 UI 报告：[ui-GqpMl1/report.json](../artifacts/ui-GqpMl1/report.json)；root 直接查看了最终选择器、Tabs、ripple、Card、代码浅深主题截图，并复核 800px/200% 布局。此前 UI 样式截图在 ui-wA80Mn 与 ui-G4Ghs5；最终差异只涉及选择器相同值的失焦处理。
- 外观 `artifacts/appearance-jCg7u0`；搜索 `artifacts/search-xStRC3`；桌面 `artifacts/desktop-5zp2w4`；浏览器 `artifacts/browser-4LnaxD`。构建产物仍为 dist/ui-docs/ui.html + assets。

参考：[Vuetify Tabs](https://vuetifyjs.com/en/components/tabs/)、[Cards](https://vuetifyjs.com/en/components/cards/)、[Spacing](https://vuetifyjs.com/en/styles/spacing/)、[highlight.js API](https://highlightjs.readthedocs.io/en/latest/api.html)。

## 2026-09-26 · 悬浮滚动条与统一变体

- UiScrollArea 参考 [Element Plus Scrollbar](https://element-plus.org/zh-CN/component/scrollbar) 实现透明轨道、悬浮滑块、悬停/聚焦/滚动显隐、常显、双轴、拖动与轨道点击，动态内容和容器尺寸重新测量；保留原生键盘/滚轮滚动，卸载清理监听、观察器和计时器。未引入 Element Plus 依赖。
- UiCodeBlock 复用 UiScrollArea；其余原生滚动区域统一细滑块颜色和透明轨道。自定义滚动组件不会占用内容宽度。两种实现的边界在组件 README 中明确记录。
- Button/Input/Select/Tabs/Card/CodeBlock/ScrollArea 支持 dense、ghost、rounded=false，保留旧尺寸 API；代码块工具栏同步密度和圆角。新增统一变体组合预览，文档共 22 页。
- UI 专项 **19/19 通过**：[ui-3EwJjd/report.json](../artifacts/ui-3EwJjd/report.json)。新增验证滑块拖动、轨道跳转、日志增减后的溢出变化、水平常显和组合变体尺寸/圆角/透明表面；既有键盘、焦点、错误、动效和所有文档路由检查继续通过。
- root 查看并验收 `15-scrollbar.png`、`16-variants-light.png`、`17-variants-dark.png`：滑块位置和厚度、Card 内控件密度、直角边界及浅深主题一致。此前 Tabs、代码高亮、选择器及缩放验收记录仍适用。
- 最终类型检查、工作台生产构建通过；文档构建由上述 UI 专项执行并通过。共享样式更新后外观回归再次 **6/6 通过**，证据 `artifacts/appearance-n3xrpY`，覆盖控件居中、两侧栏动画、减少动效和 100%/150%/200% 缩放。

## 2026-09-26 · 滚动衔接、垂直 Tabs 方向与分组件变体

- 移除 UiScrollArea 的双轴 overscroll containment，恢复原生祖先滚动衔接；通过实际 mouse.wheel 验证横向区域内的纵向滚轮能移动文档父容器，子区域 scrollTop 保持 0。
- UiTabs 新增 indicator-side=start/end，默认 end；垂直布局可选择色条所在逻辑边。文档同步展示内容在左/右的布局，核验两侧指示条与选中按钮的实际边缘位置，保持选中滑动动效及键盘行为。
- 七个适用组件页新增四种独立演示与源码，仍保留统一组合预览。新增 VariantExample 文档组件复用演示结构，所有示例直接使用公开 UI 组件。
- UI 专项 **21/21 通过**：[ui-kOgoT0/report.json](../artifacts/ui-kOgoT0/report.json)。类型检查、工作台构建和文档构建通过。
- root 查看 `10-tabs-slider.png` 与 `18-local-variants-input.png`、`18-local-variants-tabs.png`，确认内容/指示条方向和各变体外观；之后仅补调 Tabs 示例段落间距及窄屏列宽，最终类型检查及文档构建再次通过。

## 2026-09-26 · 工作面板密度与主题预览

- 工作面板使用已验收的 UiTabs dense 变体，按钮高度 32px；外层同步紧凑高度并贴齐底部指示条。
- 设置页使用草稿主题即时预览（包括跟随系统），仅保存成功后更新持久化偏好。放弃修改或离开设置后恢复最近一次保存的主题；取消离开则继续保留当前预览。窗口主题同步使用有效预览值。
- 类型检查、生产构建通过，外观回归 **7/7**，见 `artifacts/appearance-Tjnnsy/report.json`。实际验证预览不写存储、取消导航、放弃恢复、系统主题切换，以及保存后再次预览并放弃时恢复新保存主题；同时检查工作面板 dense 按钮高度。

## 2026-09-26 · 公共表格、服务端表格与分页器

- 新增 UiTable、UiDataTableServer、UiPagination 及公共 TableHeader/TableSort/TableOptions 类型。所有文档 API 表格迁移至 UiTable，移除重复的原生表格模板与旧样式。文档共 25 页、16 个公开组件。
- 基础表格支持列定义、单元格/表头插槽、加载/空状态、固定表头、悬浮滚动条。服务端组件上报初始化与参数变化，单列排序及修改每页条数回第一页，加载时锁定排序和分页；调用方负责网络请求，组件不对当前页二次切片。
- 独立分页器支持边界禁用、页码校正、首尾页与省略号、键盘按钮操作和 aria-current。页脚复用 UiSelect 与分页器，以每页条数、记录范围和页码组成，窄屏自然换行。三个组件均提供 dense/ghost/直角变体及源码演示。
- 服务端文档使用本地延迟请求演示排序/查询/翻页、失败重试、空结果和连续请求的旧响应隔离；提供 fetch/AbortController 接入源码。没有新增真实后端端点或业务功能。
- 类型检查、工作台构建、文档构建通过。最终 UI 专项 **24/24**：[ui-0SLieM/report.json](../artifacts/ui-0SLieM/report.json)，包含 25 个文档路由、分页键盘与总页数收缩、服务端参数与状态流、固定表头、API 表格迁移及窄屏检查。
- root 查看了分页器、服务端表格浅深主题与 800px 截图；修正表头默认居中和查询栏换行后，再次查看最终 `20-server-table-light.png`、`22-server-table-narrow.png`。最终代码与证据均来自同一构建。
- 参考 [Vuetify 服务端表格](https://vuetifyjs.com/en/components/data-tables/server-side-tables/) 与 [分页器](https://vuetifyjs.com/en/components/paginations/)，未引入第三方 Material 外观库；当前范围不含行选择、分组、多列排序和虚拟滚动。


## 2026-09-26 · UI 独立仓库检查点

- UI 库及文档、tokens、图标、独立测试迁移到 D:/UI，远程为 git@github.com:LingYzh/UI.git。UAH 通过 @lingyzh/ui（file:../UI）引用唯一实现，Vite dedupe Vue；保留 /ui.html 兼容预览入口。UI 在 5174 可独立开发，不依赖 UAH 或 Electron 运行时。
- 表格排序改为上下实心三角 SVG，激活方向突出显示。ghost 按钮 hover 边框透明，背景采用主题文字色的 7% 透明覆盖，按下为 12%；键盘焦点仍明确保留。root 已查看浅深主题及表格截图。
- 两项目类型检查、构建通过；UI 单元 2/2，独立界面 20/20（UI/artifacts/ui-uX7okq）；UAH 单元 16/16、UI 集成 25/25（artifacts/ui-mVri9k）、外观 7/7（artifacts/appearance-WBy9qo）、搜索 5/5（artifacts/search-GYBsL7）。
- 独立 UI 安装说明、组件文档和 VALIDATION.md 在新仓库内；构建产物、依赖和测试截图不纳入提交。之前各阶段的历史路径保留为当时记录。

- 最终桌面回归 8/8（artifacts/desktop-NZUHtb）、原生浏览器回归 7/7（artifacts/browser-wOeOEa）通过。

配套 UI 检查点：4eb946a78b50aac1ada8e47871c5082d4e8ba9c2（LingYzh/UI）。重现本次 UAH 检查点时，将 UI 检出至该提交并置于相邻目录。

## 2026-09-26 · API 与端点接入

- 接入 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 文本流式协议；端点目录与手动模型、连接测试、系统加密密钥、模型选择、上下文及停止均走真实主进程/隔离运行进程链路。订阅、官方运行时和 API 工具执行未纳入本轮。
- 已先盘点并复用 UI 的公开组件与真实 demo，未新增共享组件或改动 UI 仓库。详细边界见 [API-INTEGRATION.md](./API-INTEGRATION.md)。
- 类型检查与生产构建通过；最终单元 **48/48**。
- 端点桌面专项 **8/8**：[endpoints-OTVWxP/report.json](../artifacts/endpoints-OTVWxP/report.json)，无 pageerror。涵盖系统加密保存与重启后实际认证请求、模型目录、两轮上下文、401 错误、停止挂起连接、启停与删除、模态草稿防丢失。
- 原桌面回归 **8/8**：[desktop-4Pg3Na/report.json](../artifacts/desktop-4Pg3Na/report.json)；搜索回归 **6/6**：[search-BhTrvP/report.json](../artifacts/search-BhTrvP/report.json)。后者验证重复 Ctrl+K 选择查询文本和新模型管理入口。
- root 查看端点专项原生截图的浅深主题、编辑器顶部/底部、900×800 的 125% 缩放状态；确认焦点可见、没有横向裁切、长表单可滚动、操作按钮可达。证据以 endpoints-OTVWxP 为准，早期 Playwright 截图在 Electron 缩放时截取区域不正确。
- 所有 API 验证使用本地 HTTP fixture，没有真实服务商账号调用或计费凭据联调。未机械重跑无变更的全部 UI 库、原生浏览器与桌面观察专项。

## 2026-09-26 · 桌面开发服务端口冲突修复

- 原因：dev:web 已使用 5173，而桌面启动脚本再次要求同一 strictPort 且写死 renderer URL。
- 桌面开发改从 5175 开始自动避让，传递实际监听地址；Vite 缓存与网页预览分离。关闭服务使用该次启动的 Vite 对象和 Electron exit 事件，不按端口、PID 或进程名称终止其他服务。
- `node tests/desktop/dev-start.mjs` 通过：占用端口自动避让、实际地址 Electron 启动、renderer 隔离、端点与运行 IPC、本地验证运行完成，以及关闭自有服务后原占用监听仍可访问。证据 `artifacts/dev-start-mjTXtk/report.json`。
- 已启动供用户使用的桌面窗口，监听 5175；既有 5173 网页预览保持运行。本轮没有 UI 组件或外观变更。

## 2026-09-26 端点目录与弹窗修复
- 组件盘点：复用 UiDialog/UiScrollArea；先在 D:/UI 补齐 scrollable、固定 error/header/footer，真实 demo 验收见 UI/VALIDATION.md 及 artifacts/dialog-scroll-CEBFBX。
- EndpointStore.preview 不再要求启用草稿有模型；save/resolve 仍保持校验。避免读取目录之前被“至少一个模型”阻断。
- 编辑端点固定标题、错误和操作；正文独立滚动，滚动条不经过外层圆角。
- typecheck、两仓构建通过；48 项单元测试、8 项桌面端点流程通过。桌面新增启用草稿清空再发现模型，以及 HTTP 401 错误在底部滚动后保持可见的断言。证据 artifacts/endpoints-G41rDw；root 检查 endpoint-error-fixed.png 与 endpoint-editor-light-top.png。
- 用户 localhost:5580 无凭据 GET /models 与 /v1/models 均返回 401，仅证实服务可达且要求认证；未读取或发送用户密钥，未确认其认证后的目录结果。基础地址需依服务配置包含 /v1。
- 后端修复需重启 Electron 生效；本轮未终止用户正在使用的窗口。

## 2026-09-26 诊断日志组件盘点
日志入口复用 UiButton、snackbar 及已有 EndpointManager 顶部/弹窗 footer；没有新组件或通用样式缺口。后台日志独立于 UI，不收集原始请求/响应正文。

诊断验收：类型检查、构建、54 项单元测试通过；桌面 8 项端点流程通过，覆盖 501 项目录的详细错误、错误与日志 requestId/operation/protocol 关联、固定目录 IPC 打开、密钥和对话正文不进入日志。root 检查 artifacts/endpoints-pf3Oah/endpoint-detailed-error.png：详细信息完整可见，按钮保持固定。日志写入异常不影响请求，轮转与脱敏单测通过。实际 localhost:5580 认证后返回内容未采集，真实根因待复现。

## 2026-09-26 单页目录兼容与侧栏精简
盘点：复用 UiButton 的 ghost/sm/icon、UiIcon 与已验收 flex 工具类；只调整应用标题栏布局，无新组件或公共外观能力缺口。移除重复品牌行，导航切换置于标题行；root 负责桌面视觉验收。读取指定诊断编号确认 Anthropic 首响应已有 25 个合法模型，仅分页判定失败。

能力信息组件盘点：复用 UiCard、UiScrollArea 和现有文字/间距工具类，在模型 ID 下方展示服务报告的能力；无需新组件或共享样式，未知不猜测。

最终验收：typecheck、构建及 60 项单元测试通过。8 项桌面端点流程覆盖 Anthropic 选择下读取通用无分页目录、能力展示/保存/重启保持、明确 false、加密密钥保持及流式对话。证据 artifacts/endpoints-nKWygI，root 检查 endpoint-editor-light-bottom.png。外观 7 项流程通过，root 检查 artifacts/appearance-oXjL0T/01-home.png 与 06-settings-200.png：重复品牌行移除，顶部按钮不占拖动区域，折叠后仍可点击，200% 缩放可见。当前测试没有使用用户密钥重放本地模型服务。

## 2026-09-26 手动能力与测试反馈盘点
已读移动端 AgentApp 的 ModelFetcher.kt、Models.kt、ProvidersScreen.kt：原生图片/PDF/音频/视频独立能力，手动覆盖优先，刷新保留覆盖，恢复时清除能力及上下文覆盖。UAH 复用已验收 UiDialog header/footer、UiCard、UiScrollArea、UiField、UiSelect、UiInput：测试反馈放 header 插槽，能力编辑独立 dialog；没有公共样式/组件缺口。

本轮验收完成：63 项单元测试、类型检查、构建通过；8 项端点桌面流程验证原生输入能力、编辑取消、覆盖应用/保存/刷新/重启保持及恢复声明清除上下文覆盖；测试结果包含实际回复且正文滚动后仍可见。root 检查 artifacts/endpoints-4Tefkm/model-capabilities-editor.png、endpoint-test-result.png 及 artifacts/endpoints-kbVIph/model-capabilities-dark-narrow.png（深色、900×800、125%）。8 项桌面底座流程 artifacts/desktop-Uccx9Q、7 项外观 artifacts/appearance-UnOIXE、6 项搜索 artifacts/search-Yv2mby 通过。删除返回按钮后，阅读位置回归使用历史会话入口返回原会话；未以新对话代替返回原会话。

2026-09-26 模型选择器：构建与两仓 typecheck 通过，renderer 4 项通过（包含跨 provider 同名模型隔离、禁用/空端点过滤）。Electron endpoints 8 项通过，覆盖隐藏占位、分组标签、模型纯 ID 展示及真实流式调用。UI 库真实 demo 已验收浅深色和自定义滚动条拖动、键盘跨组选择；完整组件回归 20 项通过（D:/UI/artifacts/ui-IpuLTP）。

2026-09-26 已有对话选择器：根因是 selected 分支使用 disabled button。统一 UiSelect 后，64 项单测、类型检查、构建通过；额外验证 start-run 选择校验、会话内切换及明确本地验证。Electron 8 项通过（artifacts/endpoints-89Au7a），包含真实鼠标在第一轮完成后打开并选择模型。Supervisor 测试验证第二轮请求切换模型且保留历史，第一轮 effective 不变。

2026-09-27 provider 与能力图标：UI 真实紧凑卡片 demo 浅深色验收通过（D:/UI/artifacts/provider-card-bZ0Gsl）。UAH 卡片/编辑器浅深主题与 900x800 125% 布局验收通过。64 项单测通过；初始启用无模型拒绝补充测试通过。最终构建、两仓 typecheck、Electron endpoints 8 项通过（artifacts/endpoints-nEWAb7），覆盖默认启用、卡片停用持久化、禁发请求、密钥/能力覆盖保留、仅显示支持图标。Tooltip 独立悬停/键盘/Esc 测试与浅深视觉验收通过；实际弹窗 tooltip 已检查 capability-tooltip.png，未被容器裁剪。

2026-09-27 Agent 设置阶段：UI 新增 UiTextarea，真实示例浅/深主题聚焦、禁用、错误及多行编辑验收通过（D:/UI/artifacts/textarea-XPwJBi）。关闭文案回归、API endpoints 8 项通过（artifacts/endpoints-PCZmxC）。主 Agent schema/store/三协议映射/配置快照/history/timeout/cancellation/renderer 共 76 项单测通过，tsc + UI typecheck 与构建通过。完整 desktop smoke 8 项通过（artifacts/desktop-7YmXYg）。

Agent 专项桌面 6 项通过（artifacts/agents-yHXEUF）：真实 loopback SSE 验证指令、temperature、输出上限及零历史请求，运行配置快照、默认模型切换、非法保存不修改原配置、角色及调度设置重启恢复。独立页面检查通过（artifacts/agent-visual-eecD7y），包括脏表单关闭后继续编辑、保存及无横向溢出。root 检查浅色主 Agent 编辑器、深色列表和调度弹窗，以及 900×800、125% 的主 Agent 编辑器底部；滚动区、固定页脚和待接入标识可见。未调用真实付费服务，子代理执行未接入。

## 2026-09-27 Agent / 模型解耦与权限

组件盘点：复用 UiField 的 description / aria-describedby、UiInput、UiSelect、UiTextarea、UiSwitch、UiDialog、UiScrollArea 与已有布局工具类；不需要新增公共组件或业务 CSS。设置字段逐项提供用途与默认行为，主 Agent 不再出现模型/采样参数，子代理仅保留可选模型绑定和角色权限。

89 项单元测试、UAH + UI 类型检查和生产构建通过。覆盖每模型生成参数的严格解析、schema v4 迁移/保留、Agent v2 原文归档迁移、会话 Agent 锁定及重启保持、三种子代理来源、所有权限层级组合（含 bypass）、禁止伪造父权限和工作区，以及运行参数快照。8 项端点桌面回归通过（artifacts/endpoints-cqz1uT）。独立 Agent 页面检查通过（artifacts/agent-visual-oLP12y）；root 已检查浅色编辑器、深色 900×800 125% 调度弹窗，说明文本和固定页脚可见。模型设置与委派 IPC 的专项桌面验收另记。

最终专项：新增上下文 2 项单测并重跑委派 5 项通过，覆盖 all/selected/none 独立选择、内容复制、按父当轮历史窗口隔离其他/未来会话、禁止 system 角色与超限上下文。最新构建和两仓 typecheck 通过。桌面 Agent 专项 13 项通过（artifacts/agents-p6oxxg），验证两模型的真实 SSE 请求参数、主 Agent 与模型独立选择、首轮锁定、继承/预设/临时 Agent、权限拒绝、三种上下文 IPC、编辑预设不改变父运行权限以及重启恢复。root 检查模型设置浅深色上下两端、子代理底部，均为 900×800 125%；说明、选择器、固定页脚与内部滚动边界正常。未执行真实子代理或文件/Shell 工具，未调用外部付费服务。

## 2026-09-27 会话权限与思考强度

组件盘点：复用 UiSelect / UiScrollArea / UiField；现有选择器缺少说明行和菜单标题，先在 D:/UI 扩展 items/menuTitle、真实 demo、文档与测试。root 在业务接入前审阅 described-select-IL4BXH 的浅色菜单及深色 900×800 / 125% 截图，双行选项、右侧勾选、焦点和容器边界验收通过；完整组件测试 20/20。

UAH 本轮 typecheck、build 通过；完整单元测试 97/97。桌面 Agent 集成 14/14，证据 artifacts/agents-h25qxB/report.json，使用隔离数据与本地 HTTP fixture，未使用用户端点或密钥。覆盖会话模式/强度立即保存、下轮参数、Plan 指令、历史不可变、Agent 锁定、重启恢复和子代理权限校验。root 已检查 session-permission-menu-light-900-800-125.png 和 session-effort-menu-dark-900-800-125.png：说明可读、勾选正确、长列表在 UI 滚动容器内、没有越出圆角边界。

三协议请求体映射由 transport 测试验证；真实服务对档位的支持仍取决于模型。思考内容展示及真实工具/子代理执行不在本轮验收范围。须重启 Electron 加载新 runtime 与迁移。

## 2026-09-27 工具循环、思考与实际子代理

组件库先完成 UiActivity、rich select 的真实 demo 与视觉验收，UAH 再接入。root 检查浅深主题 900×800 / 125% 的折叠思考、工具审批和子代理执行结果。UI 完整 20/20（28 文档路由）通过；UAH 运行时及 renderer 完整测试 134/134 通过，含三协议原生工具续传、reasoning/signature 保留、审批、工作区路径防护、写入冲突与排队取消、子代理继承/临时/预设角色、权限子集、上下文隔离、并发/深度/停止与恢复、停止理由回传。

Agent 桌面 15 项通过：artifacts/agents-vPhpk5；工具初版桌面 5 项通过：artifacts/tool-chat-U4bcHD；桌面 smoke 和 browser 通过：artifacts/desktop-w0CrQh、artifacts/browser-ndCawa。这些使用隔离数据和本地协议 fixture，没有使用用户 API 密钥或调用付费服务。UAH/UI typecheck 与生产构建通过。当前命令没有 OS 沙盒，auto 仍须审批；bypass 自动执行，进程停止只保证直接子进程。MCP、电脑操作和官方运行时未纳入实现。

后续子代理侧栏变更：组件盘点确认现有 Tabs/Card/ScrollArea/Activity/Dialog/Textarea 足够，未新增共享样式。首级列表和二级只读详情复用真实组件，停止理由弹窗使用 UI 库滚动和固定页脚。桌面验收证据另附于下。

子代理侧栏视觉验收：root 直接检查 artifacts/tool-chat-SE5lMF 中浅色列表、深色只读详情及停止理由弹窗（900×800 / 125%），并检查 artifacts/tool-chat-jhex17 中浅色列表和深色详情（1440×900 并排视图）。主对话与右侧详情分离，状态、返回列表与折叠内容可读；弹窗理由与固定底部动作可见。两级视图、会话隔离、无操作详情、关闭弹窗不停止、空/非空理由、父代理结果与重启恢复六项桌面场景初次通过；宽窗口补充版本测试记录后附。

最终桌面回归 6/6 通过：artifacts/tool-chat-BusPXq/report.json。包含浅深主题宽/窄两种布局、列表/详情横向无溢出断言，以及真实待审批子代理的只读详情和停止流程。root 复核最终深色宽窗口详情截图通过。最新生产构建与两仓类型检查通过。

## 2026-09-27 默认提示词与工具可用性

已确认本机 agents.sqlite 的子代理总开关为 false，默认助手指令长度 0；通过 AgentStore 完成 v4 归档迁移及用户请求的开启，重新读取确认 enabled=true、默认提示词长度 708。未读取或打印 API 密钥，未调用用户模型服务。代码测试 141/141 通过，新增覆盖请求实际 tools 字段及启用/全局关闭/Agent 禁止/模型禁用四种状态、深度限制、默认提示词与迁移幂等/自定义配置保留。生产构建和 TypeScript 通过。UI 仅用已验收组件新增开关说明文本，无共享能力缺口或样式变更。

最新工具桌面回归 6/6 通过，证据 artifacts/tool-chat-giuYEn/report.json，覆盖真实子代理启动/等待、只读详情、停止理由与重启恢复；构建与两仓 typecheck 通过。

## 2026-09-27 并行等待与工具说明

完整测试145/145、两仓类型检查和生产构建通过。新增确定性协议 fixture 保持子代理响应未释放，验证主代理在其运行期间完成独立 read_file；timeoutMs=0 与正数短超时均返回 running，释放子响应后可得到完整结果。另验证超时参数边界、直属任务归属及等待期间停止父子任务。工作区五个工具的文档 JSON 示例均在真实临时文件执行器上验证（命令示例为 Get-Location）；所有8个工具及嵌套参数说明随请求定义传入模型，完整参考 docs/TOOLS.md。未调用用户端点或进行真实模型费用测试。本轮没有视觉样式变更。

## 2026-09-27 对话富文本、平滑流式与工具差异

组件盘点和 UI-first：D:/UI 的 UiMarkdown/UiDiff、真实 demo、独立文档先完成浅深主题与窄屏缩放验收，才接入 UAH；详见该库 VALIDATION.md。主/子代理共用渲染，工具参数不直接展示，提议和真实快照明确区分。

UAH 单元152/152、两仓 typecheck 和生产 build 通过。工具桌面6/6：artifacts/tool-chat-4QrGLC/report.json，包含人工审批提议 diff、执行后的 exact artifact 快照、Markdown正文、子代理只读、停止理由及重启恢复。root 直接检查浅色审批图、浅色 Markdown 完成图、深色工具实际 diff 和1440px子代理详情，接受900×800/125%与宽屏布局。

流式桌面4/4：artifacts/rich-chat-2Xj153/report.json。隔离本地 SSE 分批突发输出，断言数据已完整持久化时呈现仍为部分文本，验证结束完整、向上阅读不被拉回、重新回底部后按实际渲染高度跟随。组件层另验证稳定正文/代码节点与文字选择、减少动态效果和安全富文本处理。未使用用户端点或密钥；Electron 需重启加载新IPC和工具元数据。

最终共享UI回归14/14单元、20/20完整文档桌面检查（30路由）、Markdown专项通过，UAH按最终共享源码重新生产构建通过。构建仅有大型chunk体积提示，公式/图表按需加载。Markdown的嵌套Mermaid围栏当前显示为代码，顶层绘图；未声称任意HTML或所有第三方扩展支持。

## 原型对齐：工具内联差异与轮末文件清单（进行中）

root直接核对 design/UAH_PC_Prototype_v1/src/app.js 的 toolDetails/changesHTML/diffLinesHTML，以及 styles.css 的 tool/codebox/round-changes 样式。缺口：UiActivity轻量内联变体（前图标后箭头/标题统计/无竖线）、UiDiff紧凑变体（单行快照标题/右栏查看）、UiFileChanges清单。先在D:/UI实现真实组合demo和文档、浅深/缩放验收，再消费；不在UAH补业务CSS绕过共享组件。数据从不可变快照计算，同轮同文件首旧末新汇总，并包含子代理真实产物；不读当前磁盘。

本轮完成：共享组件接入前root检查D:/UI/artifacts/conversation-07zftp/wide-light.png与dark.png并记录验收；最终组件证据conversation-KM3a2M，完整文档20/20（32路由），typecheck/14单元/默认Diff与Tooltip回归通过。UAH root检查artifacts/turn-actions-8fpBr8/prototype-light.png和prototype-dark.png，与原型的轻量工具行、内联差异、轮末列表和操作栏对应。

UAH完整单元165/165通过，新增首次展开reactivity回归后renderer workspace12/12、分组/汇总/呈现12/12通过。两仓类型检查与最终生产构建通过。桌面最终证据：turn-actions-HySEzC（连续工具组审批、内联diff、轮末真实统计与右栏、复制、仅编辑历史、首次发送才建分支、最新回复真实再生成、删除展示且文件不撤销）；tool-chat-rXXlyX 6/6（含子代理只读/停止/重启），rich-chat-rUkY1M 4/4（平滑输出/上滚保持），desktop-oDcR4c 8/8（选择/批准/停止/窄屏/滚动/恢复）。所有请求为隔离本地fixture，未使用用户服务。

发现并修复：activityView首次 ||= 返回原始对象导致子代理思考箭头与正文折叠失联，已先赋值再从ref读取代理；桌面默认拒绝浏览器剪贴板权限，复制改为可信renderer只写IPC，await Electron44异步clipboard API，未开放读取权限。操作弹窗采用逐实例useId避免多轮ARIA目标冲突。历史操作的新契约和剪贴板桥须重启Electron。

## 分支修复与 Plan 工作流：组件盘点

本轮实现前 root 核对 D:/UI/src/ui/index.ts、UiCard/UiActivity/UiSelect/UiField/UiTextarea API 与 ConversationDemo：立即保存分支及继承历史沿用既有 Markdown 对话布局；计划审阅复用 UiCard、UiMarkdown、UiField、UiSelect、UiTextarea、UiButton 与布局工具类。没有新增通用交互或共享样式缺口，不复制组件、不增加业务 CSS。使用已验收组件组装，随后进行真实桌面流程和浅深/窄窗口视觉检查。重新生成限制按整个会话的已发生文件写入判断（包括子代理、先改后恢复），不以净 diff 是否为空判断。

本轮完成：180/180 单元通过，包含真实计划文件边界、UTF-8/链接检查、提交与修订、重启后审批、外部文件改变、端点/控制设置/重复审批竞态、普通文字不造计划、子代理拒绝计划工具、分支 Agent 快照及重新生成副作用限制。两仓 typecheck 与生产 build 通过，仍只有既有大型 chunk 提示。最终日志：artifacts/plan-final-tests.log、plan-final-typecheck.log、plan-final-build.log。

桌面 Plan 证据 artifacts/plan-mode-u69DIi/report.json：真实写文件、右栏查看和复制、刷新恢复、文件 tamper 拒批、修改意见生成独立文件、显式 Manual 审批与后续逐次文件审批。root 检查 plan-light.png（1440px/100%）、plan-dark.png（900px/125%），长路径可换行、Markdown/权限说明/审批按钮可用，使用现有组件样式验收。

分支及轮末操作证据 artifacts/turn-actions-rI9BAy/report.json：重启且最新会话无目录后，仍可从原会话立即创建持久分支，历史显示并刷新恢复，未发额外模型请求；发生文件改动时 UI 与 IPC 均拒绝重新生成。root 检查 saved-branch.png，确认选中新分支、继承内容及继续对话输入框真实显示。截图等待渲染帧落屏，避免采到切换前旧帧。

相关回归：artifacts/tool-chat-GJPpA8/report.json 6/6，含工具审批/diff/子代理只读/停止及重启；artifacts/rich-chat-zIBtZx/report.json 4/4，含突发平滑输出、上滚保持、回底跟随、最终完整文本。流式测试修正为等待 ResizeObserver 后的实际自动滚动，不在文字刚发布而下一动画帧尚未完成时断言；未修改流式实现。所有测试使用隔离本地 SSE 和独立数据目录，无用户端点或密钥调用。

## 默认 Agent 与 Markdown 编辑

实现前组件盘点、来源及迁移细节记录在 AGENT-PRESETS.md；复用 UiTextarea/UiTabs/UiTabPanel/UiMarkdown，无共享UI缺口及CSS改动。185/185单元、两仓typecheck、build通过；新增桌面专项 artifacts/agent-presets-S7RKnI/report.json 验证三个真实提示词请求、编辑/预览、键盘、安全渲染及重启保存，root检查浅深/900px125%图片通过。既有Agent桌面15/15证据 artifacts/agents-KfPB75/report.json。构建仍仅有既有chunk体积提示，本轮没有真实用户端点请求。

## 用户模板、上下文钩子与滚动修复

组件盘点：UiScrollArea已有height属性及demo，直接正确配置viewport约束，无共享能力缺口/样式变更。旧构建在24额外角色下滚轮测试失败，修复后artifacts/agent-scroll-x82AxP浅深/窄屏125%滚轮、键盘、末项编辑及回顶部通过，root检查dark.png滚动条与最后卡片。

用户两份附件仅占位替换，新增共同基座+子角色；v6迁移保留自定义，动态槽位不回写。192/192单元、两仓typecheck、build通过（claude-bindings-tests/types/build.log）；artifacts/agent-presets-B7TNvK/report.json验证真实主/子请求含新提示词与当轮状态、子代理无越权工具，Markdown预览/保存/重启通过。详细钩子接口、来源、容量限制与迁移边界见AGENT-PRESETS.md。未使用用户服务或密钥。

## GPT 分层提示词与子预设（2026-09-27）

- 资料包 python scripts/test_tools.py：18/18；MANIFEST 35项全部匹配。export_originals下载固定模型目录Git blob匹配，原始root/subagent字节一致，base仅一处行尾空格差异（verify-pack退出1，未误报通过）。证据 artifacts/gpt-source-verification.json；详细固定hash见CODEX-RUNTIME.md。
- node scripts/generate-gpt-prompts.mjs --check通过；模板逐字、绑定完整性、主子角色分离、动态身份/目录/工具/权限、未来Git/记忆槽位与不递归注入均有单元覆盖。
- npm test：198/198，artifacts/gpt-tests.log；AgentStore 25项涵盖v1到v7、归档、精确旧默认更新、自定义/禁用/删除/碰撞、容量、revision及失败回滚。
- npm run typecheck（UAH与UI）、npm run build通过，artifacts/gpt-types.log、gpt-build.log；仅已有大chunk提示。
- npm run test:agent-presets：artifacts/agent-presets-lbCj0X/report.json，9次真实本地SSE请求覆盖三主预设、Claude/GPT子运行、独立角色和parentRunId、readonly工具边界、编辑器Markdown、键盘、脚本不执行、原文保存及重启。
- 没有共享UI样式改动，复用已验收组件；未使用用户密钥或端点，未调用原生Codex或付费模型。

## 统一条件提示词（2026-09-27）

- 215/215自动测试：artifacts/conditional-tests-current.log。包含v8精确迁移29项、条件装配5项、真实工具循环模拟4项、诊断9项，以及原审批/权限/文件/三协议等回归。早期旧system文案断言失败已改为检查模块/schema/保存原文及精确history；当前全套通过。
- npm run typecheck（含UI）、npm run build通过：artifacts/conditional-types.log、conditional-build.log。构建保留原有chunk体积提示。
- npm run test:agent-presets通过：artifacts/agent-presets-exN25I/report.json，9次本地SSE请求；root检查preview-dark-narrow.png（900px/125%）可滚动、无横向溢出、操作区可达。复用已验收UI，仅说明文字变化。
- 实际从保存的kiro目录发现25项模型；只读数据库存在旧字段格式、safeStorage依赖原userData，测试helper兼容后二者恢复。未修改用户端点，未暴露密钥；早期--list笼统错误已补stage/安全error code诊断。

真实测试报告：

| 服务模型标识 | 只读文件 | 编辑与diff | 真实计划文件/提交 | inherit子代理/等待 |
| --- | --- | --- | --- | --- |
| gpt-5.6-luna | 通过 | — | — | — |
| gpt-5.6-terra | 通过 | — | — | — |
| gpt-5.6-sol | 通过 | 通过 | 通过 | 通过 |
| claude-haiku-4.5 | 通过 | — | — | — |
| claude-sonnet-4.6 | 通过（两轮） | 通过 | 通过 | 通过 |
| claude-opus-4.8 | 通过 | — | — | — |

共13用例全通过。首轮9例：artifacts/kiro-prompts-2026-09-27T15-27-01-722Z/report.json；Claude4例：artifacts/kiro-prompts-2026-09-27T15-28-13-775Z/report.json。运行日志artifacts/kiro-real-tests.log与kiro-claude-workflow.log。服务当前未列出gpt-6-sol，没有以其他型号冒充。型号来自服务目录，未独立核验代理服务背后的上游模型身份。

每例使用隔离project/data和随机nonce；真实调用read_file，验证返回nonce；编辑验证文件OLD→NEW和不可变前后快照；Plan验证write/read/submit与磁盘文件一致且未改项目；父模型真实spawn+wait，子运行实际读取，父没有自行读取替代子工作。全部无命令、无普通审批、无越权文件artifact；Plan保持proposed未实施。未测试账号全模型、全部effort或原生CLI，不把有限烟测当作普遍模型可靠性保证。

脚本只在用户明确启动--models时生成，自动npm test不触发任何真实服务。case最长180秒，使用Supervisor停止/收拢，不按瞬时PID杀服务器。可按case/data/logs/runtime.jsonl核对prompt.assembled（21模块候选，包含跳过原因）与真实工具运行。

## Plan 任务版本与右栏审阅（2026-09-28）

- 组件盘点：复用共享 Card、Field、Input、Textarea、Tabs、Select、Markdown、ScrollArea 和布局工具类，未增加业务 CSS。动态版本标签缺陷先在 D:/UI 修复与文档验收（artifacts/described-select-HRdW5u，见该仓库 VALIDATION.md），之后构建接入 UAH。
- npm test 226/226：artifacts/plan-v2-unit-tests.txt。覆盖当前任务身份、手工编辑历史、同任务 Agent 修订、不可覆盖快照、旧路径迁移、澄清不失效、删除不复活、审批重放/竞态、权限与转换注入、正文展示摘要不改模型输入。最后追加当前标题传递断言后 Plan／prompt／presentation 专项23/23通过。
- 两仓 npm run typecheck、npm run build 通过：artifacts/plan-v2-typecheck.txt、plan-v2-build.txt。保留已有大 chunk 提示。
- Electron tests/desktop/plan-mode.mjs：最终 artifacts/plan-mode-h65cpl/report.json 通过。真实本地 SSE fixture 验证右栏正文、待审批替换 composer、右栏编辑/预览、编辑中禁用审批、保存后可审批、v1/v2/v3、历史只读、复制、reload、外部修改拒绝、Revise 携带用户正文、Manual 批准后仍需文件审批、批准后恢复 composer、对话不重复完整计划、文件精确变更和零 pageerror。
- Root 直接检查本轮截图（artifacts/plan-mode-dULyBn/plan-light.png、plan-dark.png、plan-revise.png、plan-editor.png）：1440px浅色右栏与底部审批同时展示；900px/125%深色操作可达；正文、版本与编辑器均在右栏，审批区有受限滚动，未溢出圆角。最后增加编辑锁后同脚本再次通过 h65cpl。Revise 图中的错误条来自测试刻意篡改计划文件，属于正确拒绝提示。

真实 kiro 最终验证（使用用户已授权端点，各自独立隔离数据/项目）：

| 服务返回模型标识 | 初始规划 / 人工编辑后 Agent 修订 / 实施 | 断言 | 报告 |
| --- | --- | --- | --- |
| gpt-5.6-sol | 三轮 completed，40.5秒 | 20/20 | artifacts/kiro-prompts-2026-09-27T16-24-25-516Z/report.json |
| claude-sonnet-4.6 | 三轮 completed，27.6秒 | 20/20 | artifacts/kiro-prompts-2026-09-27T16-25-09-638Z/report.json |

初始v1 → 用户编辑v2 → Revise反馈v3 → accept-edits批准并精确OLD→NEW。任务身份/标题稳定、反馈marker保留、批准前无项目改动、全部旧版本不变、编辑diff精确、两次审批重放被拒绝；没有命令、外部网络或委派。Root 复查报告；较早GPT/Claude成功报告16-16-22-696Z和16-17-01-534Z保留。此前两次harness失败分别为误拒绝同fixture绝对路径、未明确元数据标题，均保留失败报告；修复测试边界，并在运行时Revise输入中补充实际当前标题和版本。

复现：node scripts/test-kiro-prompts.mjs --plan-review=gpt-5.6-sol（或claude-sonnet-4.6）。只读加载kiro配置，解密key仅在内存；网络限定loopback5580且禁止重定向；不发送用户项目。自动npm test不调用真实模型。有限端到端样本不代表所有模型和故障条件；模型标识来自本地中转服务，未核验上游身份。

## 运行时修复、只读 Git、请求上下文（2026-09-28）

- `npm test`：263/263，通过。`artifacts/git-context-tests-complete.log`。新增三协议晚到子结果、中断效果/删除/分支边界、严格Chat终态/usage、10项Git安全fixture、原生公开上下文投影/密钥私有字段隔离/v1数据库迁移/编辑删除失效、renderer查询竞态与Git呈现。
- `npm run typecheck`、`npm run build`：通过，覆盖UAH与相邻UI库，日志`artifacts/git-context-typecheck-final.log`、`git-context-build-final.log`。保留原有chunk大小提示，不影响构建。
- `npm run test:git-context`：最终37断言、4请求通过；`artifacts/git-context-Eak2dU/report.json`。真实Electron隔离数据目录+临时Git仓库+localhost SSE。实际API目录授权、路径逃逸拒绝、分支/状态/两类diff/log/中文文件、服务usage/缓存/容量、工具续轮/未知usage、会话切换、两次重启及删除详情失效；HEAD与index前后哈希完全一致。pageerror和consoleErrors为空。
- Root逐张检查Eak2dU中Git浅深、context-usage浅深、context-expanded浅深、context-scrolled-dark、context-collapsed-dark图：1440/100%和900/125%均通过。展开后真实文本Range位于内外viewport共同可视区；外壳scrollTop=0，与viewport顶部对齐，固定关闭按钮可达。初次cGG1TW/EnHP9h功能通过但截图不合格的记录保留，未冒称视觉通过。
- UI先行：`D:/UI/USAGE_METER_VALIDATION.md`与usage-meter-qKhMlm六图；`D:/UI/DIALOG_NESTED_VALIDATION.md`与dialog-nested-Avpq9P八图，root均直接查看验收。滚动外壳改clip修复焦点导致的双层滚动空白，无API变化。UI独立嵌套可见性、dialog-scroll及全组件ui.mjs20项全部通过（ui-PHOT1i）。
- Plan完整桌面回归：`artifacts/plan-mode-0PFDSN/report.json`通过，6请求、零页面错误。旧测试对异步桥的等待不足使下一轮尚处draft时断言proposed；改为Node端等待指定轮次数达到并且明确completed，原行为断言保持，回归通过。
- 未调用用户真实模型服务，未修改用户项目Git状态。接口兼容服务未上报usage时保持估算/未知；分类估算不代表精确token或账单。未接入Git写操作、压缩或原生CLI。

## npm UI 依赖迁移（2026-09-29）

- `@lingyzh/ui` 从 `file:../UI` 改为固定的 npm `0.1.0`。`package-lock.json` 记录官方 registry tarball 和 integrity；`npm ci` 后 `node_modules/@lingyzh/ui` 是普通目录，不再是指向相邻仓库的 Junction。已确认包内包含 UiDiff、UiMarkdown，UAH 的类型检查不再运行相邻 UI 仓库脚本。
- Node 24.19.0、npm 10.9.3：`npm ci`、`npm run typecheck`、`npm test`（263/263）、`npm run build` 均通过。构建仍有大 chunk 提示；此次包已包含 Markdown/KaTeX/Mermaid 依赖，生产构建成功。
- `npm run test:ui` 25 项通过，遍历 npm 包的 33 个文档路由，证据 `artifacts/ui-7OByyC`；`npm run test:desktop` 8 项通过，证据 `artifacts/desktop-fW6brH`。前者包含 Electron 生产界面与独立 UI 文档页；后者覆盖隔离 renderer、目录审批、停止、窄屏、历史和重启。没有用此结果冒称全桌面专项或真人视觉验收。
- 测试维护：UI 文档新增的长表单弹窗使旧的首个 `dialog` 选择器失效，Markdown demo 使全局 h1 不唯一，异步剪贴板需等待成功反馈；相应断言已修复。Windows Git 检出 CRLF 与内嵌 LF 模板对比失败，单测读取后统一换行符。上述问题均未要求修改 UI 发布包。
- 迁移前 `package-lock.json` 已有可选平台包 `libc`/`dev` 元数据的本地差异，安装与更新锁文件时保留；本次没有清理这些既有改动。未调用真实模型服务、未改用户运行数据库。

## Harness 会话范围快照与恢复身份扫描（2026-10-02）

- UI固定npm `@lingyzh/ui@0.2.1`，D:/UI干净；复用已验收组件，本轮仅调整数据投影与状态合并，没有新组件或共享样式变更。
- 会话范围renderer集成后全量564项通过（`artifacts/harness-full-scoped.log`）；恢复身份投影后全量565项通过（`artifacts/harness-full-recovery.log`）。最新typecheck/build分别为`harness-final-scope-typecheck.log`、`harness-final-scope-build.log`，均通过，构建保留既有chunk提示。
- Electron日志`journal-desktop-CrNj3L`67项、搜索`search-o3u7MU`6场景、Plan `plan-mode-mI7owP`、工具/子任务`tool-chat-LBh2uJ`6场景均通过。分支首次回归发现selected session遗漏branchMessages，修复后`turn-actions-N5lO9q`通过，root目视复核`saved-branch.png`的继承消息、保存提示和输入区。
- `harness-desktop-performance-GGw2nG`21项通过：100k正文与5000个delta保持一致，仅2次应用snapshot IPC；1000轮初始挂载50，加载到100/150，滚动锚点漂移0.1875px。正文流帧p95为18.2ms、长列表12.2ms，仅单次本地样本，不表示稳定SLA或相对改善百分比。该桌面构建在恢复身份扫描改动之前，恢复改动另由565项自动测试覆盖。
- 当前会话内部runs/approvals/artifacts仍完整查询，启动基本snapshot仍全量校验；canonical恢复身份使用流式SQL，但SQLite仍读取JSON，不冒称完整分页。无真实Provider请求、无用户数据库操作、无提交发布或推送。

后续启动恢复改用流式候选snapshot，保留全部逐条artifact完整性检查，旧数据识别CTE一次物化；新增store13项，联合恢复/历史24项通过。日志面板最高用量revision专项通过。全量579/579（`harness-full-startup.log`）、typecheck（`harness-recovery-view-typecheck.log`）、构建（`harness-startup-build.log`）通过。仍需扫描历史JSON及常驻sessions/approvals，不把降低峰值内存称为完全分页；应用独立连接测试账本仍使用原启动读取。

该构建Electron复验`journal-desktop-YtflTz`67项与`harness-desktop-performance-EeR5Mi`21项通过，错误为空；仍是本地单次性能样本。随后独立应用账本清理已结算probe的内存引用，SQLite记录不删除；application专项7/7（`harness-application-resident.log`）、typecheck及build通过。579项全量和上述桌面构建早于这项局部引用释放修改。

2026-10-02显式续接：全量604/604（harness-recovery-final-test.log）、typecheck/build通过；recovery-desktop-mQQ9Zg十项，root验收浅色1440、深色900/125%。详见HARNESS-D08-RECOVERY.md。

随后会话窗口：全量626/626（harness-window-full.log），store12、renderer9及后端缓存边界通过。窗口typecheck/build通过，desktop性能TlIxXS22项，默认50根及必要依赖，加载100/150位置偏差0.1875px；Plan DcdUxB、回复/分支8ALVLG、工具F9ebu4六场景通过。工具首次jG6Flf最后请求读取断言失败，增加诊断记录后复验通过，未放宽断言，尚不能确定该次失败原因。详见HARNESS-D05-HISTORY.md的边界记录。

## Harness 维护、隐私与分片（2026-10-02）

- 人工目标验收专项 10/10、goal-verification-desktop-DXkxcc 15 项；原始捕获专项 14/14、journal-policy-desktop-OzY2qr 20 项。root 已检查真实 UI 截图。关闭捕获只影响额外请求/响应原始日志，保留聊天/文件快照和必要续接。
- GC 桌面 journal-gc-desktop-5F1ujm 15 项，实际候选删除、引用不变和活动任务拒绝；永久删除 session-purge-desktop-7HsQ7D 23 项，含键盘、浏览器清理、独立分支、真实失败跨重启重试和单实例；browser-purge-bgMXdB 7 项。均零新增工具重放，页面/控制台错误为空。root 验收浅深主题、窄窗和 125%。
- 备份 9/9、迁移 7/7、永久删除后端 31/31、分片轮转 10/10、离线分片 8/8。维护整合 716 通过/2 跳过（harness-purge-full.log），分片整合 734 通过/2 跳过（harness-final-full.log），两次均零失败；最新分片 typecheck 通过。跳过仅 Windows 文件 symlink 权限，硬链接/junction 已实测。最终命令 provenance 改动之后另记最终检查点。
- tool-chat-uLNEtP 六场景通过：测试以 Node 轮询真实终态替代不可靠的异步 wait 表达式。早期全量 fixture 偶遇 Fetch 禁止端口，已按当前 Node 内置端口名单修正 fixture，不改变产品网络策略。
- 新生命周期及限制见 HARNESS-MAINTENANCE.md。全部网络为隔离本地服务，未使用真实付费 Provider；未提交或发布。既有大 chunk 构建提示仍需按实际构建报告区分，不作为运行错误。

最终检查点：命令 provenance 与删除 renderer 收尾后，`harness-release-final-full.log` 共 746 项，744 通过/2 文件 symlink 权限跳过/零失败；`harness-release-final-typecheck.log` 与 `harness-final-build.log` 通过。Electron `journal-desktop-zZSgh8` 与 `tool-chat-73bIC5` 六场景复验通过，root 再看日志深色900/125%截图确认内部滚动、底部动作可达。新增 renderer 删除 7/7 包含成功重试清除旧错误、响应丢失和迟到 snapshot；命令记录不保存额外 EncodedCommand 正文。此为本轮最终代码检查点，不代表已提交或发布。

最终原生复验：21/21，证据 `native-execution-mt0fyD`、`native-credential-filter-jHTq40`；连续执行/释放、树退出、超时/取消/EOF/crash、输出限额及凭据边界通过，exe 文件版本按真实文件核对。后端/managed 28/28、真实命令隐私 2/2。D:/UI 干净，安装依赖固定 @lingyzh/ui 0.2.1，git diff --check 通过（仅既有换行转换提示）。

## D09 原生与扩展管理（2026-10-03）

最终全量 810 项：808 通过、2 个既有 Windows 文件 symlink 权限跳过、零失败（artifacts/d09-tests.log）。typecheck/build 通过（d09-typecheck.log、d09-build.log），构建保留既有大 chunk 提示。专项 MCP 12、扩展存储 13、原生协议+Supervisor 31、API 扩展循环 7 均通过；原生脱敏导出可 replay 公开文本，覆盖为 partial。

Electron 扩展专项 `npm run test:extensions`：13 项、7 张截图，artifacts/extensions-desktop-fPoJsd，页面错误为空。覆盖 HTTP MCP 实际握手、插件诊断、插件启用后技能的键盘开关、禁用状态原生 probe、配置保存/页面重载、原生中文聊天与本轮 usage。root 已检查浅色1440、深色900/125%列表与滚动弹窗、键盘焦点、最终聊天文件快照提示。搜索 search-Yyxl0j 6 项、端点 endpoints-pNjl2C 9 项回归通过。

真实本机 Codex 0.156.1 app-server --stdio 只读 probe 已通过，模型目录 7 项、登录有效、进程正常退出（d09-native-probe.json）；未发送真实 Provider 请求。远端 Git clone 与外部 MCP 服务未实测，协议使用本地 SDK fixture。完整范围与剩余限制见 HARNESS-D09.md。UI 仓库干净，未提交或发布。

### 原生绑定迭代验收（2026-10-03）

- 全量 822 项，820通过、2个既有 Windows symlink 权限跳过、零失败：artifacts/d09-iteration-tests.log。修复 request-capture fixture 对随机 fetch 禁用端口的遗漏；typecheck、build与diff check通过。
- 新增扫描7/7、renderer目录3/3；原生协议23/23。覆盖 draft probe 不保存、不创建线程，model字段与展示id区分、isDefault与顺序保留、迟到响应不撤销停用、启动目标变化隔离目录、item/tool/call 不可跨入UAH子代理。
- Electron专项21项，9张截图：artifacts/extensions-desktop-PExS3g；扫描与自动填写、模型默认项、保存前不变更配置、重载恢复全部模型、教学弹窗和关闭后焦点、子代理边界、原生中文对话通过，无页面错误。
- root查看浅色1440与深色900/125%截图；候选使用简短来源标签避免长路径挤压，完整路径仍在可编辑输入框。帮助、开关说明及边界卡片清晰，内部滚动与底部动作可达。复用既有UI组件，无共享外观改动；D:/UI干净。
- 本机自动发现3种启动方式并探测元数据。未发送真实模型任务，未新增原生与UAH子代理工具桥。

## 原生委派与内置技能（2026-10-03）

- 全量 `npm test`：851 项，849 通过、2 项既有 Windows 文件 symlink 权限跳过、零失败（`artifacts/native-bridge-final-tests.log`）。最终 typecheck/build 通过（`native-bridge-final-typecheck.log`、`native-bridge-final-build.log`）；构建仍有既有大 chunk 提示。`git diff --check` 通过，只有换行转换提示。
- 原生协议 36/36：动态工具 start-only 注册、活动身份绑定、等价调用去重／冲突拒绝、限额、异常、提前完成与取消；未注册能力仍拒绝。委派集成 11/11：原生父任务同时调用 API 与原生子任务、角色及上下文隔离、API 文件审批和命令/MCP 不可用、权限不可提升、全局开关／深度／并发上限、父任务停止传播及 API→原生拒绝。无显式 wait 的父任务会收到自动结果续轮；用量累计与共享预算结算有断言。
- 内置技能 5/5、旧扩展存储 13/13；17 个资源文件按字节复制到构建目录。覆盖默认启用、持久停用、同名独立、不可卸载、路径/链接边界及资源完整性。两个 skill-creator quick_validate 均通过；Windows Python 使用 `-X utf8`。
- Electron `extensions-desktop-x7diTg`：24 项、9 张截图、页面错误为空（`native-bridge-desktop.log`）。覆盖内置技能启停及原生父子委派终态；root 检查技能浅色列表、原生深色900/125%边界说明与最终浅色聊天工具活动，无新增共享样式。最终构建复验见下文。
- 实机 Codex 0.156.1 元数据验证：model/list、临时 thread/start 接受动态工具和禁用原生协作/unified_exec 配置，进程正常 close；`native-bridge-metadata-probe.json`。没有发送 turn/start 或真实付费模型任务，不能把注册成功当成真实模型自主调用的验收。上游非并行工具调度依据固定在 rust-v0.156.1，升级须复核。
- 本轮公开限制见 [NATIVE-DELEGATION.md](NATIVE-DELEGATION.md)：API 父任务不能反向启动原生子代理；原生 API 下级无命令/MCP；原生预算和日志仅覆盖宿主可观察数据；内置 Grilling 在 UAH 缺少交互提问工具时按技能文本回退。D:/UI 干净，固定 @lingyzh/ui@0.2.1，未提交或发布。

最终构建复验：`artifacts/extensions-desktop-2OTgeH` 同样24项、9截图、无页面错误（`native-bridge-final-desktop.log`）；root复核深色900/125%边界卡片，内部滚动和底部动作正常。全量检查之后补充失败子任务的 wait 结果及后续原生轮次可继续测试，委派专项达到12/12（`native-bridge-final-delegation.log`），最终类型检查通过；这项测试没有修改产品代码。

## 原生权限、Plan/Goal 与真实 Luna 验收（2026-10-03）

- 最终全量 `npm test`：882 项，880 通过、2 项既有 Windows symlink 权限跳过、零失败，见 `artifacts/native-mode-final-tests.log`。typecheck/build 通过，见 `native-mode-final-typecheck.log`、`native-mode-final-build.log`；构建仅有既有 chunk 大小提示。
- 覆盖三档原生权限、MCP 不再阻止只读启动、Plan 模式与权限分离、原生问题卡片回答/取消/过期拒绝、原生目标自动续轮、查询不发模型请求、用户停止暂停目标及同线程恢复、暂停失败不假报。旧轮次 usage 不得绑定当前 turn；独立问题 item 不要求属于活动 reasoning item；原生 plan delta 进入公开文本。
- Provider 单测与桌面验证：修改协议或端点保留加密 key、模型选择与覆盖参数，检测/测试仍使用原 key，renderer 不获取明文。端点专项 10 项通过：`artifacts/endpoints-Z6o3ZM`、`native-mode-endpoints.log`。
- 最终 Electron 扩展专项 30 项、11 张截图、无页面错误：`artifacts/extensions-desktop-2Ff9R5`、`native-mode-final-desktop.log`。root 复核相同最终 UI 的浅色1440与深色900/125%问答、菜单、设置；问题下拉初始显示“请选择”，没有默认替用户提交，滚动后提交动作可达。复用固定 @lingyzh/ui@0.2.1，无共享外观或组件能力缺口，D:/UI 干净。
- 用户授权使用现有 OpenAI OAuth，仅 Luna。真实连续三个轮次均使用 gpt-6-luna：保留 MCP 配置的只读普通对话成功；Plan 正好一次问答回传，接收 A 后输出“Print marker A.”；Goal 使用原生工具到 complete。证据 `artifacts/native-luna-smoke.json`，包含 answered 断言与事件/用量。原生 MCP 启动兼容已验证，未借此宣称外部 MCP 业务服务已实测。
- 真实 UAH 原生委派：父、唯一子代理均 gpt-6-luna / readonly / codex-native；父调用 uah_spawn_agent 和 uah_wait_agents，收到 UAH_CHILD_LUNA_OK 后返回 UAH_PARENT_LUNA_OK，23.15秒完成。父输入22640、输出10、缓存输入22272；子输入19967、输出10、缓存输入1792。证据 `artifacts/native-luna-delegation.json`。没有 API 模型、其他模型或文件/命令/外部 MCP 业务调用；未读取或复制账号凭据。
- 客户端错误集中使用当前简体中文提示，保留日志诊断及模型/工具原文；renderer 预期已相应更新。行为说明见 NATIVE-CODEX-COMMANDS.md。未提交、推送或发布。

全量完成后新增一项无产品代码变更的回归：“问题答案持久化失败仍清理等待项”。该项单独运行通过（1/1，`artifacts/native-mode-question-cleanup-test.log`）；不计入上面的882项全量数字。

## 原生内容、真实上下文、附件与计划修订（2026-10-03）

- 最终全量以 `npx tsx --test --test-concurrency=4 tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs` 运行：913 项、911 通过、2 项既有 Windows symlink 权限跳过、0 失败，见 `artifacts/native-rich-final-bounded-tests.log`。此前默认高并发复跑中，两个既有 API fixture 等待超时；保留 `native-rich-final-tests.log`，未删改失败记录。较早默认全量912项亦通过。最终 typecheck/build 通过，见同前缀 final-typecheck/final-build 日志；仅有既有 chunk 大小提示。
- 原生公开思考摘要、命令/MCP/dynamic/fileChange 参数和结果、分片累积及脱敏、错误退出码、错线程/错轮次拒绝、私有推理不入公开记录均有测试。真实上下文保留 last/total 分离，安全整数、缺省未知、缓存写入零值均覆盖。附件覆盖严格验证、大小/编码限制、工件完整性及回收引用、路径类附件不读取内容、图片和文本进入实际 turn/start。
- 最终 Electron `node tests/desktop/native-rich.mjs`：29 项检查、10 张浅/深色截图、无页面错误和外部 API 请求，证据 `artifacts/native-rich-fkkGbk`，日志 `native-rich-final-desktop.log`。真实 File 经 preload 的选择、拖入、粘贴路径均通过；包含内存 PNG、文本快照和 PDF 路径引用。Plan 正文/步骤、Revise 不发送、执行退出 Plan、上下文详情及工具参数/结果均已断言。
- root 已复核菜单、附件、工具、上下文和计划面板的浅色1440/深色900且125%缩放截图；菜单与对话框动作可达，窄布局可内部滚动。Revise 自动关闭工作面板返回输入框，避免反馈输入被遮住。事前盘点复用 UiMenu/MenuItem、Dialog、Card、Button、Markdown、UsageMeter，无共享组件缺口，无共享外观改动；D:/UI 保持干净，固定 @lingyzh/ui@0.2.1。
- 用户授权的真实调用均为本机已有登录的 gpt-6-luna，未读取/复制凭据。`artifacts/native-context-live.json` 确认真正 tokenUsage 通知：last.total19907、input19900、output7、cached16128、reasoning0、capacity258400。核对固定 CLI 源码后使用 last.totalTokens 作为上下文值；UI 原始比例不同于 CLI 扣除12000基线的剩余比例。没有暴露完整系统/历史/工具分类用量。
- `artifacts/native-attachment-live.json`：实际图片工件 localImage 加文本快照，模型返回 `ATTACHMENT_OK red LUNA_ATTACHMENT_TEXT`，本轮上下文20418/258400。`artifacts/native-plan-live.json`：三个真实轮次 mode 为 plan、plan、default，最终返回修订后的 PLAN_EXECUTED_2；该简单任务没有发出原生 plan item，因此真实测试只证明模式/反馈/执行切换，正文/进度同步由协议及桌面 fixture 验证。
- 本轮 API 附件未启用；其他文件只是路径引用，历史迁移到新原生线程不承诺重放旧附件二进制；只展示公开思考摘要。详细行为与限制见 NATIVE-CODEX-COMMANDS.md。未提交、推送或发布。
- 既有扩展桌面回归 `npm run test:extensions` 最终通过30项、11截图、无页面错误，证据 `artifacts/extensions-desktop-g0EGyi`、`native-rich-extension-regression.log`。最终 typecheck 和 diff-check 通过，UI 工作区仍干净。

## Provider 调用 ID 与原生目录（2026-10-03）

- 用户经 harness 提问确认采用可编辑调用 ID，并保留内部标识。新增 Provider ID 表单及列表展示，空白回退默认 ID；端点库 v4→v5 增加可选 alias，更新和删除仍使用内部 ID。EndpointStore 专项15/15通过，覆盖旧版本迁移、未来版本拒绝、别名格式/重复/保留字/内部ID冲突、大小写及 Unicode、清空和缺字段保留、key不变、目录不解密凭据。
- 完整回归最终 `npx tsx --test --test-concurrency=4 tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs`：923项、921通过、2项既有Windows权限跳过、0失败，`artifacts/provider-id-final-tests.log`。首次全量的4项旧提示词版本断言已更新；另2项遇到fixture随机端口被网络库禁用，原始失败保留于 `provider-id-full-tests.log`，相关34项复跑通过（`provider-id-port-recheck.log`）。未降低产品网络安全限制。
- 原生/API目录及alias委派、条件提示词与委派工具注册定向44/44通过。API子代理使用调用别名解析后，在effective和session.initialConfig中保存canonical内部ID；不去掉resolver的身份匹配检查。目录按次读取并白名单投影，无额外地址/密钥字段；API来源未接入与空目录分开，原生只声明当前模型。目录及角色合计256KiB上限明确报错。`delegation.presets`升v2、`context.tools`升v3；已核对冻结gpt/claude迁移模板，不改旧完整绑定文件。
- `npm run test:endpoints` 10项通过，新增断言覆盖companyID→公司→留空默认→恢复、ID冲突、已有会话/密钥/模型配置保持。证据 `artifacts/endpoints-mtawD8`。root复核浅色列表与深色900/125%编辑器：ID可见、描述换行无横向溢出、底部动作可达。事前盘点UiField/Input/Card及真实demo，无共享UI能力缺口，未修改D:/UI或增加业务样式。
- 最终构建上 `node tests/desktop/provider-catalog.mjs` 3/3通过，无页面错误：真实Electron preload→main→utility process→native动态工具链路查询目录，别名修改后下一次查询即时更新，停用后不再返回API条目，保留native当前模型。证据 `artifacts/provider-catalog-DzoI9e`、`provider-id-final-desktop-catalog.log`。模型协议为本地fixture，未新增真实付费模型调用。
- 最终typecheck/build通过，日志 `provider-id-final-typecheck.log`、`provider-id-final-build.log`；构建仅有既有chunk大小提示。diff-check通过。字段/行为说明见NATIVE-DELEGATION.md，未提交、推送或发布。
## 2026-10-03 原生工具展示、展开性能与线程确认

- UI 盘点复用既有 UiActivity/Collapse/CodeBlock/Markdown/Card/Button。没有新增通用能力或共享 CSS；D:/UI 干净，固定 npm UI 版本不变。业务层首次展开挂载，真实组件负责折叠动画。新开始的主轮次恢复滚动跟随，防止此前展开旧内容后新确认停留在视口外。
- 全量 `npx tsx --test --test-concurrency=4 tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs`：935 项，933 通过、2 既有 Windows 权限跳过、0 失败。日志 `artifacts/native-activity-v2-all-tests.log`。`npm run typecheck`、`npm run build` 均通过，对应同前缀日志。
- 原生运行时专项 25/25：首次/兼容续接无需迁移确认；配置变更先停等，批准才启动；取消、非精确回答、Stop 不创建线程；等待期间历史/运行时/委派工具配置变化使批准失效；最近失败无 thread 时仍找到更早线程；旧 Goal 操作不跨线程伪装续接。确认前不消耗请求预算、不发 native-start。
- 工具呈现与分组专项 16/16，包含 UAH 前缀/原生动态包装/未知工具/原始结果/精确身份去重/思考公开摘要。未知与原生工具显示真实名称，原始文本不作为 HTML 执行。测试日志 `artifacts/native-activity-v2-renderer-tests.log`。
- Electron Provider 目录及展示专项 4/4，无页面错误，证据 `artifacts/provider-catalog-RUrMOb`。root 核对 `native-provider-summary.png`：准确工具名、可读角色/Provider/模型目录、按需展开原始返回均可见。
- Electron 原生富内容专项 32/32，无页面错误、无外部请求；12 张截图，最终证据 `artifacts/native-rich-Rfqwc0`。覆盖附件、思考/命令/MCP、上下文、Plan/Revise，以及新增线程确认先取消再批准。root 复核浅色 1440、深色 900/125%：确认原因、旧 ID、迁移说明和两按钮可读、可滚动到达，无横向溢出。早期新增脚本在窄屏工作面板覆盖输入框时超时，测试先关闭面板后通过；截图在缩放稳定后滚动到确认按钮，避免截到旧活动。证据保留在 `native-rich-2TwPvb`。
- `npm run test:rich-chat` 4/4，验证流式渐进、主动向上阅读保持位置、底部跟随和完整终态。最终证据 `artifacts/rich-chat-r4jThR`。
- 性能同场景单次前后对照均成功：15 轮本地 fixture、约 1.02 MB 活动，无模型调用。侧栏开时思考/工具布局 101/108→72/64ms，滚动写入 10/11→0/0，折叠 DOM 2932→1882。报告 `artifacts/native-activity-performance-CQHSB0` 与 `native-activity-performance-xeVCqn`；测量范围和不确定性见 `NATIVE-SESSION-INVESTIGATION-2026-10-03.md`。不是所有长会话的帧率保证。
- 指定用户会话只读取证：12 native runs、3 threads，10 对重复动态工具身份匹配；一次恢复失败后换线程可确认，另一次具体恢复条件不可从旧日志判定。没有读取凭据/私有推理、调用真实模型或改写用户会话。`git diff --check` 通过；累计改动未提交、推送或发布。
- 2026-10-03 追加 RPC 报错透传：原生协议/运行时/客户端错误专项84/84，typecheck/build通过（`artifacts/native-rpc-error-tests.log`、`native-rpc-error-build.log`）。新增测试覆盖 thread/resume 原始原因/错误码、Bearer/URL脱敏、长度上限，以及错误进入失败run与导出后仍不含已配置连接器秘密。首次超长测试把12KB文本直接放入启动参数，被既有8KiB限制拒绝；改为fixture内部生成超长响应后通过，没有放宽产品限制。未运行真实模型，用户将重新复现。
- 2026-10-03 消息时间戳：typecheck/build通过，steer-loop 9/9，原生桌面35项/14截图通过。验证 `<time datetime>` 与真实createdAt相等、完成时间显示至秒；root检查 artifacts/native-rich-KfyG4n/message-time-light-1440.png 与 message-time-dark-900-125.png，浅深色和缩放均可读无横溢。使用既有UI组件及工具类，无共享样式改动；缺失时间不猜测。日志 message-time-desktop.log、message-time-steering.log、message-time-build.log。

## 2026-10-04：项目规则与独立 Markdown 记忆（无专用 UI）

- 用户明确不需要记忆 UI；没有新增页面、入口、IPC 或共享组件。D:/UI 保持干净，本功能无需视觉验收。规则及记忆通过运行时工具和 Markdown 维护，使用原有工具审批。
- 最终全量 `npx tsx --test --test-concurrency=4 tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs`：972 项，970 通过、2 项既有 Windows 权限跳过、0 失败；证据 `artifacts/memory-all-tests.log`。`npm run typecheck` 和 `npm run build` 均通过，日志为 `artifacts/memory-typecheck.log`、`artifacts/memory-build.log`。构建仍有已有的大 chunk 提示。
- 来源与存储专项27/27：作用域及mtime选择、override、无新规则不增加请求、继承导入作用域/兄弟目录共享引用、循环/越界/ADS/链接、缺失home懒读取、外部白名单、跨项目私有隔离、哈希CAS、并发存储实例、手改正文、托管区块保留、墓碑去重、已提交记录/索引失败区分。证据 `artifacts/memory-storage-tests.log`。
- API/原生循环专项7/7，包含在最终全量日志中：Chat Completions、Responses、Anthropic 实际请求均读取最新主规则和固定偏好；首轮与来源列表不含外部正文，明确search/read后才出现；候选写入后下一请求索引可见，固定5次工具循环且无隐藏总结请求。readonly/Plan/子代理不提供记忆写工具；bypass也不能把未批准的active偏好伪称用户确认。首次子目录写入先返回RULE_CONTEXT_CHANGED且文件未写，重决策后才写。原生thread/start和turn/start都没有新增规则/记忆模块或知识工具注入。
- 首轮默认高并发全量中，旧提示词模块版本断言6项失败，已随host.contract/context.tools版本更新；一项既有MCP分页测试偶发失败，独立12/12和最终限制并发的全量均通过。早期缺失home导致请求失败已修复，并增加不创建目录的回归。未掩盖这些中间失败。
- 所有新增测试使用临时home、项目与本地HTTP/native fixture，不读取真实用户记忆，不调用真实模型。未运行新增桌面测试（本功能无UI变更），未提交、推送或发布。机制与限制见 MEMORY-AND-PROJECT-RULES.md；任意shell/MCP内部访问不在明确path的规则拦截范围内。

## 2026-10-04：记忆流程核查与日期主题文件名

- root 只读取证指定会话 bf4db85c-0214-40dd-bc4e-0d65a1ef0d4f 的完整导出：3464 连续事件、17 次请求，读取的产物逐一校验 SHA-256。三作用域记忆、真实激活审批、固定偏好、预期负例和遗忘清理均有证据。记录中的“跨会话”实际为同一 session 的只读子代理；不扩大其验证结论。详见 MEMORY-SESSION-INVESTIGATION-2026-10-04.md。
- 全量 `npx tsx --test --test-concurrency=4 tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs`：979 项、977 通过、2 项既有 Windows 权限跳过、0 失败，证据 artifacts/memory-names-all-tests.log。
- root 最后补强已提交遗忘后的读回失败分类，保留 confirmed/reconcile_first。补强后存储/知识工具/运行循环定向 26/26 通过，artifacts/memory-names-final-focused.log。覆盖可选 slug、中文/长标题、重名避让手写 Markdown、旧 UUID 兼容、元数据 ID 歧义、错误 UUID 文件名、真实索引路径、改标题不改路径、遗忘改名与部分失败报告。
- 独立根会话及关闭后重建 Supervisor 读取同一 Markdown 的集成测试通过；新会话输入不继承旧提示，索引提供真实 basename，正文经 read_context 读取，固定 8 次模拟 provider 请求。重启范围为运行时对象重建，不宣称完成操作系统进程重启实测。
- 最终 typecheck/build 均通过：artifacts/memory-names-typecheck.log、memory-names-build.log；保留已有 chunk 大小提示。diff-check 通过，D:/UI 干净。本次没有 UI 改动，未增加桌面视觉测试；所有写入测试均使用临时目录，没有改写被核查会话或真实用户记忆，没有真实模型调用、提交、推送或发布。
- 中间存储专项曾出现 1 项错误分类失败：按 ID 扫描遇硬链接被当作未找到；已修为明确拒绝不安全文件，最终15/15通过。并行编辑期间的类型错误已修复，最终检查通过。

## 2026-10-04：取消累计估算 token 停止

- 删除累计 token 的请求准入和报告超额停止条件；保留估算/服务商报告计数，累计及在途统计采用饱和加法，达到数值表示上限也不停止。新快照 maxEstimatedTokens=null、estimatedTokensExceeded=false；合法旧数字上限及已超限快照恢复时保留计数并取消限制。仅保留旧错误代码用于历史兼容，没有新的 estimated_tokens 抛出点。
- 全量 `npx tsx --test --test-concurrency=4 tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs`：981 项、979 通过、2 项既有 Windows 权限跳过、0 失败，artifacts/token-unlimited-all-tests.log。最终 typecheck/build 通过（token-unlimited-typecheck.log、token-unlimited-build.log），构建保留已有 chunk 提示，diff-check 通过。
- 纯预算14/14、调用循环8/8通过：旧低数字上限不阻止高usage后的实际临时文件写入/下一请求；450万输出token仍完成；provider使用量向下修订仍原样保留，累计计数不回退。请求/工具/时限/并发限制及单次上下文检查保持原测试验证。
- root恢复及提示词专项25/25通过，token-unlimited-recovery-tests.log：模拟旧400万上限、已累计500万且超限的停止任务，重启后可核对并续接，token上限归一null、计数保留、旧工具不重放。context.environment v6明确仅统计，冻结Claude/GPT迁移模板不修改。
- RecoveryDialog仅删除token额度显示并更新解释文字，沿用现有组件/布局/样式，无组件缺口和视觉设计改动，D:/UI保持干净。未额外运行桌面视觉测试。全部新增验证使用临时数据和本地协议fixture，不调用真实模型、不恢复真实用户任务；没有提交、推送或发布。

## 2026-10-04 API 上下文 V2 验收

实现与限制见 [CONTEXT-ENGINE-V2.md](CONTEXT-ENGINE-V2.md)。全量日志 artifacts/context-v2-regression-final.log：1026 项，1024 通过、2 跳过、0 失败；三协议各 30 轮工具并跨后续用户回合／重启，前缀稳定、工具无重复。后补 operational pause 单文件 11/11 通过。最终 build 日志 artifacts/context-v2-build-final.log；保留既有大 chunk 提示。

桌面 artifacts/git-context-1oHPTE：cache 234/1234 显示 18.96%，剩余分类按 64000 减可见估算；未知／不完整 usage 不补零。root 查看 context-usage-light.png（1440px）与 context-usage-dark.png（900px、125%），现有组件布局和滚动正常。共享 UI 无修改。

用户授权真实验收（独立非敏感前缀，无用户历史和工具）：DS deepseek-flash、公司 gpt-6-luna 均 Responses，各 3/3 成功。DS input 2636，cache 0/2432/2432，coverage partial；公司 input 2615，cache 0/2612/2612，write 2612/0/0，coverage complete。证据 artifacts/context-usage-live-probe-20261004/{deepseek,company}-run.jsonl。warm 占比 92.26%／99.89%，仅为小样本端点机制验收，不是生产长任务收益证明。

## 2026-10-05：上下文会话统计与长任务恢复

- 全量：1042 项，1040 通过、2 跳过、0 失败，artifacts/context-v3-regression-final.log。
- 末轮定向：context-prune、compaction-loop、request-context 共 13/13，artifacts/context-v3-final-recovery.log；归档身份 SQL 投影额外 journal-recovery 与 prune 共 7/7（agent 执行）。session usage 六项与 scaling 五项包含在全量中。
- typecheck / build 通过：artifacts/context-v3-typecheck-final.log、context-v3-build-final.log。UI @lingyzh/ui 0.2.3 发布与安装已核对官方 npm integrity，UI 仓库发布记录完整。
- 桌面 Git/context 通过：artifacts/context-v3-desktop-final.log，证据 artifacts/git-context-TUV2ao。新会话启动草稿、显式选择历史、会话累计18.96%测试值、冷灰剩余分类、输出等预留、浅色1440与深色900/125%均覆盖，root复核截图。测试值不代表服务端收益。
- 240 次持久化、160 次后重启的 scaling 专项记录 artifact 增长及耗时；无硬编码时间门槛，不宣称全量请求序列化及引用写入已消除。
- 真实模型验收结果待本轮报告；零测试、缺少真实补丁或模型失败不能算 coding 通过。

### 本轮最终验收补充

- 最终全量采用4并发：1044项、1042通过、2跳过、0失败，artifacts/context-v3-regression-bounded.log；解决测试环境并发争用，不放宽产品断言。新增部分缓存配对统计与请求上下文专项12/12，压力专项9/9。typecheck/build通过。
- 最终桌面专项再次通过：artifacts/git-context-6VDefi；root复核浅色截图。原浅深主题及125%验收保留。
- 真实 coding 与缓存对账见 [CONTEXT-LIVE-VALIDATION-2026-10-05.md](CONTEXT-LIVE-VALIDATION-2026-10-05.md)。缓存比例是相同尝试配对字段的加权比；出现缺失时同时展示已上报覆盖，避免跨字段错配或把缺失补零。
- 真实试验进一步修正 provider 基准校验：粗略估算不能否定有效报告；超限时不受提前压缩的25%增长节流限制。压力测试已验证真实摘要提交后继续工具调用，无法充分缩小时保留错误。
