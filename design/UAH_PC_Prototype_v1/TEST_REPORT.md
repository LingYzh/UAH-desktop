# UI 测试与截图报告

## 最终综合检查（2026-09-25，当前结果）

已用临时目录安装的 Python Playwright 和本机 Edge 独立实例完成 **71 / 71** 交互检查，0 页面错误、0 外部网络请求。新增回归涵盖管理页返回草稿、空会话列表、目录并发取消与发送前复查、会话独立压缩状态、窄窗展开左栏、Agent 全不选工具、计划文件一致性和文件附件返回草稿。

已重采 **62 场景 / 142 张截图**，含浅深主题与 10 个不同窗口场景；0 根容器横向溢出、0 页面错误。800px 打开 Diff 时中央宽度为 359px（此前 186px），1024px 为 567px。人工查看窄窗 Diff、计划审批及内置浏览器新会话页面；其余截图生成不等于逐像素全量人工审查。

`node --check src/app.js`、`python build.py` 与文案索引生成通过。完整发现与剩余边界见 `FINAL_AUDIT.md`；文案按 `COPY_GUIDE.md` 和 `COPY_INVENTORY.md` 交接。以下各节是此前迭代的历史证据，包含“Playwright 缺失”“旧截图未重采”等当时限制，已由本节当前结果更新。

## 新会话首屏底部输入区验证（2026-09-25）

新会话欢迎标题和快捷任务移至上方内容区，输入区复用聊天页的底部停靠容器。在 Codex 内置浏览器分别查看浅色和深色首屏，并实际从新草稿发送一条演示消息：发送前后输入框均位于窗口底部，目录行与模型等控制项保持相同排列。验收产生的演示会话已删除。上方内容在窗口高度不足时独立滚动，输入区保持可见。

`node --check src/app.js`、`python build.py` 和测试脚本语法检查已通过；已补充发送前后 composer 坐标的自动用例，但当前 Python 环境缺少 `playwright`，该用例尚未运行。截图画廊仍是旧基线，本节以当前浏览器画面为准。

## 目录选择器与入口整合增量验证（2026-09-25）

重建原型并在 Codex 内置浏览器逐项查看：已选择主目录时，主目录菜单出现“管理附加目录”；清除主目录后此入口消失，普通聊天仍可继续。目录弹层只保留已选目录列表、移除操作和文件夹选择按钮，没有手填路径框。MCP 本机工作目录也变成“选择文件夹 / 清除”，表单不再提供路径输入框。已点击 MCP 的“选择文件夹”按钮；系统原生对话框不在内置浏览器截图范围，未将该点击算作完成了真实目录选取。新增自动化用例用模拟目录句柄验证目录名称、会话边界和 MCP 草稿保留，但本机 Python 缺少 `playwright`，用例尚未运行。

`node --check src/app.js`、`python build.py` 与 `python -m py_compile tests/interactions.py` 已通过。网页原型只保存目录名称，正式 Windows 客户端获取与校验绝对路径仍需实现；下方旧基线截图尚未重采。

## 会话目录范围与新草稿增量验证（2026-09-25）

此前版本通过本地服务在 Codex 内置浏览器检查：设置导航移除“会话默认值”，发送快捷键留在“外观”；全局目录页只管理项目；当时的会话附加目录使用独立入口和手填路径表单。该入口与表单已由上面的目录选择器迭代取代，此段不再描述当前 UI。此前测试过新对话会清除附加目录，而模型与项目选择继续保留；从新草稿进入设置再返回会回到草稿。

使用界面“重置原型”后，首次草稿显示“选择模型”，输入正文时发送仍禁用；选择 Sonnet 4.6 后发送恢复可用。重置流程也修复了页面退出保存旧状态的问题。已增补自动化脚本用例，但当前 Python 环境缺少 `playwright`，运行时在导入阶段停止，新增用例尚未自动执行。当前场景索引为 62 项，截图画廊索引为 142 张旧基线截图；截图尚未按本次视觉改动重采。本节为浏览器手动交互证据，不代表真实 Windows 沙盒或官方客户端集成验收。

## 表单下拉菜单增量验证（2026-09-25）

通过本地服务在 Codex 内置浏览器实际检查了设置页的浅色与深色下拉框、MCP 表单的传输方式与超时、会话默认值，以及右栏后台任务的紧凑状态筛选。展开选项的圆角、间距和选中态与表单控件一致；MCP 传输方式通过点击选项及键盘聚焦后按 Enter 都能正确切换表单。检查后已恢复原来的深色主题。`node --check src/app.js` 与 `python build.py` 已通过；不支持可定制原生 select 的浏览器会使用系统选项列表，本次未做跨浏览器验收。下方 49/49 仍为旧版基线，不能视为本次自动化结果。

## 紧凑思考卡片与侧栏增量验证（2026-09-25）

已通过本地服务在 Codex 内置浏览器检查：输入区思考入口只显示 `High` 一类英文档位；卡片没有档位详情列表、动效文案或重置按钮；问号换成线性 SVG，键盘聚焦后显示说明；未知档位的 Antigravity 示例按 Gemini 协议显示四个临时档位，提示上游可能拒绝。左栏完整收起后，顶部按钮可以重新展开，底部头像仍固定在底部。

`node --check src/app.js`、`node --check src/icons.js`、`python build.py` 和测试脚本语法检查已通过。自动化交互脚本已补充以上路径，但当前环境没有 Python `playwright`，无法运行这组新增用例。下方 49/49 为旧版基线，不能作为本次结果；截图画廊尚未重采。

## Ultra 与输入区增量验证（2026-09-25）

本次以本地服务在 Codex 内置浏览器打开重建后的 `index.html`。实际点击验证了 Codex Ultra 的紫色流动填充、覆盖区域刻度点隐藏、普通档位的刻度恢复、键盘逐档切换和点击停靠；Claude Code Ultra 的 `xhigh + 动态工作流`说明也已核对。Sonnet 4.6 API 的档位菜单最高为“最大”，没有 Ultra。旧本地草稿中已保存但当前模型不支持的 Ultra 会自动回退到可用档位。

`node --check src/app.js` 和 `python build.py` 已通过。自动化脚本已增加 Ultra 能力检查，并修正窄窗扩展栏测试的旧抽屉断言；当前环境缺少 Python `playwright`，这些新增用例尚未自动复跑。下方 49/49 仍是原始基线结果，截图也未按本次视觉改动重新采集。

## 本轮增量验证（2026-09-25）

本轮修改了会话扩展栏、左侧导航、MCP 表单、运行时适配和上下文圆环。`python build.py`、`node --check src/app.js` 与 `python -m py_compile tests/interactions.py` 通过。在 Codex 内置浏览器通过本地 HTTP 预览，实际点击检查了侧栏收起时头像位置、当前会话计划文件与空状态、后台任务列表、子代理两级只读会话、MCP 新增与再次编辑、运行时适配页、上下文单色圆环与分色详情。

下方 49/49 和截图统计属于修改前的基线结果，**不能视作本轮自动化复跑结果**。本轮增补了四组交互检查，但当前 Python 环境缺少 `playwright`，运行 `python tests/interactions.py` 时在导入阶段停止；尚无本轮全套自动化通过结论。

执行日期：2026-09-25（Asia/Tokyo）。本报告来自本包脚本的实际执行结果，而非预期值。

## 结果

| 检查 | 实际结果 |
|---|---|
| `node --check`：app / data / icons | 均通过 |
| 自动化交互检查 | 49 / 49 通过，0 失败 |
| 交互执行中的未捕获页面脚本错误 | 0 |
| 交互执行中的网络请求 | 0 |
| 固定场景 | 63 |
| 浅色 / 深色标准截图 | 126（63 × 2） |
| 长页下半部截图 | 8 |
| 其他窗口尺寸截图 | 10 |
| 总截图 | 144 |
| 截图期间未捕获页面脚本错误 | 0 |
| 检查的标准 / 响应式布局 | 136 |
| 根页面横向溢出 | 0 |

## 执行方式与边界

浏览器为环境提供的 Chromium，Playwright 无头执行。环境禁止 `file://` 和本地 HTTP 导航，因此测试使用 `page.set_content()` 将完全相同的单文件 HTML 注入 `about:blank`，没有用这项测试冒充 Windows 双击验收。opaque origin 可能阻止 localStorage；应用会安全退回内存。真实本地文件 Origin 下的持久化另行验证。

截图使用系统或用户减少动效，避免截到过渡中间帧。视觉脚本检测根容器横向溢出，**不代表自动证明所有可访问性、颜色对比、文本遮挡或像素一致性**。已人工查看主要浅色 / 深色、Diff、管理页与窄窗审批样本。

模拟流式回复、后台保留、取消、授权门槛与状态恢复已做 UI 检查。真实网络、模型、运行时、Git、Shell、MCP、插件脚本、Windows 控件、浏览器登录、OS 凭据存储、Android ZIP 导入均未调用或验收。导出测试检查生成 JSON，不代表 Windows 文件保存对话框已验收。

## 已执行的交互用例

| # | 检查 | 结果 |
|---|---|---|
| 1 | Draft does not create an empty history entry | PASS |
| 2 | Stopped/history-only directory does not show concurrency warning | PASS |
| 3 | First valid send commits exactly one session | PASS |
| 4 | Simulated streaming continues in background and cancellation stops it | PASS |
| 5 | Active Git directory requires an explicit worktree decision | PASS |
| 6 | Ordinary folders never offer Git worktree | PASS |
| 7 | Command disclosure expands actual sample command/output inline | PASS |
| 8 | Editing disclosure uses an inline diff, not a tool modal | PASS |
| 9 | Disclosure state survives panel and session changes | PASS |
| 10 | Each session retains its panel and selected diff file | PASS |
| 11 | Current file navigation does not overwrite historical diff | PASS |
| 12 | A no-change round still displays its changes section | PASS |
| 13 | Binary, missing, large and uncertain diff states are explicit | PASS |
| 14 | Reading a tool is not approval; Allow is an explicit action | PASS |
| 15 | Plan viewing remains separate from execution approval | PASS |
| 16 | Denied approval is recorded without execution | PASS |
| 17 | Cross-runtime selection creates a branch draft with migration boundaries | PASS |
| 18 | Changing a model within UAH does not fabricate a runtime branch | PASS |
| 19 | Unsupported reasoning does not display a fabricated slider | PASS |
| 20 | Reasoning changes use discrete declared efforts | PASS |
| 21 | Readonly mode blocks browser writes even with global toggle enabled | PASS |
| 22 | Global computer/browser controls default off | PASS |
| 23 | Target authorization is explicit, logged and revocable by Stop | PASS |
| 24 | Stale observations cannot be used for actions | PASS |
| 25 | A second parent cannot steal the screen lease | PASS |
| 26 | MCP project switches are scoped independently | PASS |
| 27 | Remote MCP authentication gates its declared tools | PASS |
| 28 | Provider editing never puts API secrets in prototype state | PASS |
| 29 | A newly added provider starts disabled | PASS |
| 30 | Official login UI manages one sample account without password capture | PASS |
| 31 | Each executable hook requires a separate explicit grant | PASS |
| 32 | Installing a plugin neither enables its hooks nor silently activates it | PASS |
| 33 | Plugin uninstall has a restore path without retained execution grants | PASS |
| 34 | Memory CRUD safely renders text without executing HTML | PASS |
| 35 | Project file preview and source are separate views | PASS |
| 36 | Import preview can skip every conflicting item without writes | PASS |
| 37 | Import copies are stopped and the previous state is recoverable | PASS |
| 38 | Malformed import files are rejected before mutation | PASS |
| 39 | Export serializer omits API keys, headers and runtime credentials | PASS |
| 40 | Sensitive export requests a second explicit confirmation | PASS |
| 41 | Theme and reduced-motion changes preserve tool state | PASS |
| 42 | Keyboard search and Escape close their overlays | PASS |
| 43 | The right column is draggable | PASS |
| 44 | Narrow overlay keeps approval and Stop reachable | PASS |
| 45 | The demo terminal never executes arbitrary commands | PASS |
| 46 | Exit stops active sessions and reopen does not auto-resume | PASS |
| 47 | Failures remain explicit until the user manually resumes | PASS |
| 48 | No page-level JavaScript errors | PASS |
| 49 | Prototype makes no external network requests | PASS |

## 证据与复跑

`tests/interactions.json` 为原始交互结果；`tests/visual.json` 含逐场景布局尺寸；`SCREENSHOTS.json` 与 `screenshots/` 一一对应。修改源文件后运行 `python build.py`，再运行 `python tests/interactions.py` 和 `python tests/capture.py`。需要 Python、Playwright 和 Chromium，浏览器路径可通过 `CHROMIUM_PATH` 指定。

正式验收仍需真实 Windows 11 的窗口 / 高 DPI / 多屏 / 输入法 / 键盘 / 屏幕阅读器 / 原生进程与登录测试。场景覆盖数量不能替代这些验收。
