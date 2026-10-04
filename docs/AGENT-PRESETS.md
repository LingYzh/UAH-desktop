# 默认 Agent 与 Markdown 指令

当前 Claude 使用用户提供的两份 Markdown 模板，GPT 使用用户提供的 Codex 0.157.1 portable 模块；下方最初的源码来源说明保留为历史记录，以文末各次升级记录为准。

## 组件盘点

本轮 root 已核对 D:/UI/src/ui/index.ts、UiTextarea、UiTabs/UiTabPanel、UiMarkdown API 及对应文档 demo。使用现有组件组装「编辑 / 预览」：编辑保持 Markdown 原文，预览按需渲染，沿用对话的链接处理。无需新增共享组件、业务 CSS 或编辑器依赖。完成后检查浅深主题、键盘切换、窄窗口和保存恢复。

## 预设来源与边界

- 保留旧「默认助手」与用户自定义内容，追加 Claude 默认 Agent、GPT 默认 Agent、通用 Coding Agent。全部为可编辑主 Agent，不绑定模型。
- Claude 采用独立撰写的工作流适配提示词。用户提供仓库的 LICENSE 明确排除 Claude Code 原始源码，故没有复制其大段专有提示词；不得标为官方原文。
- GPT 使用 OpenAI Codex 公开仓库的默认基础指令，固定版本 41f9084b30812db321a0b592def4f500d1e79cf4，路径 codex-rs/protocol/src/prompts/base_instructions/default.md。它不是当前 Codex 桌面会话的隐藏系统指令，也不是所有 GPT 模型的同一默认提示词。Apache-2.0 许可与通知保存在 third-party/codex；原文保存在该目录，运行时添加 UAH 环境适配说明。
- 通用 Coding 提示词独立编写，强调读代码、限定范围、实际实施、适当验证和如实汇报。

来源：[Claude 参考仓库许可证](https://github.com/noya21th/claude-source-leaked/blob/252d09142a7c0c183856cd4077ef9fe120e73a1f/LICENSE)、[Codex 默认基础指令](https://github.com/openai/codex/blob/41f9084b30812db321a0b592def4f500d1e79cf4/codex-rs/protocol/src/prompts/base_instructions/default.md)。

Codex 原文 SHA-256：`ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`。`src/shared/codex-default-prompt.ts` 仅将其编码成字符串以供浏览器与运行时共同打包，不修改原文；`src/shared/agent-presets.ts` 在其前后追加环境适配。没有执行远程源码，运行时不在线下载提示词。发行包须随附 third-party/codex 的 LICENSE 和 NOTICE。

## 保存与升级

Agent 数据库升级到 v5，将原 v4 JSON 归档到 agent_settings_legacy_v4，一次性追加缺失 ID。已有同 ID 配置保留原样，已有会话的锁定快照不变。用户修改、停用或删除预设后，重启不会重置或复活。普通升级 revision +1。

仍遵守 100 个配置和 1 MB 总文档上限，容量不足时仅追加可容纳的项，不挤掉用户数据，也不在重启时重试追加。精确达到字节上限且 revision 增位也会超限时，保留整个原配置及 revision，只归档并升级 schema；不会为新增预设阻止旧配置启动。

提示词编辑支持 Markdown 原文、字符计数、键盘切换编辑/预览、空预览提示和安全链接处理。主 Agent 与子代理角色都使用此编辑器。保存的是原字符串，渲染 HTML 不会进入系统提示词；只有编辑内容才触发未保存更改提醒。预览按需加载现有 UiMarkdown，未引入富文本编辑器或新的样式。

## 验证

- 185/185 单元通过，两仓类型检查、生产构建通过。
- artifacts/agent-presets-S7RKnI/report.json：三个默认预设的真实本地 SSE 请求含完整所选指令；Markdown 编辑/键盘切换/表格及代码渲染、脚本不执行、原文无损、重启恢复通过。
- root 检查上述目录 preview-light.png、preview-dark-narrow.png、editor-dark-narrow.png；900px/125% 下正文可滚动，固定标题与保存操作保持可用，无页面横向溢出。
- artifacts/agents-KfPB75/report.json：原 Agent/模型解耦、主 Agent 锁定、子代理上下文与权限、配置持久化等 15 项回归通过。更新两处过时测试预期以兼容已存在的运行时编排附加说明和 Plan 文案。
- 本轮所有模型请求仅访问隔离本地 fixture，未使用用户端点或密钥。需要重启 Electron 加载 v5 迁移与新默认值。

## 用户模板与动态上下文（最新）

来源为用户提供的 `claude-third-party-harness-system-prompt.md` 和 `claude-third-party-harness-subagent-role.md`。原文编码存于 `src/shared/claude-prompt-templates.ts`，`claude-harness-prompts.ts` 仅替换占位符：保留其余正文、标题和约定。主预设使用共同基座，新增 `claude-subagent-default` 使用共同基座加子代理角色，默认继承模型、不继续委派。没有从远程仓库复制 Claude 源码。

工具绑定根据真实契约：编辑/创建都用 write_file，创建时 expectedContent=null；查找目录用 list_directory，内容搜索用 search_files；子任务来自 spawn_agent.prompt，而非虚构的 task 参数。未提供的 glob/MCP/hook 能力如实说明。用户停止子代理和 Plan 审批继续由现有运行时处理。

数据库 v6 归档 v5，仅更新仍精确匹配旧 Claude 默认指令的主预设，不覆盖自定义指令及其余字段，不恢复已删除的主预设；按 ID 一次性追加子预设。100项/1MB容量和revision极限处理沿用v5保留数据策略。已有会话的锁定指令不变，新会话使用更新后的预设。

### 后续功能接入钩子

`src/shared/prompt-context.ts` 定义带版本的 `UAH_CONTEXT:<KEY>:v1` HTML 注释标记；保存的模板包含标记及未知/未接入说明，Markdown 预览不展示注释。`renderPromptContext` 每次只替换有值且带标记的区块，不修改模板、不递归处理注入数据。删除一对标记可将该区块改成完全静态文本。无标记的自定义 Agent 不受影响。

`src/runtime/prompt-context.ts` 是后续提供器接入口，Supervisor 每个模型工具循环都重新调用，主/子代理共用：

| 槽位 | 当前内容 | 后续接入要求 |
| --- | --- | --- |
| ENVIRONMENT_CONTEXT | 实际平台、目录或null、provider/model、权限、主/子角色及深度 | 目录切换等功能接入时从当轮权威状态取值 |
| GIT_STATUS_AND_TASK_CONTEXT | 每次请求前查询授权目录的只读 Git 快照；失败/非仓库/无目录明确显示 | 只采集当前目录树，截断有标记，分支与路径作为资料，不授予写权限 |
| MEMORY_CONTEXT | API 按次提供项目短索引和固定用户偏好；未提供时保留未知说明 | 正文按需检索，候选与确认区分，不能覆盖当前规则与用户要求 |
| DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS | 实际工具名，MCP/hooks明确未接入 | MCP 接入后对齐真实工具注册表及可用性，删除过时缺省说明 |

状态编码为 JSON 资料，转义尖括号避免资料伪造区块；不使文件名、记忆或外部工具文本成为新的指令。单槽原始 JSON 超过6000字符明确报错，提供器需要在来源处做有说明的有界快照。Git 提供器仅执行本地受限只读命令，不自动获取远端或读取项目文件正文；partial clone 为避免隐式联网明确拒绝。API 项目主规则由独立 project.rules 模块按作用域装配，其余文档按需读取；具体子任务保留在 user 消息，不复制到更高优先级指令中。旧品牌完整绑定的字节保留用于精确迁移，动态槽及条件模块在请求时提供真实能力，普通自定义指令不被回写。

项目 AGENTS.md 已记录维护规则：加入目录/Git/记忆/MCP能力时同步检查提供器、提示词说明和对应测试，避免日后遗漏。

### 滚动修复及验收

组件盘点确认 UiScrollArea 已有 height API 和真实demo，无通用能力缺口。AgentManager 的滚动根虽然受 flex 约束，内部 viewport 原先仍按内容撑高，因此被外层裁切；使用现有 height="100%" 约束内部视口，不新增业务CSS或改变共享UI。

旧构建复现滚轮无法改变scrollTop（artifacts/agent-scroll-before.log）；修复后的 artifacts/agent-scroll-x82AxP/report.json 覆盖24个附加预设下的滚轮、Ctrl+End/Control+Home、末项编辑、浅色1440px与深色900px/125%。root检查深色末项与组件滚动条显示通过。artifacts/agent-presets-B7TNvK/report.json 通过6次本地模型请求，包含真实启动Claude子代理、共同基座与角色指令、动态上下文与只读工具边界，以及Markdown保存/预览/重启。

192/192单元、两仓类型检查、生产构建通过。新增测试验证附件非占位正文无损、占位符全部绑定、动态状态每轮变化不回写、未来Git/记忆槽位及资料不递归注入。Plan存活子代理测试改为先观察父请求被拒绝再释放子响应，消除fixture重复写响应的竞态。所有模型请求均为隔离本地fixture，未使用用户密钥。

## GPT 分层预设与子代理（v7，最新）

root 已阅读 docs/codex-cli-0.157.1-prompts 的来源、四个portable模块、原始基座/角色及条件片段、占位符、例子、导出/渲染脚本、测试和适配diff。采用共同基座 + 一个主/子角色 + 运行时上下文，绑定真实UAH工具、串行工具批次/并行子运行、权限与Plan审批、结果返回机制。新增GPT默认子代理（gpt-subagent-default），默认启用、继承模型、不继续委派。GPT主预设保持不绑定模型。

实现位于 src/shared/gpt-prompt-templates.ts 与 gpt-harness-prompts.ts。生成器 node scripts/generate-gpt-prompts.mjs --check 可检验模板与用户资料包一致。动态提供器复用Claude钩子并新增runId/parentRunId，Git/记忆/MCP扩展仍须同步维护。主27743字符、子28692字符，均在32000字符配置限制内，真实请求已通过当前传输限制。

agents.sqlite v7归档原v6 JSON，只替换精确匹配旧GPT默认文本的主项instructions；自定义、名称、描述、禁用、删除及历史会话锁定快照不变。一次性追加缺失子预设，重启不复活删除项，100项/1MiB上限不足时保留用户数据。

组件盘点复用既有Agent列表、UiScrollArea、Markdown编辑/预览和子代理卡片，无组件缺口及新视觉样式。本轮未修改共享UI。桌面专项 artifacts/agent-presets-lbCj0X/report.json：9次隔离本地请求覆盖三种主预设、真实Claude/GPT子代理、父运行ID、角色互斥、只读工具边界、Markdown编辑/预览与重启保存。198/198单元、两仓typecheck、build通过；资料包18项测试通过。构建仅保留既有大chunk提示。

资料核验发现原始基础文档只差一处行尾空格，角色原文及35项manifest匹配，详见 [CODEX-RUNTIME.md](CODEX-RUNTIME.md)。该文同时记录未来原生Codex运行时的指令分层、进程桥、权限/Plan审批、上下文和验收边界。未调用用户端点、未启动原生CLI或付费请求。重启Electron后在新会话选用新默认值。

## 统一条件装配（v8，最新）

GPT、Claude、Coding与默认助手现在保存可编辑行为基座，真实主/子角色、权限、工具、Plan与委派说明按每次请求的实际能力注入。标记UAH_PROMPT_PROFILE只选择角色风格，不决定权限或实际模型；继承主Agent的子运行仍只注入子角色。用户资料中的标记不生效，用户自定义原文不拆改。

v8归档v7，仅精确匹配六个旧默认id/kind/instructions时升级基座；不新增项，不改元数据/禁用/删除状态，不改历史锁定快照。原品牌完整绑定文件保留作迁移来源，新能力维护在conditional-prompts.ts和prompt-assembler.ts。配置限32000字符，装配含动态模块限64000。编辑器文案说明预览与实际请求的区别，无新样式或组件。

详情与模块条件见 [CONDITIONAL-PROMPTS.md](CONDITIONAL-PROMPTS.md)。215项单元、两仓类型检查、build和9请求桌面模拟通过；本地kiro的6个模型13个真实用例通过，覆盖GPT/Claude真实子运行、计划文件和编辑diff。证据见VALIDATION.md。重启Electron并新建会话使用新基座。

## API 上下文 V2（2026-10-04）

默认动态能力现通过历史尾部快照按语义变化提供，不把 runId、采集时间和预算进度写回系统头、Agent 配置或历史指令快照。用户自定义动态槽继续按原行为渲染并记录兼容诊断；实际工具／权限仍由宿主强制。原生 harness 不使用这套 API 历史引擎。详见 [CONTEXT-ENGINE-V2.md](CONTEXT-ENGINE-V2.md)。
