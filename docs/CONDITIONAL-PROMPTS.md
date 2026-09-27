# 条件提示词装配（API 运行时）

UAH 现在每次模型请求都用 `src/runtime/prompt-assembler.ts` 装配指令。适用于 Claude、GPT、通用 Coding 与自定义 Agent；不是切换品牌时另写一套工具系统。原生 Codex 尚未接入，仍按 [CODEX-RUNTIME.md](CODEX-RUNTIME.md) 的单一运行时权威边界处理。

## 配置与运行时分离

Agent 保存可编辑的专业要求、风格与工作方法。默认预设开头的 `<!-- UAH_PROMPT_PROFILE:gpt:v1 -->` 选择对应角色风格，支持 gpt / claude / coding / generic。只有字符串开头的已知 v1 标记生效；正文、文件、Git 或记忆里的同名标记不是选择器。移除标记即使用通用角色，不影响用户文字，也不授予权限。

共同基础由用户提供模板适配而来，原始模块继续原样保留：GPT 将宿主／工具／技能与插件条件说明移出常驻基座；Claude 将工具和运行时上下文章节移出。对应角色在每次请求时按真实 parentRunId 选择。因此 inherit 继承的是 Agent 风格及用户要求，不会把主代理身份复制给子运行。继承、preset、inline 都受相同宿主角色和权限规则约束。

装配顺序稳定：宿主规则 → 用户 Agent 指令 → 实际角色 → 当前权限 → 可用工具教学 → Plan → 委派 → 可选 Git/记忆资料 → 实时环境与工具目录。工具 schema 仍经协议专用字段传输，不混在文本中模拟工具。静态部分在前、变化状态在后，有利于前缀稳定；没有声称本轮已接入或测量服务端缓存。

## 条件与单一数据来源

`Supervisor.availableTools` 先产出本轮真实工具定义；装配器只依据同一列表的名称选择能力模块，然后把相同定义传给传输层。执行时继续重新校验当前目录／权限／工具与审批，不依赖提示词作为安全控制。

| 模块 | 注入条件 |
| --- | --- |
| host.contract / agent.instructions | 宿主规则固定；用户指令非空才加入 |
| role.primary / role.subagent | 无父运行／存在父运行，恰好一个 |
| session.permissions | 每次读取当前有效会话模式 |
| tools.contract / tools.none | 本轮有工具／没有工具 |
| workspace.read / edit / command | 对应工具实际在本轮目录中 |
| plan.enter | 提供 enter_plan_mode |
| plan.workflow | Plan 主运行且 write/read/submit 三种工具齐全 |
| plan.analysis | Plan 但无完整计划提交工作流（含子运行） |
| plan.reference | 非 Plan 主运行有 read_plan，可引用既有计划但不能借此批准 |
| plan.transition | 有尚未注入的真实模式转换事件且目标权限与本轮一致；进入、手工离开、批准实施分别说明 |
| delegation.spawn / presets / wait | 分别依据对应工具；等待与启动分开，不假定一同可用 |
| delegation.unavailable | 不能启动子任务时仅给简短约束，不常驻启动教程 |
| delegation.limits | 能启动且存在真实调度设置 |
| context.git / memory | 可信提供器返回了对应资料；未提供时不注入长占位文案 |
| workspace.git | 实际 tools 中存在 git_status、git_diff 或 git_log；只注入本地只读规则 |
| context.environment / tools | 每次请求的实际身份、目录、平台、模型、权限和工具快照 |

进入 Plan 后下一次工具循环立即重算全部条件；权限调整、模型能力、委派开关／深度变化也从实际运行状态与工具注册表取值。skills、MCP、连接器未接入，不生成对应操作教程。工具批次串行与后台子代理并行在不同模块明确说明。命令仍无 OS 沙箱，auto 仍需审批。

模式转换在会话保存 pendingModeTransition，开始运行时移入 RunRecord.modeTransition；工具进入 Plan 则在当前运行记录事件。agentLoop 根据事件 ID 仅向首次后续请求显式传入转换，后续工具请求不重复；装配器不会从已保存 run 自动重播事件。获准实施与手工切走分开：前者标明批准版本，后者明确不构成计划授权。重新进入 Plan 恢复规划约束，子代理不注入主运行转换。权限与审批仍由运行时强制执行。完整流程见 [PLAN-MODE.md](PLAN-MODE.md)。

每个模块有固定 ID、版本、触发原因和字符数。无随机时间或无关状态进入稳定基座。基座与原始会话指令不被装配器回写；字面自定义指令不被静默拆改，旧自定义中的工具说明可能仍保留，但不能覆盖随后真实宿主规则。角色本身始终由实际运行决定。

## 上下文边界与长度

目录／运行 ID／父运行 ID／权限／工具由 runtimePromptContext 提供。Git 在每次 API 模型请求前重新只读获取，再通过提供器注入有界快照；没有目录、非仓库、失败都明确表示，不能当作干净工作树。`workspace.git:v1` 仅在实际注册 git_status/git_diff/git_log 时启用。记忆仍保留限定入口，不能覆盖权威环境／工具字段。当前没有自动读取 AGENTS.md、加载记忆或 Git 网络请求；按需读取项目规则仍依赖真实文件工具。

状态用有界 JSON 表示，转义尖括号防止伪造区块，不递归展开标记；每个原始状态槽最多 6000 字符。配置仍为 32000 字符上限；完整请求指令扩至 64000 字符，以容纳合法用户配置和条件模块，超限明确报错而不悄悄截掉权限或角色。该上限是字符限制，不是 token 配额。

## 诊断与升级

沿用「模型与账号 → 打开日志目录」。搜索 `event=prompt.assembled`，按 `fields.runId` / `round`（从0计数）查看 profile、总字符、模块 included/reason/version/characters。日志只保存受控元数据，不存系统提示词正文、任务、目录、模型／provider标识或密钥。提示词装配事件有自己的 requestId，网络 trace 有独立诊断 ID，可结合时间排查；不能把两个 ID 当作同一请求链 ID。[诊断格式](DIAGNOSTICS.md)。

Agent 数据库 v8 原样归档 v7 文档，仅在 id、kind、旧默认指令精确一致时更新为条件基座。default、Claude/GPT 主子预设及 coding-general 都覆盖；不新增／复活项，不覆盖自定义文本、元数据、禁用或删除状态。按文档字节容量逐项升级；revision 增位超限则保留原文和 revision。已有会话锁定快照保持原样，只有后续请求的宿主规则按当前真实能力重新装配。新默认基座用于新会话。

界面复用现有 Agent 卡片、UiField、UiTextarea 和 Markdown 预览，更新说明文字区分预览与实际请求。无新共享组件、样式或依赖。

## 验证范围

自动测试覆盖配置迁移、主／子风格继承、所有权限模式、无工具模型、实际 manual→Plan 请求切换、工具和模块一致、审批拒绝零写入、历史原文不变、条件稳定顺序、恶意标记不递归、长度和日志脱敏。具体结果与真实 kiro 多模型测试证据见 [VALIDATION.md](VALIDATION.md) 的本轮记录。

对比样本（相同简化环境、readonly、未启用委派工具）：旧 GPT 静态预设 27743 字符，新装配含宿主状态约 16401；Claude 4723 → 3648。无工具时分别约16052和3299。字符变化不是 token 成本或模型质量测量；完整编排与 Plan 下会按需增加相应模块。
