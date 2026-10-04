# D09：原生 Codex 与扩展管理

最新追加交付：原生 Codex 已通过动态工具调用 UAH 的 API／原生子代理，内置 grilling 与 powershell-windows-cli。详见 [NATIVE-DELEGATION.md](NATIVE-DELEGATION.md)。本文「原生绑定体验迭代」的未桥接说明是前一检查点的历史记录，已由此次追加实现取代。

## 本次范围（2026-10-03）

用户已确认：原生后端先接 Codex，保留三协议 API；插件兼容 Claude Code 插件包与 marketplace，支持其中的 skills 和 MCP，其余组件明确显示支持状态；删除记忆、文件的禁用占位入口，保留实际文件工具、变更及计划面板。后续澄清使用 harness 自带提问工具。

经济型子代理只执行 root 已确定规格；Luna 不承担产品、架构或审美决策。root 负责接口、权限边界、UI 组装与视觉验收。

## 开工核验与组件盘点

- UAH HEAD `629196a`，UI HEAD `3f99b1a`，开工时两个工作区干净。
- UAH 固定 npm `@lingyzh/ui@0.2.1`，不复制 UI 源码。
- 已核对 UI 公开入口、UiDialog/UiCard API、docs/content.js 的真实表单、开关、标签页、滚动弹窗示例及 HANDOFF 中验收记录。
- MCP 管理复用 UiCard、UiField、UiInput、UiTextarea、UiSelect、UiSwitch、UiDialog、UiBadge、UiAlert、UiCodeBlock、UiScrollArea；插件/技能复用相同组件与 UiTabs/UiTabPanel；原生后端设置复用上述表单。
- 当前无通用组件缺口。沿用既有管理页面布局及 UI 工具类；发现缺口先回 UI 库处理，不在业务 CSS 绕过。

## 运行时边界

API 由 UAH 执行模型与工具循环，MCP 调用进入同一审批、日志、取消和副作用核对链路。服务端 annotations 不是用户授权；未知外部调用按有副作用处理。停用/修改后旧能力不可继续派发。

原生 Codex 使用 app-server 协议，原生运行时唯一控制模型和工具；UAH 只提交用户任务、映射原生事件、审批与生命周期。不得将 portable API 预设作为原生基础指令。原生未暴露的模型请求与内部动作标记覆盖不足，不伪造完整请求或文件快照。

插件安装不执行安装脚本、hooks 或任意入口代码。支持的技能/MCP 能力须实际接入才向模型声明；不支持的插件组件保留可见诊断。凭据不进入 renderer 读取结果、日志或提示词。技能目录与内容是受控外部材料，读取受边界和大小限制。

## 已交付功能

- 「模型与账号」新增原生 Codex 设置、版本/登录/模型检测、启停；检测可在启用前进行。聊天选择原生模型后固定 native-default，必须选择工作目录；流式文本、工具活动、原生审批、本轮真实 usage、停止、同配置线程 resume、历史编辑后的新线程上下文均已接通。
- 原生权限菜单使用三个原生预设：只读（read-only + never）、默认权限（workspace-write + on-request）、完全访问（danger-full-access + never）。Plan 从权限中移出，由 `/plan` 切换原生 collaborationMode；`/goal` 使用原生目标接口，详见 [NATIVE-CODEX-COMMANDS.md](NATIVE-CODEX-COMMANDS.md)。API 权限保持独立。
- 本机 Codex 配置及 MCP 由原生运行时管理；不再因有效配置含 MCP 而拒绝只读启动，也不静默禁用继承的 MCP。MCP 外部行为不属于文件沙箱保证。原生扩展配置在下一轮生效，立即中止需停止当前任务。
- 原生 thread/turn 身份持久化，可观察通知作为 native.event，公开文本可离线 replay；manifest 始终 partial，不伪造模型请求。原生 usage 使用 tokenUsage.last，缺字段为未知，不混作可逐请求核验的 API UsageRecord。没有原生历史文件快照时显示“未接入”，不会显示“本轮无文件改动”。禁止原生重新生成；异常、失联或重启遗留线程需要核对，不自动重放。退出以持有的子进程 close 信号确认，不按 PID/进程名终止。
- MCP 连接器增改删、启停、握手/工具数测试，支持 stdio 和 Streamable HTTP；使用固定 @modelcontextprotocol/sdk@1.32.0。认证范围已由用户确认：HTTP Token/请求头与 stdio 环境变量，OAuth 后续接入。
- API MCP 每次请求刷新真实能力，调用前再次检查版本、启用状态、参数 schema 与权限。默认逐次审批，显式 bypass 可跳过 UAH 审批；readonly/plan 不发布 MCP 工具。结果失败但已派发时保留 possible 副作用并阻止重放；尚未派发的验证失败为 not_started。服务端 annotations 不授予权限。
- 插件支持本地、HTTPS Git、GitHub owner/repo，以及 Claude Code marketplace 的受支持来源；列出 marketplace 项、安装、更新、启停、卸载。默认插件及导入 MCP 停用，技能默认启用但受所属插件开关约束。不支持的 hooks/commands/agents 等组件可见报告，不执行它们或安装脚本。
- 独立技能从含 SKILL.md 的本地目录安装、启停、卸载；API 提供实际 read_skill，原生提供启用技能的真实受控路径。受控副本拒绝目录逃逸、junction、symlink、硬链接；卸载只删除安装副本。
- SQLite 中连接器凭据使用 safeStorage 加密；renderer 列表只含 hasSecrets。目标变更必须替换或清除凭据，插件更新认证字段变更后重新禁用。已识别的 MCP env/headers 从受控安装副本清除，用户源目录保留。秘密跨原生文本 delta 和 MCP 并发刷新仍脱敏。
- 删除侧栏/搜索中的记忆、文件禁用占位及空的“更多功能”；实际文件工具、Git、变更、计划面板保留。

## 原生绑定体验迭代（2026-10-03）

- 打开配置自动扫描 Windows PATH、npm/Node.js/NVM 与常见安装目录；规范化去重并限制目录和结果数量。优先使用 codex.exe，备用方式为真实 node.exe + codex.js，不使用 Electron 可执行文件替代 Node，不执行 cmd/bat。新绑定填入基础参数，已有绑定保留；用户可切换候选、重新扫描或手动填写。
- 自动检测通过 app-server 的 model/list/account/read 获取目录及登录状态，不把 `/model` 发送为聊天任务。目录使用 model 字段作为请求 ID，遵循 isDefault 初始化新绑定；保留已有模型。启用配置在应用重载后重新获取全目录供聊天选择；失败时保留已保存模型。目录可能来自缓存，不代表账号权限实测。
- 检测草稿不保存、不启用、不创建线程或轮次。目录按启动路径与参数隔离；迟到结果不能覆盖更新后的配置或撤销停用。
- 「启动参数怎么写」弹窗说明 JSON 数组、Windows 路径、exe 与 Node 两种入口、自动追加 app-server --stdio，以及当前不支持的 CLI 选项。复用 UiDialog、UiCodeBlock、UiCard、UiField 等既有组件，无新公共能力缺口。
- 启用开关明确说明：提供聊天原生模型选择；关闭只阻止新原生轮次，不停止当前任务、不退出账号、不删除历史，不改变 API 端点。
- **当前原生 Codex 不能调用 UAH spawn_agent/wait_agents。** 原生子代理由 Codex 自身管理，是否可用取决于版本与配置。UAH 角色、路由、并发和预算只作用于 API 会话。界面和原生宿主说明均明确此边界；未注册 dynamicTools，item/tool/call 请求返回 -32601，不能绕入 UAH 子代理执行器。原生 collabAgentToolCall/subAgentActivity 仍作为原生活动记录，不创建伪造的 UAH 子任务。
- 上游 app-server 支持动态工具协议，受控跨运行时工具桥技术上可以另行实现；本次只核验并展示当前边界，没有新增桥接。协议参考：[app-server 文档](https://learn.chatgpt.com/docs/app-server)。

迭代验收：全量 822 项，820 通过、2 项既有 Windows symlink 权限跳过、零失败（artifacts/d09-iteration-tests.log）；typecheck、build、diff check 通过。原生协议 23/23、扫描 7/7、renderer 模型目录 3/3。修复 request-capture 测试随机分配到 fetch 禁用端口的问题，fixture 只接受高于 10080 的端口。Electron 专项 21 项、9 张截图，artifacts/extensions-desktop-PExS3g，页面错误为空。root 检查浅色1440与深色900/125%的配置、帮助和边界卡片，修正长路径候选挤压表单后复验；弹窗内部滚动、底部操作和帮助关闭后的焦点恢复通过。本机扫描找到3种启动方式并进行元数据探测，未发送真实模型任务。UI 仓库仍干净；未提交、推送或发布。

## 限额、存储与维护

MCP 最多发布 200 个工具，分页最多 10 页，单 schema 32 KiB、描述 2,000 字符，调用参数/结果 128 KiB。超限和不支持的媒体有明确诊断；截断的 MCP 输出暂不支持 range-read。远端只允许 HTTPS，本地回环可 HTTP，禁止跟随携带认证的重定向；Windows stdio 不使用 cmd/bat 启动器，可用 node.exe + 脚本路径。

新数据独立保存为应用目录的 extensions.sqlite、extensions/ 和 native-codex.json；不改 Agent 的历史指令快照。扩展更新先在受控 staging 校验，再事务替换。关闭原生或删除扩展不删除既有对话。回退旧代码前完整备份应用目录；旧版本不认识 native.event，不能用旧版清理新日志。既有 runtime DB 迁移路径不变。

已核对 prompt-context.ts、claude-harness-prompts.ts 和 gpt-harness-prompts.ts。旧完整品牌文件保持精确迁移来源原样；实际请求模块 host.contract v3 与 extensions.mcp v1、extensions.skills v2 根据注册结果装配。记忆仍未接入，不虚构能力。

本轮没有新增共享视觉能力、修改 UI 包或发布依赖；所有新增页面使用已验收的 @lingyzh/ui@0.2.1。原生事件与现有活动、日志、用量界面复用；大型时间线/高级看板继续是规划中按实际需求展开的后续项。

## 验收（2026-10-03）

- 全量 npm test：810 项，808 通过、2 项既有 Windows 文件 symlink 权限跳过、零失败，artifacts/d09-tests.log。核心收尾后定向 native/prompt 回归 16/16，artifacts/d09-final-focused.log。typecheck、生产 build 通过；保留既有大 chunk 警告。
- MCP SDK 专项 12/12；扩展存储与安全边界 13/13；原生协议+Supervisor 31/31；API 扩展循环 7/7。均使用本地 fixture，涵盖审批拒绝不派发、凭据变化、取消、schema 限制、原生断线/恢复/停止、线程切换、脱敏和 partial 导出。
- Electron 扩展专项 npm run test:extensions：13 项与 7 张截图，artifacts/extensions-desktop-fPoJsd；MCP HTTP 握手、插件状态、真实键盘切换技能、原生配置保存/检测、刷新后模型可选、原生中文聊天和本轮用量通过，pageerror 为空。
- root 检查浅色 1440、深色 900/125% 的列表、编辑器、插件、技能、原生设置与聊天截图；无横向溢出，滚动弹窗底部操作可达。发现的无可见标签开关、Vue Proxy structuredClone、重载未读取原生设置、原生文本/文件状态展示问题均已修正后重验。
- 既有 Electron 搜索 6 项（search-Yyxl0j）、端点 9 项（endpoints-pNjl2C）通过，保留三协议 API 入口和端点流程。
- 本机真实 Codex CLI 0.156.1 app-server --stdio probe 成功：登录状态有效、7 个模型、close 确认退出；artifacts/d09-native-probe.json。仅元数据握手，未发送真实模型请求；未做真实外部 MCP 服务或远端 Git clone 的集成验收。
- D:/UI 工作区保持干净。未提交、推送或发布。本次完成的是以上用户确认的 Codex 优先与扩展管理范围；OAuth、其他原生运行时和大型高级看板不冒充已交付。
