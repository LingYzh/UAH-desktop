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
