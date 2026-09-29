# UAH / UI 新会话交接

更新日期：2026-09-29。本文记录历次增量，文末为最新状态；新会话先检查实际 Git 状态和用户最新要求。

提交检查点说明：用户现已授权把UI与UAH全部累计改动连同handoff分别提交。下文各阶段的“未提交”是历史记录；以文末2026-09-28提交检查点和实际git log/status为准。当前可用能力包括三协议API、工具/审批/委派、Plan、只读Git和请求上下文，并非开篇历史增量所述的纯文本阶段。

## 本轮增量：API 与端点

用户已确认先接 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，订阅与官方运行时稍后处理。入口为侧栏「模型与账号」。支持端点增改删、启停、目录发现与手动模型 ID、真实流式连接测试、会话模型选择和文本多轮对话。

密钥由主进程使用 Electron safeStorage 加密保存至独立 `endpoints.sqlite`，不进入 renderer 返回值、localStorage、运行 SQLite 或事件。网络请求在 utility process；关闭应用和停止运行会取消请求。新端点默认启用，至少配置一个模型后保存；启停开关位于 provider 卡片；删除或停用后不能新发请求，不自动换模型。更改地址/协议必须显式替换或移除旧密钥。

端点初版复用 UI 组件与布局工具类；后续弹窗修复先在 UI 新增并验收 UiDialog 的 scrollable/error、header/footer 能力，再接入端点编辑器。实现说明和验收证据见 `docs/API-INTEGRATION.md`、`docs/VALIDATION.md`；新增桌面专项命令为 `npm run test:endpoints`。没有真实服务商凭据的外部调用记录，协议与桌面验证使用本地 HTTP fixture。

当前 API 仅支持文本对话，不读取目录内容、不写业务文件、不调用工具；附件收发与高级请求模板未实现。模型思考参数、Agent 配置和权限校验见文末最新增量。已有本地验证适配器仍供底座回归，旧会话保持原运行时。以下历史基线表和验证数字是本次接入前状态，以实际 Git 状态和增量验收记录为准。

## 开始下一步前

1. 阅读两个项目的 AGENTS.md，以及本文。根据用户最新要求继续；不要把已完成的文本 API 接入扩展成未经指定的完整工具引擎。
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

- UAH 的 package.json 固定使用 `"@lingyzh/ui": "0.1.0"`，从 npm registry 安装，不再依赖两个目录相邻。
- `node_modules/@lingyzh/ui` 是普通安装目录，不是指向 UI 源码仓库的目录联接。组件唯一实现保留在 UI 包，没有复制回 UAH。
- UI 的 package.json exports 将包入口映射到 `src/ui/index.ts`，样式映射到 `src/ui/styles.css`。npm 包发布 Vue/TypeScript 源码，需要消费端 Vue/Vite 构建。
- UAH 的 vite.config.ts 配置 `resolve.dedupe: ['vue']`，确保 UI 与宿主使用同一 Vue 实例。
- 业务文件从 `@lingyzh/ui` 导入组件；UAH 的 `src/renderer/main.js` 先加载业务 styles.css，再加载公共 UI 样式。tokens 也通过包导出引用。
- 修改 UI 源码不会即时改变 UAH；先在 UI 仓库完成验收并发布新版本，再升级 UAH 的依赖与锁文件、重新安装并构建。

```js
import { UiButton, UiInput, UiTabs, UiTable, UiDataTableServer, UiPagination } from '@lingyzh/ui';
import '@lingyzh/ui/styles.css'; // 仅在应用入口加载一次
```

首次安装，在 UAH 项目目录执行：

```powershell
npm ci
```

UI 独立开发：在 D:/UI 执行 `npm run dev`，端口 5174，入口 `/#/overview`。构建产物为 `dist/docs` 和 `dist/lib`；`npm run preview` 默认端口 4174。

UAH 网页预览：`npm run dev:web`，端口 5173；`/ui.html` 是兼容入口，通过包导出加载同一个 UI 文档页面，不是一套独立副本。桌面开发用 `npm run dev`，独立服务从 5175 开始，遇占用自动递增，实际地址传入 Electron，并使用独立 Vite 缓存；关闭 Electron 只关闭该次启动所拥有的服务，不动网页预览。生产构建/运行用 `npm run build`、`npm start`。原生辅助组件需要 .NET 10 SDK 和 `npm run build:native`。

网页预览目前没有 preload 提供的 `window.uah`，只显示界面。完整 Web 对话需新增 HTTP/SSE 或 WebSocket 后端适配，复用运行与端点逻辑；密钥存储、认证和本机能力边界需独立设计，不能只在浏览器中解除 disabled。尚未实现 Web 后端。

## 已完成的 UI 工作

- 25 个文档路由、16 个文档化组件；公开入口另导出 UiIcon、vRipple、snackbar 及相关类型。
- 组件包括表单、按钮、Tabs/TabPanel、Dialog、Collapse、Card、ScrollArea、CodeBlock、SnackbarHost，以及 Table、DataTableServer、Pagination。
- 支持适用组件的 dense、ghost、直角变体，各自页面有演示；浅深主题、语法高亮、工具类、ripple 和减少动效已实现。
- 滚动区域允许向父容器传递无法消费的滚动；垂直 Tabs 支持 indicator-side=start/end。
- 表格排序使用上下三角 SVG；ghost 按钮 hover 无边框，使用主题文字色 7% 透明覆盖，按下 12%，保留键盘焦点。
- UAH 右侧工作面板 Tabs 使用 dense。设置页点击主题即时预览，保存后保留，放弃离开恢复最近保存的主题；取消离开保留当前预览。
- 服务端表格由调用方请求数据；文档模拟延迟、失败和请求竞态，组件本身不请求网络或二次分页。不包含行选择、分组、多列排序、虚拟滚动。

## 实现边界

UAH 是 Electron + Vue + Pinia + TypeScript 核心 + .NET 辅助进程的方案 A 底座。本地验证适配器可验证流式事件、审批、新文件、快照和停止恢复，但不调用 AI。文本 API、端点目录和系统加密密钥已在本轮接入；官方 CLI/订阅、工具引擎、PTY、MCP/插件执行、电脑动作和正式发行仍待实现。

关键资料：`docs/ADR-001-electron-vue-foundation.md`、`docs/VALIDATION.md`、`design/UAH_PC_HARNESS_FUNCTIONAL_DESIGN.md`、原型目录及其 REVIEW_FIXES.md。原型历史截图和旧交接文件不代表拆库后的最新结构。

## 验证基线

- UI：类型检查、文档/库构建通过；单元 2/2、独立界面 20/20。证据 `D:/UI/artifacts/ui-uX7okq`。
- UAH：类型检查、构建通过；单元 16/16、UI 集成 25/25、外观 7/7、搜索 5/5、桌面 8/8、原生浏览器 7/7。
- 对应证据依次为 UAH artifacts 下的 ui-mVri9k、appearance-WBy9qo、search-GYBsL7、desktop-NZUHtb、browser-wOeOEa。root 已检查三角排序图标、ghost 浅深主题和表格截图。
- 这些是上一轮功能基线，本轮主要更新工作规则及交接资料，并修复未使用的 forms.css 兼容入口仍指向搬迁前路径的问题。不要称为全套回归已在每次文档变更后重跑。
- 测试证据、node_modules、dist、IDE 配置被忽略，不在 Git 中；换机器后需要重新构建/测试。UI 独立测试使用隔离 Electron 宿主，无 UAH 依赖。

下一会话根据实际变更选择必要测试，不机械重跑全部。新增/改动共享视觉能力时，始终先在 UI 文档中验收，再验证 UAH 集成。

## API 诊断增量
已添加本地 JSONL 轮转日志及「打开日志目录」入口，错误显示中文解析原因、状态、类型和 requestId。范围与使用见 docs/DIAGNOSTICS.md。未认证请求的 401 不能解释用户此前的“数据无效”；该真实请求根因仍需用更新后的详细错误确认。

## 模型发现与标题栏增量
模型目录按响应结构通用解析，不再按生成协议校验分页；同步并显示服务报告的能力，随端点保存（schema v2 自动迁移）。去掉侧栏重复 UAH 品牌行，导航切换在顶部标题栏且为 no-drag。细节见 API-INTEGRATION.md。指定用户诊断已确认首响应有 25 个有效 ID，旧版失败发生在分页检查；新版通用解析覆盖无分页返回，但未使用用户密钥重放真实请求。

## 手动能力与测试结果增量
新增每模型能力设置，手动覆盖优先于接口声明、刷新保留，可恢复并清除 token 覆盖；schema v3 自动迁移。原生图片/PDF/音频/视频输入独立识别，参考 AgentApp。测试结果改在弹窗顶部持续显示实际回复和耗时。移除所有“返回对话”文本按钮（面板仍有关闭图标）。详细行为及范围见 API-INTEGRATION.md。

## 模型选择器分组增量
UiSelect 新增隐藏 placeholder，picker 内使用 UI 库 UiScrollArea；模型选项按已启用且非空的端点（provider）分组，模型行仅显示 ID，同名模型仍使用 endpointId + modelId 唯一值。本地验证保留为独立选项。先完成 UI demo 视觉验收后接入 UAH。

## 已有对话模型切换修复
删除已有会话的 disabled 模型按钮，新建和已有对话统一复用已验收 UiSelect，无共享 UI 缺口或新增样式。当前选择按会话保存于 renderer；下一轮 start-run 可附 selection（endpointId/modelId，null 明确选择本地验证）。运行时验证端点、模型及并发状态后，将下一轮 effective 与会话 requested 原子持久化，历史 run 不修改。生成期间选择器禁用，结束后恢复。运行时接口有变，需重启 Electron。

## Provider 卡片与能力图标
卡片使用 UI 库 compact 布局，名称/开关同行，地址单行截断，操作与摘要允许换行。新增端点 enabled=true，store 不再强制新端点停用；新建和更新均校验启用时至少一个模型。卡片启停保存保留密钥与模型元数据，使用普通数据跨 IPC，忙时锁定，错误回退并在列表显示。详情移除启用开关。能力列表只显示支持项图标（输入/输出含悬停与无障碍名称），token 上限及手动标记保留，完整状态仍在能力设置中。

能力图标使用新共享 UiTooltip（D:/UI），统一悬停与键盘名称提示；原生 Popover 顶层避免被滚动区裁剪。窗口滚动、resize、Esc 隐藏；组件库已补 demo、独立文档页及测试。最终验收见 VALIDATION.md。新增默认启用涉及主进程，须重启 Electron 才完整生效。

## Agent 设置与关闭文案（2026-09-27）
关闭弹窗的按钮统一使用关闭，模型能力编辑器 aria-label 为关闭模型能力设置；阻止离开脏表单的按钮为继续编辑。真正运行取消状态保留。新增侧栏 Agent 页面、主 Agent 与子代理角色 CRUD、调度预设及对话主 Agent 选择。主 Agent 指令/生成参数/历史长度/超时已实际用于三协议请求并持久化到每轮 effective，子代理执行按用户确认暂缓。独立 agents.sqlite 由 utility process 管理，严格配置解析与 revision；更多说明见 AGENT-SETTINGS.md。共享 UI 新增并先验收 UiTextarea。需要重启 Electron 加载新 IPC 和运行逻辑。

## Agent 与模型解耦、权限（后续增量，优先于上节）

主 Agent 不再接受模型/生成参数；生成设置迁入 provider + model，下一轮从端点读取并快照。首次运行落库后主 Agent 身份、指令、权限、委派标志锁定，后续预设修改或删除不影响已有会话；换 Agent 或 API/本地运行方式须新会话。主 Agent 继续委派默认开启。子代理角色精简，保留可选模型绑定。

权限为 readonly / accept-edits / auto / bypass，用户确认 bypass 允许任意操作。子代理启动配置可指定 provider、模型、思考强度、继承/预设/临时 Agent；可信 IPC 使用父运行快照校验，不信任来路的父权限，禁止越权。previewDelegation 只生成已验证配置，真实工具与子代理执行按用户确认继续暂缓。Agent v1 完整原文在 schema v2 迁移时归档，旧生成参数不再使用且未擅自映射到模型；详见 AGENT-SETTINGS.md。新增运行进程与 IPC 逻辑需重启 Electron。

用户后续补充：每次子代理启动允许主代理自行选择完整父上下文、挑选/整理的部分消息、无上下文新会话。已加入 context all/selected/none 契约和解析；省略才读取全局默认，角色与权限独立。全量按父当轮实际文本历史窗口解析，不包含其他会话或后来的轮次；返回内容复制，1 MB 超限明确报错，不静默截断。

## 会话权限和思考强度（最新增量，优先于上文）

权限从所有 Agent 预设移除，agents.sqlite 升 v3，旧 v2 JSON 单独归档。会话新增 controls/revision，权限 manual（默认）/accept-edits/plan/readonly/auto/bypass，可在两轮之间修改并持久化；首轮只锁定 Agent 身份、指令和委派开关。Plan 给实际请求追加只规划约束，原始 Agent 指令快照不变。子代理权限同时受父轮和当前会话限制。

思考强度选择、保存及三协议请求参数已接入；model-default 继承模型设置，显式选择覆盖并清除固定预算。Anthropic 使用 adaptive + output_config.effort，none 关闭，不支持 minimal/ultra；其余模型兼容性由服务明确返回。思考过程展示、真实工具及子代理执行仍待接入。新会话权限不会沿用上个会话的 bypass。UiSelect 双行选项在 D:/UI 先验收，再接入会话。需重启 Electron 加载新运行时。

## 工具、思考展示和会话创建快照（最新）

UiSelect 的 rich option 改为仅 base-select 分支使用的 VNode 组件，经典浏览器保持文本 option；开发模式编译不再触发旧式 HTML 子节点警告。新 UiActivity 在 D:/UI 完成 demo/文档与浅深键盘验收，再用于 UAH 思考、工具和子代理活动。

思考强度与预算从模型页移除，存储旧字段兼容保留但运行时使用会话强度且清空固定预算；不再有 model-default。首次使用所有会话选择留空需手动确认（目录可选无目录）。新会话继承最近创建会话的 initialConfig，不继承后来修改的 requested/controls。旧无快照会话不会被猜测为新会话模板。

Runtime 已有三协议流式工具循环与实际子代理：read_file/list_directory/search_files/write_file/run_command、spawn_agent/wait_agents/list_agent_presets。父子运行同一 session，child 带 parentRunId/depth，主时间线不混入独立子轮。工具调用必须收到完整终止事件再执行。思考显示仅接口实际文本/摘要，原生签名及加密 reasoning 在工具轮间保留。文件权限/审批/冲突检查、子代理权限子集、全局并发/深度/超时、停止与恢复已接入。命令没有 OS 沙盒，auto 也需要审批，bypass 自动执行；只能可靠终止直接创建的命令进程，审批明确说明。MCP 与电脑操作未接入。重启 Electron 后才能加载新运行时。

## 子代理右侧两级视图（后续增量）

完整子代理内容从主时间线迁到工作面板的子代理标签，首级全会话列表，二级只读详情；主时间线提供查看入口。列表停止操作先打开可选理由弹窗，stop-run 新增可选 reason，RunRecord.stopReason 持久保存并由 wait_agents 返回。沿用 UI 库组件及布局工具类，无新增共享样式。重启 Electron 加载新的运行时契约。

## 默认 Agent 提示词与编排开关修复

排查发现本机默认助手指令为空，子代理总开关关闭，导致模型请求未携带编排工具。本机已通过 AgentStore 将总开关开启并保存默认提示词。代码新增默认中文提示词、新安装默认开启，以及 v4 归档迁移；既有自定义提示词和已保存关闭选择一般保留，本机开启是本次用户请求的配置修复。请求附加工具可用性与禁用原因说明，达到委派深度不再暴露下级工具。新提示词需新会话，已有锁定快照不修改。

## 并行与工具文档增量

启动子代理本来即为后台并行；旧 wait_agents 无界等待全部目标，现改为可选 timeoutMs（默认30000，范围0–60000，0立即查询），超时不取消子代理。系统运行说明要求主代理先做独立工作，在依赖结果时才同步。8个工具的说明和全部参数描述已详细化，含有效示例、返回语义与常见误用；docs/TOOLS.md 从实际定义导出。父轮结束前仍收拢其子任务；未实现工具等待中并发开启同一主代理的第二个模型请求。

## 对话富文本、平滑输出与工具 diff（本轮）

共享 UI 先实现并验收 UiMarkdown、UiDiff 和 UiActivity scrollable=false，再接入 UAH。主/子代理正文、用户消息与可折叠思考使用 CommonMark/GFM（表格、任务列表、脚注、定义列表、标记、上下标），公式用离线 KaTeX，图表用严格模式 Mermaid；安全语义 HTML 支持 details。链接经过宿主白名单校验再打开，图片仅网络地址。原始文本仍完整持久保存。

移植移动端 StreamingTextPacer：200ms突发缓冲、自适应显示速率和90/110/140ms发布间隔、结束200ms内追平、大积压/替换/后台长间隔立即同步，遵循减少动态效果设置。稳定段落/代码节点保留选择和滚动状态。ChatWorkspace ResizeObserver 跟随实际渲染高度，用户上滚或选中文字时不强制跟随。

RunActivity 增加可选 tool 元数据（名称/参数/结果/错误/精确 artifactId），兼容旧活动的有界格式解析。界面使用友好用法与纯文本结果，不显示参数 JSON。编辑审批显示提议 diff，完成后只用关联 artifact 的不可变快照；不按路径猜测或重读磁盘。侧栏快照复用 UiDiff，支持行号、统计、上下文、换行与完整内容复制。新增主进程 openExternal IPC 和工具元数据持久化逻辑，桌面端需重启；旧会话无精确关联时不会伪造历史 diff。

## 原型对齐、连续工具组与轮末操作（最新）

root直接依据原型src/app.js和styles.css实现UI-first修正：D:/UI先验收UiActivity inline、UiDiff compact/inspect、UiFileChanges、UiMessageActions，再接入UAH。连续tool/agent调用在无正文间隔时分组（中间思考保持原顺序）；默认折叠，待审批自动展开组和编辑项，展开状态按session/run/activity保留。编辑详情直接显示紧凑diff和在右栏查看，不重复打印File written和参数。轮末列表按同轮及递归子代理/重试祖先的真实快照聚合，同文件首old→末new，显示A/M及增删行数；无法统计明确显示未知。不读磁盘。旧工具无artifactId仅在明确run+规范路径+完整前后内容一致且唯一时关联。

五个轮末操作已真实接通：复制可见Markdown；edit-reply只设置history.editedOutput；delete-reply设置history.deleted，隐藏回复与工具、保留用户问题及不可变审计/文件快照；regenerate-run仅最新未删除root，原input+当前模型/权限+锁定Agent真实执行，retryOfRunId替代可见旧尝试；分支先创建草稿，首次发送create-session.branchFromRunId复制截止该回复的可见文本快照（1MB上限），不复制隐藏推理/工具私有状态。统一conversation-history帮助函数用于请求/委派/分支和可见轮次，编辑/删除/重试不撤销文件，终态finishedAt用于真实耗时、旧记录不猜。运行中禁止历史变更，异步解析后防竞态重验。需要重启Electron加载新契约。

桌面剪贴板使用可信renderer专用writeClipboard IPC（只写/200万字符上限），UI通过setClipboardWriter注入宿主适配，网页默认navigator.clipboard；不放宽浏览器权限。Electron44 clipboard API是Promise，必须await。

## 分支修复与真实 Plan 文件工作流（最新，优先于上文）

创建分支现在立即保存新会话、选中并展示继承的历史消息，不再等首次发送。branchAgent 固定源 Agent 快照，允许下一轮使用当前模型与会话设置；目录授权可继承已保存源会话，重启后也有效。分支不复制隐藏思考、工具或文件快照。整个会话发生过文件修改即隐藏并在运行时禁止重新生成，包含子代理、先改后恢复，以及已执行但无法确认文件副作用的命令。

Plan 已接入 enter_plan_mode/write_plan/read_plan/submit_plan。真实 UTF-8 Markdown 保存于应用数据目录 plans/<sessionId>/<runId>.md，对话卡片和右栏「计划」展示保存快照、路径、版本并可复制。普通正文或澄清问题不自动写文件或提交。提交后等待用户审阅；明确选择 Manual/Accept edits/Auto/Bypass 后创建独立实施轮，修改意见则创建 Plan 修订轮和新文件。旧版本保留，文件内容与哈希复查、最新轮校验和原子事务防止失效或重复审批。Manual 下计划批准后的文件编辑仍需逐次批准。

工具目录随每次模型请求的实际权限变化：Plan/Readonly 隐藏项目写入与命令，子代理没有计划审批工具且不能提升父权限。参考更正后的完整源码仓库独立适配，见 docs/PLAN-MODE.md；docs/TOOLS.md 已同步十二个实际工具的说明及 schema。复用已验收 UI，无共享组件改动。本轮契约和运行时变化须重启 Electron。

最终验证：180/180 单元，两仓 typecheck、生产构建通过；Plan、分支与轮末操作、工具/子代理、流式桌面专项通过。证据和视觉检查见 docs/VALIDATION.md，全部使用隔离本地模型 fixture，未调用用户服务。

## 默认 Agent 与 Markdown 指令编辑（最新）

保留旧 default，新增 claude-default/gpt-default/coding-general 三个可编辑且不绑定模型的主 Agent。Claude 采用独立撰写的工作流适配版：参考仓库 LICENSE 明确排除原始源码，未复制其专有系统提示词。GPT 使用固定版本 OpenAI Codex 公开默认基础指令，保留 Apache-2.0 原文/许可/通知并追加 UAH 工具、Plan 与权限适配，不是导出当前会话内部系统指令。通用 Coding 为原创提示词。来源、哈希、发行通知及边界见 docs/AGENT-PRESETS.md。

agents.sqlite v5 归档原 v4，按缺失 ID 追加预设，保留冲突/修改/禁用/顺序；删除后重启不复活。100项/1MB不足时只追加容得下的项，极限字节情况下保留原revision避免损失用户数据。现有会话锁定快照不变。Agent 编辑器复用既有 UI 组件增加 Markdown 编辑/预览，原文无损保存，主/子角色共用，无共享样式修改。

验证185/185单元、两仓typecheck、build、新增预设与Markdown桌面专项和原Agent15项回归通过。root已检查浅深/900px125%截图，证据见AGENT-PRESETS.md。需重启Electron加载迁移，未调用用户API。

## 用户 Claude 提示词、上下文钩子和 Agent 滚动（最新）

Claude 主提示词替换为用户所附Markdown，仅替换占位符；新claude-subagent-default组合共同基座与用户子代理角色。原文存claude-prompt-templates.ts，绑定存claude-harness-prompts.ts。agents.sqlite v6归档v5，仅升级精确匹配旧默认指令的主项，保留自定义/停用/已删除状态，按ID一次性新增子项。新会话生效，不改历史锁定快照。

用户明确要求保留目录、Git、记忆和MCP接入钩子：prompt-context.ts提供版本化标记与请求前渲染；runtime/prompt-context.ts是统一提供器。当前注入真实目录/模型/权限/工具目录，Git与记忆缺省未知、MCP/hooks未接入。以后接入这些功能必须同步提供器、提示词及测试，已写入AGENTS.md。动态状态不回写Agent，外部资料不成为新指令，具体任务仍来自user消息。

Agent页面不能滚动根因是UiScrollArea内部viewport未受高度约束，已使用既有height="100%"修复，无共享UI改动。192/192单元、typecheck/build、24角色长列表滚轮/键盘/末项编辑桌面、真实Claude子代理与Markdown桌面专项通过，证据见AGENT-PRESETS.md。需要重启Electron加载迁移和请求钩子。

## GPT portable 提示词与原生 Codex 理论基础（最新）

本轮按用户 docs/codex-cli-0.157.1-prompts 更新 GPT 默认 Agent，新增 gpt-subagent-default。gpt-prompt-templates.ts 无损编码四个portable模块；gpt-harness-prompts.ts绑定全部占位符，组合共同基座+恰好一个角色+运行时上下文。当前API适配不冒充原生CLI，也不绑定Astra或其他模型。提示词钩子复用Claude机制，runtime/prompt-context新增runId/parentRunId；AGENTS.md要求今后Git/记忆/MCP更新同时维护两品牌说明。

agents.sqlite v7仅更新精确旧GPT主指令，归档v6，保留自定义/删除/元数据/锁定历史；子项缺ID且容量允许时一次追加。默认子代理继承模型、不继续委派。现有MD编辑器无需改动。

先读docs/CODEX-RUNTIME.md再接原生Codex：原生默认自行组装model base/role/条件developer信息，不将portable或assembled重复塞入model_instructions_file。文档包含exec/app-server边界、JSONL/结果/生命周期、权限与审批、Plan、上下文继承及测试门槛；尚未接CLI/订阅。上游固定catalog blob已验证，35项包manifest匹配；verify-pack因基础第108行一个行尾空格差异返回1，两个角色逐字节匹配，原包未改。

验证198/198单元、两仓typecheck、build、9请求桌面主/子预设和MD专项通过，证据artifacts/gpt-*.log及agent-presets-lbCj0X/report.json。需重启Electron并新建会话加载新指令，不覆盖旧会话。

## 统一条件提示词、诊断与 kiro 真机验证（最新）

API Supervisor每次模型请求调用runtime/prompt-assembler.ts，使用同一availableTools列表选模块并发送schema，执行时继续后端复验。稳定顺序host→用户基座→真实角色→权限/工具/Plan/编排→可选Git记忆→环境工具状态。主/子角色按parentRunId选，inherit不再继承主角色身份。无工具不注入动作教程，Plan切换下一请求立即生效。skills/MCP未接入，不能靠文本启用。旧instructionsForMode/delegationRuntimeInstructions无条件拼接入口已移除。

shared/conditional-prompts.ts从用户原模板派生行为基座及角色模块，开头UAH_PROMPT_PROFILE:gpt/claude/coding/generic:v1只选风格。默认预设更新为该基座；agents.sqlite v8精确匹配六个v7旧默认升级，archive v7，无新增/复活/覆盖自定义。历史锁定指令不回写。Agent编辑页复用UI并补说明，配置32000/装配64000字符，超限明确拒绝。

prompt.assembled事件接入既有runtime.jsonl，仅记录runId/round/profile/模块ID版本条件长度，日志不含提示词、任务、路径、provider/model或key。网络trace与prompt事件目前独立requestId，按runId/round与时间查装配。AGENTS.md与docs/CONDITIONAL-PROMPTS.md记录未来扩展要求。

验证215/215单元，两仓typecheck、build，桌面9请求模拟（agent-presets-exN25I）通过。真实服务使用用户授权的已保存kiro：6模型13用例全部通过。GPT5.6 luna/terra/sol、Claude haiku4.5/sonnet4.6/opus4.8均实际读取随机nonce；GPT Sol及Claude Sonnet还通过编辑diff、write/read/submit plan、inherit child+wait回传。目录目前无gpt6sol，未冒称测试该服务未列出的型号。真实报告artifacts/kiro-prompts-2026-09-27T15-27-01-722Z与15-28-13-775Z。

手工复现：node scripts/test-kiro-prompts.mjs --list 或 --models=id1,id2 --workflow=id1。只有显式执行才发真实请求；只读访问APPDATA/uah-desktop/endpoints.sqlite，兼容legacy列，不迁移/修改用户端点。safeStorage使用原用户目录，密钥仅内存；连接限制loopback5580，fixtures和运行DB均隔离在artifacts。禁止命令并拒绝测试中任何普通审批，180秒deadline按run生命周期stop/shutdown。未调用原生Codex或改用户项目。

## 按任务维护计划、右栏正文与底部审批（2026-09-28，最新）

用户明确选择 Claude Code 风格的权限模式与审批流程；Plan 继续属于会话权限，不拆成独立协作模式。每个任务稳定 documentId/title，真实草稿 plans/<session>/<documentId>/draft.md，提交保存独立 <planId>.md 不可覆盖快照。write_plan 默认延续当前任务，newPlan=true 明确新建任务。旧按 runId.md 保存的计划兼容读取，首次修改沿用旧计划 ID 作为任务 ID；旧文件保留。

计划正文只在右侧「计划」页展示，含任务、版本、状态、复制与文件信息。生成草稿或提交新版本自动打开右栏，对话流保留简短查看入口。待审批时底部操作区替代普通输入框，提供批准并自动编辑（accept-edits）、批准并逐项审批（manual）、其他实施权限（auto/bypass）、指导 Agent 修订（Revise）及直接编辑 Markdown。批准／提交修订后普通输入框恢复；完整计划输入在模型历史保留，对话显示简短决定与反馈。

直接编辑在右栏提供标题、Markdown 与预览，保存递增版本及历史，不调用模型、不批准；编辑未结束时禁用审批避免批准旧正文。Revise 接受反馈后开启同任务的新 Plan 轮，传入当前标题、版本和正文，仍需再次提交审批。批准开启独立实施轮，保留当前上下文与锁定 Agent；没有原工具循环原地恢复或自动清空上下文。Manual 下后续编辑仍逐次审批。

当前任务由 activePlanRunId 识别，澄清轮不使审批失效；当前计划删除后不回退激活旧计划。编辑、开始运行、审批、控制修改之间重验历史与状态，审批复查快照及草稿内容/hash，拒绝磁盘漂移、过期身份、重复审批和重放。读计划工具在所有主代理权限模式可用，子代理不能写读提交主计划。

进入、手工离开、批准离开 Plan 保存不同 modeTransition；事件仅在首次后续模型请求注入 plan.transition，工具循环不重复。手工切走明确不构成批准；批准退出指明获准版本与当前权限；非 Plan 有 plan.reference。新模块与未来维护见 CONDITIONAL-PROMPTS.md、PLAN-MODE.md，工具文档已从实际定义同步。

组件盘点复用 UiCard/UiField/UiInput/UiTextarea/UiTabs/UiSelect/UiMarkdown/UiScrollArea，无新增业务 CSS。验收发现 Chromium selectedcontent 不更新同 value 的选项标签，先在 D:/UI 修复 UiSelect、真实动态 demo 与文档，完成视觉和交互验收后接入。两仓已有大量此前未提交改动，本轮未 commit/push。

验证：226/226 自动测试；最后增强标题传递断言后专项23/23；两仓 typecheck 与生产构建通过。Electron 完整流程 artifacts/plan-mode-h65cpl；root 检查浅深主题、1440px与900px/125%、右栏正文/编辑及底部审批。真实 kiro 的 gpt-5.6-sol、claude-sonnet-4.6 各20/20断言通过，最终报告分别 artifacts/kiro-prompts-2026-09-27T16-24-25-516Z、16-25-09-638Z。新复现参数 --plan-review=modelID。测试只修改隔离fixture，未操作用户项目。需重启 Electron 加载新契约和运行时；仅刷新网页不能加载运行时更新。

## 运行时修复、只读 Git 与上下文查看（2026-09-28，最新）

用户在对比 D:/ccl 与 Codex CLI 0.157.1 后授权开始修复，并明确 Git 先做只读。本轮修复三个已复现问题：失败/停止历史以宿主摘要保留原任务和已发生的文件效果；主代理普通结束前把未消费的子终态送回模型确认；Chat Agent 流缺少明确 stop 终态时不得报告成功。Plan 提交审批流程和16次模型循环上限保留，未实现自动重试或重放副作用。

Git 完整接通 main/preload/worker/Supervisor/model tools/renderer：目录授权复查；分支、HEAD、状态、已/未暂存diff、近期提交；每次模型请求重新采集有界Git快照；Plan/Readonly可用git_status/git_diff/git_log。禁止外部diff/textconv/filter/signature程序、子模块内部读取和隐式联网；partial clone明确拒绝。用户未要求的暂存/commit/切分支/worktree没有接入。详情及限制见GIT-CONTEXT.md，工具文档可用scripts/export-tool-docs.mjs重新生成。

三协议usage按请求快照接收并替换，不跨请求累计。上下文环优先显示服务input（包含缓存输入），未上报才用可见文本估算，容量未知保持未知。点击查看每轮最近一次请求的指令、环境/Git、tools schema、公开消息与工具续轮结果。隐藏推理、signature/encrypted与端点凭据不进入详情。独立request_contexts表保存有界内容，runtime.sqlite v1→v2事务迁移；输出事件仅携带摘要。编辑/删除历史或编辑计划原子删除会话旧详情，再清显示摘要，重启仍不恢复。

UI盘点和先行验收已完成：新增D:/UI UiUsageMeter及真实demo/文档；UAH仅组件组装，无业务CSS。首次截图揭示UiScrollArea外壳overflow:hidden被焦点操作意外滚动，先在库真实组合复现，改为overflow:clip让内部viewport独占滚动；root验收8张库截图后再构建UAH。共享全组件20项回归通过。另限定补font-src self/data，修正代码区域使用的内嵌字体被CSP拒绝，script/connect保持原限制。

最终验证：263/263自动测试；两仓typecheck和生产构建通过；Git/context真实Electron37条断言、4次本地SSE请求通过，artifacts/git-context-Eak2dU；HEAD/index字节不变、pageerror和consoleErrors空；root检查浅深1440/900与125%下Git、用量、展开/滚动/收起截图通过。Plan完整回归artifacts/plan-mode-0PFDSN通过（6请求），修正旧测试等待桥的竞态以明确等待指定轮次完成。全部使用隔离fixture，没有访问真实模型服务。详细证据见VALIDATION.md。

两仓此前已有大量未提交改动，均保留；本轮未commit/push。必须重启Electron加载新main/preload/runtime与数据库迁移，仅刷新页面不够。原生Codex、自动压缩、长期记忆、MCP等对比差距仍是后续范围。

## 2026-09-28 提交检查点（当前状态，以此节为准）

用户要求为当前状态留下 handoff，并分别提交 UI、UAH 的全部累计改动，提交信息详细记录范围与验证。此前各节的“未提交”仅描述对应历史阶段。本次在两个仓库现有 main 分支保存本地检查点，不推送远端。

配套 UI 已提交为 `cc8045d34bf4440171e1e0b519cbb1869e68dc47`，标题“feat(ui): 完善对话组件、上下文用量展示与共享交互并保存交接”，共57个文件，含真实组件、demo、测试与验收文档。UI 交接入口为 `D:/UI/HANDOFF.md`。UAH 本次基于 `722b9f7` 保存以下全部累计工作；自身最终提交号以 `git log -1` 为准。恢复时同时取此 UAH 检查点和上述 UI 版本，保持 `@lingyzh/ui` 的 `file:../UI` 引用与 Vue dedupe。

### 本次保存的能力

- 三协议 API（Chat Completions、Responses、Anthropic Messages）及流式工具续轮、取消、推理/用量解析；端点凭据加密存储、模型发现/手工配置、参数与能力编辑、脱敏诊断。
- 主/子 Agent 管理、预设与保留用户编辑的版本迁移；每请求按实际注册工具、角色、权限组装条件提示词和动态目录/Git上下文，保留历史锁定指令。公开 Codex 0.157.1 参考包、来源与许可一起保存，不代表原生 Codex 已接通。
- 工作区工具、审批、子代理编排、活动与文件变更展示、Markdown流式呈现、消息编辑/删除/分支/重生成约束；修复失败或中断后副作用丢失、父轮未消费子代理终态，以及缺少 finish_reason 的响应误判成功。
- 按任务维护真实 Plan 文档、不可变提交版本、右栏正文与编辑、底部批准/修订流程，后端复验身份、版本和内容哈希。
- 只读 Git 分支、状态、分区 diff、近期提交和模型工具；有限 IPC、目录授权、路径/大小边界，禁止外部 diff/textconv/过滤器等附带执行，不新增暂存、提交、切分支或 worktree 写操作。
- 请求上下文详情与用量展示：服务实报/本地估算/未知分开，每请求重新计算；有界请求快照独立持久化，历史或计划编辑后失效，隐藏推理与凭据不进入详情。
- 开发启动、IPC/外链/剪贴板适配、UI组件消费与测试；更新架构、工具、运行时比较、使用说明和验证记录。

### 验证与恢复

本轮实现完成后，UAH 自动测试263/263通过，两仓 typecheck 与生产构建通过；Git/context Electron 37条断言通过（`artifacts/git-context-Eak2dU`），Git HEAD/index保持不变，页面和控制台错误为空。Plan专项通过（`artifacts/plan-mode-0PFDSN`）。UI最新全组件20项回归通过（`ui-PHOT1i`），提交前重新执行单元测试14/14通过；root已验收用量、嵌套弹窗与UAH浅深主题/窄屏/125%截图。详细证据在两仓 VALIDATION 及专项文档；本次提交准备仅补文档、提交说明及清理两个UI测试的末尾空行，没有重新发真实模型请求。

在相邻 `D:/UI` 完成依赖安装及构建，再于 UAH 运行 `npm run build`、`npm start`（开发可用 `npm run dev`）。必须重启整个 Electron，加载 main/preload/runtime 与数据库迁移。新请求才有上下文详情；旧会话不会回写新预设指令，需要新建会话采用新默认预设。

`artifacts/`、构建产物、node_modules、运行数据库与凭据没有纳入提交；截图/本地日志路径是本机证据，异机可按已提交测试重跑。上游参考包保留原始内容；此前记录的 base 第108行尾空格验证差异仍保留为已知来源校验项，不以重新格式化掩盖。

### 后续范围和限制

原生 Codex CLI/订阅运行时、自动上下文压缩、长期记忆、MCP及Git写操作仍未实现。token分类为本地估算，未提供容量的模型显示未知。Git防护不构成对恶意并发修改 `.git/config` 的原子沙箱。构建仍有既有的大 chunk 提示。继续开发前先读对应能力文档、检查两个仓库实际状态，遵循组件盘点→UI库/demo/视觉验收→业务接入的顺序。

## 2026-09-29 npm 依赖迁移（最新）

UI 库已公开发布为 `@lingyzh/ui@0.1.0`。UAH 的 package.json 和 package-lock.json 固定使用该 npm 版本，已移除 `file:../UI` 链接；`npm run typecheck` 仅检查 UAH 自身。按本节及上文“UI 如何被 UAH 引用”的当前说明恢复：在 UAH 运行 `npm ci` 即可，不需要相邻 UI checkout。历史检查点中有关本地 Junction 和 `D:/UI` 的叙述仅用于解释当时状态，不再是安装步骤。共享 UI 修改仍遵循 UI 仓库开发、文档与视觉验收、发布新版本，再更新 UAH 的顺序。

本次用 Node 24.19.0 验证：`npm ci`、`npm run typecheck`、`npm test`（263/263）、`npm run build`、`npm run test:ui`（25 项，33 个文档路由）和 `npm run test:desktop`（8 项）通过。UI 测试更新了多弹窗场景的选择器、文档正文中的标题定位和异步剪贴板等待；Windows 检出 CRLF 时 GPT 模板单测统一换行符。证据目录与边界见 `docs/VALIDATION.md` 最新节。
