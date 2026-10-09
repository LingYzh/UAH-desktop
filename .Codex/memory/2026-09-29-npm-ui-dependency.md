# UAH 使用 npm 版共享 UI

## 2026-10-09：UAH 已合并 main

用户明确要求直接合并。PR #1 已从 draft 转为 ready 并成功合并，merge commit c02fb3be04f96acda515b8867d41676a375078fa，https://github.com/LingYzh/UAH-desktop/pull/1。合并后文件树与已验收适配提交 196d397 完全一致（tree d51f06740a4f5f9396da1791e360b094678fd38e），原 11 项门禁证据继续适用；本地 main 已同步。后续仅补记合并状态，未修改产品、依赖或测试，未制作安装包。下方待审阅/未合并状态为合并前历史。

## 2026-10-09：最新固定版本与验收

UI 已先合并 main 并正式发布 0.4.2（7f63179 / v0.4.2，Actions 37896838790）。UAH 固定官方 registry 包，lock resolved/integrity 与安装目录一致，Root 核对单一物理 Vue 运行时；其他依赖锁元数据保持原 HEAD。五处 TabsWindow / 十五个 eager Items 迁移完成，保留 model/idPrefix、keyboard=false、transition=false、表单实例和原生浏览器宿主。

ChatWorkspace 等待所选 IPC 历史和 DOM 更新后恢复阅读位置，原 600px 回归通过。SearchDialog 用公开 width 与转发 attrs/工具类恢复 800px 宽度、padding=0、关闭按钮靠右，默认动画由正式 UI 0.4.2 修复。测试按 DOM 弹层真实 closed 生命周期等待焦点/原生视图恢复；系统 DPI 仅在精确原生尺寸夹具固定为 1，应用 zoom 仍受测。

最新 11 项门禁全部通过：typecheck、完整 npm test（1045 项 / 1043 通过 / 0 失败 / 2 跳过）、build、完整 test:ui，以及 appearance 8、extensions 32、browser 7、agents 14、smoke 8、rich-chat 4 组和 plan-mode。test:ui 保留 173 旧文档 URL/hash、家族标题、生产搜索动画/焦点/布局、分页和表格；当前页名称和按钮 ::before 悬停状态层断言与正式包一致。

完整单测限制四个文件并发，保留全部用例和原时限；既有有界随机端口循环遇到 Windows 保留端口 EACCES 时重选，没有修改系统网络。初次 0.4.1 消费 10 门禁 4 通过 / 6 失败、单测 1045/1037/6/2，以及 0.4.2 中间失败、旧构建与测试协议漂移均保留。后续真正完整单测 1045/1043/0/2 单独记录，不把定向复跑当作全量通过。

版本化证据：docs/checkpoint-evidence/2026-10-09-ui-0.4.2-consumer.json，包含源码 SHA-256、各门禁 attempt、原始日志哈希、截图目录及覆盖边界；本机原始日志在 artifacts/ui-0.4.2-consumer。最终 build 0023 和最后完整 UI 回归覆盖 SearchDialog 最终修改，完整单测与七组桌面专项的覆盖范围另列。当前分支准备提交推送并创建到 main 的审阅请求；UAH 尚未合并 main、未制作安装包。

下文 0.1.0 / 0.3.2 / 0.4.1 为带日期的历史记录，当前依赖以本节和 package/lock 的 0.4.2 为准。

## 2026-10-09：正式0.4.2已安装，最终消费门禁准备

文档搜索回归须跟随新canonical页面名UTextField（inputPage.name），不能继续查询旧UiInput字样；库自己的完整UI测试已采用UTextField。仍检查input原子路由#/input、family标题、搜索清空/菜单收起/焦点归还；此为消费测试适配，不改已发布库搜索协议。

完整0.4.2首轮1045/1040/3失败/2跳过，三项均随机端口EACCES（53521/54873/55333仍在excluded ranges），长用例三个协议全部通过。将同类已有有界随机端口分配循环的11处剩余runtime夹具与Plan桌面夹具统一允许EACCES重新选择，保留原16/32次上限及全部断言；不是修改产品网络。DOM动画恢复后extensions焦点/browser原生view恢复在aria-hidden之后仍需等待真实closed生命周期，增加有界等待并保留实际焦点/view身份断言。下一轮完整unit及消费专项另行保留证据。

Root视觉复核发现SearchDialog父级scoped根选择器不再穿透Teleport容器，原800px与padding规则失效，正式截图显示弹层变窄。改用UiDialog公开width属性与forwarded style/class保持800px、零padding和原flex内容布局，移除无效根规则；业务子内容scoped样式保留。消费test:ui新增实际computed width/padding断言。没有复制UI样式或发布消费端私有动画。

第二张新宽度截图显示关闭按钮旧scoped根规则同样不传递到UButton headless根；使用已存在ml-auto/text-muted库工具类恢复标题右侧对齐，增加实际header尾边几何断言，保留SearchDialog的业务子内容样式与库按钮行为。

UI main7f6317940535e2d37f4db2eadba1b502ddcb8fd4/v0.4.2已推送，Actions37896838790/job113710005316全部成功，Linux308/308与Publish/provenance确认。registry短暂传播未显示版本，原404/ETARGET保留，之后official version/latest0.4.2及541文件tarball已确认，再正常npm固定安装。integrity=sha512-eQiOy5BIz1ncwP2IrRP+wDxTXNRmjBryt+p394RujK0HAiLZlWYIIYT9zJAzmLjZ9fJ0++3KiwyvjVgqPVb5rg==。其他lock entries按原HEAD保持，非link安装。ChatWorkspace历史加载滚动修复后smoke8组通过，最终源码/正式包全门禁尚待完成。

## 2026-10-09 正式0.4.1消费首轮诊断

进一步验证发现smoke同步派发scroll及等待10秒后仍失败，属于已有滚动缺陷，不能归因于测试同步时序。ChatWorkspace选择会话时先渲染空历史再异步IPC返回，旧实现提前恢复scrollTop被短内容钳制，并由scroll监听覆盖保存位置。现在pendingScrollKey等待snapshot.viewSessionId匹配且DOM更新后恢复，加载期间不记录空内容位置或跟随到底。仍使用原600px回归断言。Plan测试另外按first.sessionId检查controls，避免把创建更早但未使用的Plan workflow当作正在审批的Plan fixture。

首轮10门禁4通过6失败；单测原始1045项/1037通过/6失败/2跳过，日志保留artifacts/ui-0.4.1-consumer/run-001.json。随机端口50111/49874/49882均落在Windows excluded TCP ranges，三个已有32次端口分配循环允许EACCES重选，不更改系统网络。长用例受全套并发资源竞争，4文件定向并发2验证30/30通过；全套限制4个文件并发，仍保留全部用例及原时限。桌面appearance/agents原生尺寸断言受125%系统DPI舍入影响，测试启动固定device scale=1，应用自身zoom仍照常覆盖。plan-mode重载后默认新草稿，测试必须显式选回保存的提案；smoke赋scrollTop后同步派发scroll与已有rich-chat夹具一致，仍保留600位置断言。

生产搜索弹窗真正缺少默认动画，Root定位到UI省略transition被Vue Boolean转换为false，库先修复并发布0.4.2，UAH等正式registry确认后升级；禁止用业务CSS绕过组件缺陷。首轮并非通过状态，下一次完整结果另记。

## 2026-10-09 正式发布顺序

最新用户决定先合并UI main并正式发版，再适配UAH。UAH实际仍固定0.3.2，以下0.1.0为最初迁移历史。UI0.4.0标签CI换行失败且Publish跳过；修复后0.4.1全部本地门禁通过，e891c76/main/v0.4.1已原子推送，Actions run37893864781正在发布。必须等Actions Publish与官方registry版本/latest/tarball/integrity确认，再固定升级UAH；不改为file link或复制源码绕过发布。

Tabs迁移保持显式model/idPrefix、eager持久性、transition=false和keyboard=false；新TabsWindowItem已在UI补齐原生class/style/属性/事件转发。UAH工作面板的flex/滚动与浏览器原生视图矩形由root验收，菜单和23弹窗的DOM层及焦点生命周期需实际回归。

UI0.4.1现已正式发布，run37893864781包括Publish全成功，registry latest0.4.1。UAH只升级此固定包并迁移五处Window/15Items；lock的其他依赖与原HEAD保持一致。Window的额外语义panel/内容层需要高度贯通，WorkspacePanel使用限定直接子层的规则，不影响内部PlanFiles编辑Window；padding/滚动放在被隐藏的内部内容，避免非活动panel空盒子占空间。原GitPanel/Markdown v-if不变，eager保证原表单/浏览器组件实例持续存在。

UAH完整docs消费测试仍遍历173旧URL、检查原hash与无溢出；标题按同包navigation.js使用家族路由匹配，Snackbar服务控件只在其region内定位。正式包源码导出仍保留Ui*兼容入口，不机械改Field/Picker名称。

- UAH 的 `@lingyzh/ui` 依赖固定为公开发布的 `0.1.0`，锁文件必须有 `registry.npmjs.org` 的 tarball 与 integrity，不得保留 `file:../UI` 或 `../UI` link 条目。
- 使用 `npm ci` 安装；不需要相邻 UI checkout。`npm run typecheck` 只检查 UAH，自 UI 源码仓库验收后发布的新版本需单独升级 UAH。
- Vite 的 `resolve.dedupe: ['vue']` 保留，npm 包仍通过 `src/ui` 的 Vue/TypeScript 源码导出。共享 UI 改动遵循 UI demo 与视觉验收先行，再发布和升级消费者。
- 2026-09-29 迁移前，UAH 锁文件已存在平台可选包元数据的本地改动；迁移时保留这部分既有差异，不把它当作本次依赖修改的清理对象。
- UI 文档页现有两个弹窗示例，桌面测试必须定位已打开的“共享弹窗”；Markdown 示例也有自身 h1，文档标题不要用全局唯一 h1 断言。剪贴板写入是异步的，先等待按钮反馈“已复制”再读 Electron 剪贴板。
- Windows 的 Git 检出会把 portable prompt Markdown 变成 CRLF，而内嵌模板为 LF；逐字单测读取磁盘内容后需统一换行符。Node 24.19.0 验证：类型检查、263 单测、生产构建、UI 集成 25 项与桌面烟测 8 项通过。

最终 docs 回归同步正式包分页当前页 aria-label（带‘，当前页’）与统一 UDataTable loading 根选择器；保留 aria-current、键盘切页、省略号、边界和异步排序断言。

Text 按钮背景保持透明，悬停通过 ::before/currentColor 状态层呈现。消费测试与 UI 仓库一致：验证 idle opacity=0、hover opacity 增加、状态层颜色、border/background 不变，覆盖两主题及三种表面。
