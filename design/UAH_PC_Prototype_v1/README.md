# Used AI Harness · PC UI 原型

**先打开 `index.html`。** 这是一份可独立打开的交互式网页，不需要安装 Node、启动项目、联网或填写 API Key。在 Windows 上也可以双击 `start.bat`。

本交付对应 `LingYzh/AgentApp` 的 `design/UAH_PC_HARNESS_FUNCTIONAL_DESIGN.md`，读取基线为 `master` 的提交 `a149f2ef6f0a955cfd5f289601c5e122e533ab56`。视觉参照 Claude 网页端的阅读式界面与 Claude Desktop 的任务工作区，继续使用仓库里已有的 UAH 标志，而不是替换成 Claude 品牌。

## 从哪里开始

打开后是独立的新对话草稿。欢迎内容位于上方，输入区从首屏起停靠底部，首次发送后不会跳位。可以直接输入内容，也可以先选择目录；首次有效发送才会创建历史会话。左侧的示例会话可以直接进入，工具行、右侧面板、设置和管理页均可操作。

左下角 **原型导览** 提供 62 个固定场景入口；它是评审工具，不应进入正式应用导航。每次跳转会恢复用于该场景的样本数据。`gallery.html` 可按主题与关键词查看浏览器截图，并跳回对应交互场景。

建议先看 `新对话 → 对话与工具 → 三栏与历史 Diff → 命令审批 → 跨运行时切换 → 插件详情 → Windows 电脑控制 → 导入冲突预览`。场景链接采用 `index.html#scene=diff` 这样的本地地址。

## 交付内容

| 文件 / 目录 | 用途 |
|---|---|
| `index.html` | 全量单文件交互原型，CSS、JS、图标全部内嵌 |
| `gallery.html` | 截图画廊，支持主题、类型和关键词筛选 |
| `screenshots/` | 2026-09-25 最终检查重采截图，以 SCREENSHOTS.json 收录项为准 |
| `SCENES.json` / `SCREENSHOTS.json` | 当前 62 个场景与 142 张当前截图的机器可读索引 |
| `DESIGN_SPEC.md` | 视觉、布局、组件、状态与交互规范 |
| `COVERAGE_MATRIX.md` / `.csv` | 原需求到页面、交互与真实集成边界的映射 |
| `CODEX_HANDOFF.md` | 实施交接与逐场景验收规则 |
| `FINAL_AUDIT.md` | 本轮发现、修复、验证证据及正式开发仍需落实的边界 |
| `COPY_INVENTORY.md` / `.json` | 构建时生成的开发文案与样本源码处置清单 |
| `COPY_GUIDE.md` | 区分产品文案、真实状态与仅供评审的说明；正式实现时的清理要求 |
| `INTERACTION_MAP.md` / `MOTION_MATRIX.md` | 状态跳转、交互入口和动效边界 |
| `TEST_REPORT.md` / `tests/` | 已执行测试、原始结果及复跑脚本 |
| `design-tokens.json` | 从实际 CSS 提取的 Token；`src/styles.css` 为视觉权威 |
| `assets/icons/` | 67 个独立 SVG 线性界面图标，使用 currentColor |
| `assets/uah-mark.svg` | 从仓库既有 UAH Android 向量资源转写的标志 |
| `src/` / `build.py` | 可编辑源文件与无第三方依赖的 HTML 组装脚本 |
| `reference/SOURCES.md` | GitHub 基线、原标志来源与官方设计参考 |

这里的 **62 是场景数，不是 62 个独立页面**。场景包括主工作区、管理及详情页面、6 类右侧面板、弹层与重要异常状态。

`screenshots/` 是最初交付时的视觉基线；后续输入区、分栏、Ultra 动效和 Windows 目录权限改动以当前 `index.html` 为准，截图尚未重采。旧“会话默认值”的两张截图仍在目录中，但不再对应当前场景。

## 可以实际体验的交互

系统文件夹选择器与活动会话并发提示；无目录草稿提交与模拟流式回复；主目录菜单中的当前会话附加目录配置，下一段新会话不继承；当前会话的计划文件、全部后台任务和两级子代理只读会话；命令和 Diff 原地展开；会话分支；单色上下文圆环与分色详情；独立的模型、紧凑思考滑块和权限菜单；可增长的多行输入框、可配置发送快捷键和本地会话引用；左侧栏动效、分栏拖动与右侧面板挤占中央区域；Ultra 紫色动态滑块与档位停靠；未上报档位的协议默认值；计划阅读与执行审批；多终端标签和安全示例命令；浏览器标签、独立登录示例、目标授权、过期观察和屏幕租约；供应商与 Agent 编辑；本机 / 远端 MCP 完整配置与项目开关；官方运行时适配页；插件开关与 hooks 逐项授权；记忆编辑；导入冲突、回滚与 JSON 导出。

网页原型调用浏览器文件夹选择器，只能可靠取得文件夹名称；正式 Windows 客户端应调用系统文件夹对话框，取得并校验完整路径。原型中的目录名称不用于真实文件或命令执行。

非敏感原型数据在浏览器允许时保存在本地存储。隐私模式、受限环境或某些 `file://` 策略下会退回内存，不影响 UI 演示。API Key、请求头、网站密码与官方凭据不持久化。**请不要在原型中填入真实密钥。**

## 明确的边界

这是 **UI 设计与交互验收原型，不是已经实现的 Windows Harness**。官方客户端检测、模型调用、MCP 连接、Shell、Git worktree、电脑控制、浏览器网页与登录均为本地样本，不会执行真实网络或系统操作。

普通附件仅保留用户主动选择的文件元数据，不上传、不解析。导入可以真实读取本原型导出的 JSON；Android / 正式 UAH 归档只演示验证、冲突和授权隔离流程，未实现其归档格式兼容。Markdown、公式与 Mermaid 类流程图是排版样本，不是生产解析器。

设计参考是 Claude 的界面语言与官方公开说明，不是对某一用户账号、某一发布批次的逐像素复刻认证。没有分发 Claude 字体、官方网页源码或品牌资产。

## 编辑与复跑

修改 `src/styles.css`、`src/data.js`、`src/app.js` 或 `src/icons.js` 后执行：

```text
python build.py
```

仅重建 HTML 不需要安装任何第三方包。开发者复跑浏览器验收需要 Python、Playwright 和 Chromium；可使用环境变量 `CHROMIUM_PATH` 指定浏览器：

```text
python tests/interactions.py
python tests/capture.py
```

自动测试在独立的 Edge / Chromium 实例中注入同一份单文件 HTML；另用本地服务在 Codex 内置浏览器手动复查。两者都不代表 Windows 桌面客户端或操作系统集成验收。详见 `TEST_REPORT.md`。

## 快捷键

`Ctrl + N` 新草稿；`Ctrl + K` 搜索；`Ctrl + B` 收放侧栏；`Ctrl + /` 原型导览；`Esc` 关闭当前弹层或扩展栏。发送键可在设置中选择 `Enter`、`Ctrl + Enter` 或 `Alt + Enter`；`Shift + Enter` 换行。输入框随内容增高到上限，之后内部滚动。中文输入法组字期间不会用 Enter 误发送。

本次交付以本地原型和设计文档为准；未提交、推送或发布。
