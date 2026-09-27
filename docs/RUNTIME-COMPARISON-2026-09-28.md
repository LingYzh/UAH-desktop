# UAH 工具层与 Agent 运行时对比评审

实施更新：三个已复现问题已修复，并接入用户选定的只读 Git、最近请求上下文与用量显示；范围见 [GIT-CONTEXT.md](GIT-CONTEXT.md)。下文保留调查时的对比状态，原生 Codex、自动压缩、MCP 等其余差距仍未接入。

评审日期：2026-09-28。范围为当前工作树的工具、模型请求循环、上下文、权限、子代理、取消恢复与持久化；本文是评审和实施建议，未修改生产代码。

**结论：UAH 已有真正可工作的 API agent harness。当前最大的差距是运行状态的连续性、执行环境和调度能力；继续扩充默认提示词无法补齐这些差距。** 优先修复失败轮副作用丢失、子代理结果未验收和 Chat 终止校验，再建设上下文预算、增量文件工具及受管理的命令会话。

## 1. 基线与证据范围

| 对象 | 本次实际基线 | 如何使用 |
| --- | --- | --- |
| UAH | `D:/UAH`，HEAD `722b9f7b9bcc4cd0d40be914cd3dc55c9f8383da`，main ahead 1，含大量未提交实现 | 审核实际工作树，不把 HEAD 或 HANDOFF 的历史段落当成全部现状 |
| UI | `D:/UI`，main ahead 1，含未提交修改 | 已检查状态和规则；本次无 UI 实现或视觉变更 |
| CCL | `D:/ccl`，HEAD `252d09142a7c0c183856cd4077ef9fe120e73a1f`，package 标注 Claude Code **2.1.88** 的还原研究源码 | 只将实际代码作为机制参考；不称其为官方最新版本，不认定所有 feature flag 已启用 |
| Codex CLI | **0.157.1**，`rust-v0.157.1`，commit `36650394c5b38c2990ccf2a3457165ca3e9d9726`，发布于 2026-09-26 01:02:31 UTC | 官方更新日志、GitHub latest release、npm latest 三处一致；按固定提交读取源码 |

Codex 版本来源：[官方更新日志](https://learn.chatgpt.com/docs/changelog)、[0.157.1 release](https://github.com/openai/codex/releases/tag/rust-v0.157.1)。检查时 PATH 未发现独立 `codex` 命令；没有安装、升级或运行真实 Codex 模型会话。Codex 对比属于固定版本源码及协议审阅，不是端到端运行验收。

CCL 的源码、分析文档和可用发行功能需要区分。其 LICENSE 明确将原始 Claude Code 源码排除在仓库分析材料的 MIT 授权之外。本次没有移植源码或复制其系统提示词。

## 2. 已有能力应保留

UAH 并非只有聊天接口，以下能力已经落在实现中：

- 三种协议的流式工具循环：Chat Completions、Responses、Anthropic Messages；同一轮工具循环内保留原生 continuation，包括协议需要的签名／加密 reasoning 载荷。
- 工具调用执行前校验参数、当轮实际工具目录和当前权限；Plan/Readonly 隐藏写入与命令，并在后端继续拒绝伪造调用。
- 文件路径边界、链接检查、审批后复验、完整旧内容冲突检查、同文件写入锁及不可变文件快照。
- 子代理真实后台运行、父子归属、深度／并发／超时限制、权限子集、停止传播；all/selected/none 上下文选择。
- 真实 Plan 文件、稳定任务身份、不可覆盖提交快照、版本／哈希校验、过期审批拒绝及独立实施轮。
- SQLite 事务、事件序列、重启时中断收尾；条件提示词使用实际 availableTools，而非静态假设。

证据入口：[Supervisor](D:/UAH/src/runtime/supervisor.ts:531)、[文件工具](D:/UAH/src/runtime/workspace-tools.ts:193)、[委派权限](D:/UAH/src/shared/delegation.ts:109)、[Plan 工具](D:/UAH/src/runtime/plan-tools.ts:1)、[条件装配](D:/UAH/src/runtime/prompt-assembler.ts:29)。

能力对照如下；参考列表示源码中核实到的机制，不表示所有开关或平台默认开放。

| 维度 | UAH 当前 | CCL 2.1.88 参考 | Codex 0.157.1 参考 |
| --- | --- | --- | --- |
| 工具调度 | 整批完整后串行执行 | isConcurrencySafe + 安全批次 | runtime 并行 opt-in + 共享／独占执行门 |
| 文件操作 | 字符切片、字面搜索、整文件替换 | Read/Edit/Glob/Grep、结构化 patch | apply_patch + 独立策略／执行管线 |
| 命令 | 单次非交互 PS5，直接进程取消 | 有条件的后台任务与输出／停止 | unified_exec、会话／stdin、PTY／exec-server 抽象 |
| 上下文 | 当轮 continuation，跨轮文本投影 | microcompact/autocompact、结果落盘 | 规范历史、token 估算／截断、compaction／rollout |
| 子代理协作 | spawn + 有界 wait-all | Agent；团队消息受实验及远程开关限制 | V2 mailbox/send/followup/interrupt；V2 默认关闭且有能力门槛 |
| 运行中追加输入 | 活动会话不能新开 run，无 steer | query 有较丰富任务／交互设施，本次未全面核验 steer | 活动 turn 校验后追加 pending input |
| 扩展 | Git/memory 槽位；MCP/hooks/skills 未接 | 实际 MCP、skills、工具前后 hooks | AGENTS 加载、skills discovery、按条件／预算暴露 MCP |
| 权限 | 产品模式、逐次审批、路径检查，无命令 OS 沙箱 | 工具策略 + 条件式 sandbox | tool orchestrator 分离 approval 与 sandbox attempts |

## 3. 当前主流程及断点

```text
用户输入 → 主进程 / utility process → Supervisor.startRun
    → 从已完成轮次重建 user/assistant 文本历史
    → 每次请求重新组装真实工具目录、权限、角色、动态上下文
    → 请求模型，接收正文／reasoning／工具调用
    → 等完整终止 → 串行执行本批工具 → appendToolResults
    → 再次请求模型（最多 16 次）
    → 无工具：等待直属子任务生命周期结束 → 父轮 completed

断点 A：continuation 只在这个 agentLoop 中，下一用户轮改用纯文本历史。
断点 B：failed/stopped 轮默认从下一请求历史中整体排除，磁盘副作用却保留。
断点 C：等待子任务退出不会自动把结果交给父模型再验收。
重启：非终态改 stopped，审批过期；恢复的是历史状态，不是原工具循环续跑。
```

证据：[模型循环](D:/UAH/src/runtime/supervisor.ts:662)、[历史投影](D:/UAH/src/shared/conversation-history.ts:20)、[重启收尾](D:/UAH/src/runtime/supervisor.ts:1210)。

## 4. 优先级总表

这里的优先级表示建议实施顺序；“确认”指本次源码核实或已复现，不表示全部都属于代码 bug。

| 编号 | 优先级 | 类型 | 建议及用户影响 |
| --- | --- | --- | --- |
| F01 | P1 | 已复现的状态缺口 | 保留失败／停止任务及已执行副作用，否则“继续”会失去关键事实 |
| F02 | P1 | 已复现的验收缺口 | 父代理完成前处理未消费的子任务结果，避免子失败而父输出未经修正 |
| F03 | P1 | 已复现的终止校验缺口 | Chat 文本响应缺 finish_reason 仍可 complete，需要一致终态规则 |
| F04 | P1 | 核心能力缺口 | 模型历史账本、token usage／预算与 compaction，支撑长任务和恢复 |
| F05 | P1 | 高频工具能力缺口 | 增量编辑、行号读取、Glob／Grep、结构化截断，减少整文件往返 |
| F06 | P1 | 执行环境缺口 | 命令会话、输出落盘、后台控制、可验证取消；随后接 OS 沙箱 |
| F07 | P2 | 工具架构与吞吐 | 统一注册表和有副作用约束的调度器，安全只读批次可并行 |
| F08 | P2 | 编排与交互 | steer／消息／followup／interrupt、wait-any／游标及可用模型发现 |
| F09 | P2 | 上下文与扩展 | 项目规则／Git → skills → MCP → hooks，按实际注册条件启用 |
| F10 | P2 | 故障恢复与诊断 | 结构化错误、安全阶段重试、统一 requestId 和 usage 指标 |
| F11 | P2 | 持久化规模 | 解除全局 500 run 阻塞，分页与归档；测量并减少逐 delta 全量写入 |
| F12 | 分支路线 | 原生运行时适配 | 独立 Codex adapter；明确由谁拥有工具、审批、历史和 Plan 状态 |

### F01：失败／停止后的副作用没有进入下一轮模型上下文

`conversationMessages` 默认只选 completed。`apiMessages` 没有开启 includeFailed；因此一次 write_file 成功后，下一次 API 请求失败，整轮原用户任务和已执行操作都不进入之后的请求。界面活动／artifact 和磁盘文件仍在。

本次离线复现结果：第一轮 failed、artifactCount=1、磁盘包含 `APPLIED_EFFECT_PROBE`；发送 `CONTINUE_PROBE` 后，模型可见非系统消息仅剩这一句。用户要求“继续”时模型缺少继续所需的事实。

**建议：**保存持久化的模型历史与副作用账本，独立生成 UI 投影和模型投影。对中断轮保留用户任务、停止原因、已完成操作及未确认副作用；不要直接把半截助手回答当成最终回答，也不要把未知命令副作用自动重放。编辑／删除／重试／分支仍需遵循现有用户可见历史语义。

**验收：**写成功→请求失败／用户停止→重启→继续；模型能看见中断点和已发生事实，已完成 write 不被自动重放。

证据：[历史过滤](D:/UAH/src/shared/conversation-history.ts:32)、[请求历史](D:/UAH/src/runtime/supervisor.ts:853)、[本次复现](D:/UAH/artifacts/runtime-comparison-2026-09-28/runtime-probes-results.json)。参考 Codex 将规范历史项持久化：[recorder.rs](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/rollout/src/recorder.rs#L1035)。这不意味着外部命令天然具有 exactly-once 保证。

### F02：生命周期收尾与父代理验收是两回事

当前无 toolCalls 时执行 waitForChildren 后直接 return。子运行失败会在自己的 streamRun 中转为 failed；它的 task Promise 正常收尾，父轮不会因此自动再次请求模型或修正最终答复。

本次复现：父模型 spawn 后直接回复最终文本，子请求 500；父轮 completed、子轮 failed、父模型请求总数仍为 2。提示词已有“必须读取并整合子结果”，但宿主没有跟踪结果是否已经被父模型消费。

**建议：**给委派记录增加结果版本／消费游标，区分“完成的执行”和“已纳入父判断的结果”。在准备结束时，若必要子任务有未消费的终态，投递紧凑结果／失败事件并允许父模型继续。不要简单规定任一子失败就让整个父任务失败：探索性子任务失败后，父代理仍可自行完成，但必须有机会作这个判断。

**验收：**子成功、失败、停止、审批挂起和晚到结果；父不重复读旧结果，不对未验收的必要子任务宣称完成。

证据：[结束分支](D:/UAH/src/runtime/supervisor.ts:694)、[等待实现](D:/UAH/src/runtime/supervisor.ts:748)、[本次复现](D:/UAH/artifacts/runtime-comparison-2026-09-28/runtime-probes.ts)。

### F03：Chat 文本流缺少 finish_reason 仍被视为完整

`[DONE]` 分支会检查工具终止原因，却没有要求无工具文本响应的 `chatFinish` 为 stop。仅提供 `content: partial` 后发送 `[DONE]`，生产 streamAgentApi 返回 complete。

**建议：**分别验证“流终止”“协议响应完整”“任务完成”。默认要求合法结束原因；如果确需兼容某个会省略 finish_reason 的端点，应采用显式能力／兼容策略，并保留不确定终态，不能静默适用于所有端点。

本次对照样例中，Responses 的 completed 搭配 incomplete/failed/in_progress 均被拒绝，Anthropic 缺 stop_reason 也被拒绝。没有发现这两个分支同样误接受；纯 reasoning 而无最终文本是否可接受属于另一个产品策略，本文不判为 bug。该 Chat 样例没有工具调用，不扩大成“可提前执行不完整工具”。

证据：[Chat 校验](D:/UAH/src/runtime/api-transport.ts:994)、[8 个离线协议样例](D:/UAH/artifacts/runtime-comparison-2026-09-28/transport-probes/results.json)。

### F04：完整历史、token 预算与压缩需要一起设计

同一工具循环里的 continuation 保留正确，但离开 agentLoop 后只剩 user/assistant 文本用于后续模型请求。活动记录是 UI／审计资料，不是可回放的协议历史。工具调用关系、工具结果和原生 reasoning 载荷没有跨轮延续。

与此同时，当前主要限制是 historyTurns、1 MB 历史／原生历史大小、64k 装配字符和 16 次模型循环。已发现的 contextWindow 没有参与请求预算；stream 事件不携 usage。多个大 read 或 wait_agents 结果可能先耗尽模型窗口或本地字节限制，无法先整理上下文。

CCL 的 query 会调用 microcompact、autocompact，以及有条件启用的工具结果总预算；Codex 对规范历史中的工具输出截断、估算 token、修复 call/output 配对，并有压缩检查点。应学习这些分层机制，不能假设 CCL 每一种压缩开关默认生效。

**建议顺序：**

1. 定义持久化消息／工具事件及原生协议载荷隔离，明确不同 provider 切换时如何重新投影；签名载荷只供对应运行时使用，不进入用户可见编辑或跨后端直接复用。
2. 接入 input/output/cache usage 与模型窗口预算，预留输出和工具结果空间。缺元数据时使用明确保守上限。
3. 大工具结果落盘，模型获得摘要、truncated/hasMore、可继续读取的句柄；模型上下文裁剪不删除审计证据。
4. 预算临界时压缩，保留用户要求、项目规则、已批准计划、未完成目标、已修改文件和待处理子任务；加入摘要质量与失败熔断检查。
5. 16 次固定循环改为可配置 step／token／时间预算和无进展检测，达到预算时保存可继续的检查点。不要直接取消所有上限。

**验收：**低窗口模型、多份大文件、Unicode 大输出、连续工具失败、反复短 wait；压缩后计划和权限不漂移，call/result 不孤立。

证据：[循环局部历史](D:/UAH/src/runtime/supervisor.ts:663)、[stream 事件](D:/UAH/src/shared/tool-protocol.ts:19)、[CCL query](D:/ccl/src/query.ts:369)、[CCL 阈值](D:/ccl/src/services/compact/autoCompact.ts:30)、[Codex 历史预算](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/context_manager/history.rs#L400)、[Codex compaction](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/compact.rs#L388)。

### F05：文件工具应覆盖实际仓库操作

当前 read_file 按 UTF-16 字符切片，无结果截断标记；write_file 要把完整旧内容和完整新内容都放进调用参数。改一个函数也需要重复传输整个文件。search_files 是区分大小写的字面搜索，有 500 项、8 MiB、100 个命中、深度 6 的限制，不识别 .gitignore，也没有文件 glob／正则／分页。

在依赖目录较大的项目中，从根目录搜索容易把预算耗在无关文件。Plan/Readonly 又禁止 run_command，模型没有可用的 rg 补救路径。现有上限应保留为资源边界，但导航能力需要补齐。

**建议：**先新增行号 read、glob_files、grep_files、apply_patch 或精确 edit_file。结果统一提供 path/range/truncated/nextCursor；搜索支持 include/exclude、ignore 规则和输出模式。增量编辑仍复用既有审批、路径检查、写锁、内容冲突校验和 artifact，不另造权限旁路。创建目录／删除／移动分别定义权限与快照语义。

参考 CCL 的 Read/Edit/Glob/Grep；Edit 会检查读取状态与内容变化后生成 patch。Codex 有独立 apply_patch handler 和审批执行路径。Codex 的换行保持及流式 diff 各自受 feature 控制，不直接假设其默认行为符合 UAH。

**验收：**有大型 node_modules 的仓库、同名文件、长行／CRLF／BOM、分段读取、重复匹配、并发编辑冲突；确认 Plan 下可完成高效只读调查。

证据：[UAH 工具 schema](D:/UAH/src/runtime/workspace-tools.ts:50)、[UAH 搜索](D:/UAH/src/runtime/workspace-tools.ts:247)、[CCL Edit](D:/ccl/src/tools/FileEditTool/FileEditTool.ts:453)、[CCL Grep](D:/ccl/src/tools/GrepTool/GrepTool.ts:33)、[Codex apply_patch](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/handlers/apply_patch.rs#L63)。

### F06：命令需要独立执行服务

UAH 目前通过隐藏、非交互的 Windows PowerShell 5.1 执行，stdin 关闭；默认 30 秒、最多 120 秒；stdout/stderr 合并，超出 64 KiB 会尝试停止直接 shell。它适合短命令，尚不能支撑长期 dev server、交互 CLI、持续构建日志和可靠的任务级进程管理。源码和审批已诚实提示没有 OS 沙箱，auto 仍需命令审批；这不是隐藏的 sandbox 承诺。

CCL 的 Bash 支持后台任务与结果／停止工具。Codex unified_exec 有会话身份、yield、write_stdin、PTY／exec-server 抽象和管理句柄，但暴露的工具和平台模式有条件，不等于每个 Windows 环境都可立即使用全部能力。

**建议先做生命周期，再做权限增强：**

- ExecSession 服务维护所有权、实例身份、启动／退出握手、stdout/stderr、输出游标和持久日志；达到模型输出上限只裁剪返回值，避免因此杀掉仍有效的构建。
- 分离等待时长、命令 deadline 和后台寿命；加入 poll/stdin/interrupt/terminate，后台身份不只是一枚 OS PID。
- Windows 通过经验证的 native helper／Job Object／ConPTY 方案管理需要的进程组；取消后验证实际退出，无法确认时保留“不确定”状态。遵守本项目禁止仅按 PID／进程名／WMI 终止服务的规则。
- 明确 shell 和编码协商；PS5、PS7、原生命令不能统一按一种 UTF-8 假设解码。
- 在此基础上接文件系统／网络／进程权限边界。审批和沙箱是两个维度；保留用户已选择的 Claude 风格会话权限模式，通过后端能力映射执行。

**验收：**大输出构建仍能完成、长运行可轮询、中文输出可读、停止不影响其他服务、无控制台程序拒绝／转到有控制台环境；各平台能力失败时明确不可用。

证据：[UAH 命令生命周期](D:/UAH/src/runtime/workspace-tools.ts:165)、[Codex exec_command](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L418)、[write_stdin](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs#L83)、[进程控制](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/unified_exec/process.rs#L231)。

### F07：从分散工具函数升级为能力注册表与调度器

ToolDefinition 目前只有 name/description/parameters。可用性在 Supervisor 组合，参数校验、权限和执行分别散落在 workspace／plan／delegation；工具批次整个串行。当前 12 个工具可维护，但扩展 MCP 或更多宿主工具后，容易出现目录、文档、权限与执行分支不同步。

CCL Tool 接口包含 isReadOnly/isConcurrencySafe、输入校验、权限和输出上限；StreamingToolExecutor 只并行安全工具，其他工具独占，结果按接收顺序产出。

Codex 同样采用显式 opt-in：支持并行的 runtime 获得共享执行锁，其他工具获得独占锁，默认不支持并行。审批与 sandbox 由独立 orchestrator 决策。不能把“支持 parallel_tool_calls”理解为所有工具都可并行，也不能假定上游会自动根据副作用推导全部策略。

**建议：**统一描述工具的 capability/source、输入／输出 schema、effect、资源锁、取消、超时、预算、审批与进度。运行流程统一为 validate→authorize→reserve/lock→execute→persist→deliver。先只并行独立 read/list/search，并稳定关联 callId；审批、Plan 切换和共享文件编辑保持有序。保留“完整终止后才能执行”的当前协议边界，不为模仿流式调度提前执行未验证的工具参数。

**验收：**并行读收益、读写依赖、同文件竞争、取消并发批次、审批期间其他只读工具，以及结果顺序和 callId 一致性。

证据：[UAH ToolDefinition](D:/UAH/src/shared/tool-protocol.ts:1)、[批次串行](D:/UAH/src/runtime/supervisor.ts:702)、[CCL Tool](D:/ccl/src/Tool.ts:402)、[CCL 调度](D:/ccl/src/services/tools/StreamingToolExecutor.ts:36)、[Codex 并发门](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/parallel.rs#L183)、[Codex 审批／sandbox](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/orchestrator.rs#L149)。

### F08：子代理可复用性、运行中输入及动态能力发现不足

UAH 只有 spawn_agent/list_agent_presets/wait_agents。wait 是全部目标结束或超时；没有 wait-any、游标去重、结果通知、send_message、followup 或模型可调用的 interrupt。父任务每次修订只能再 spawn，新任务不能向正在运行的子代理传入纠正。startRun 会拒绝同会话已有活动运行，亦没有独立 steer／队列入口。

`list_agent_presets` 返回完整角色指令，但明确不是可用端点／模型目录。父代理可以指定 modelId，却缺少正式的 discover_models 能力，难以自主做可靠路由。

**建议：**区分可持续的 Agent/Task 身份与一次 Run。建立有界 inbox/outbox、消息来源／授权、deliveryId、结果游标和资源归属；用户 steer 在安全边界进入下一次请求，不并发启动同一轮第二个模型请求。增加 wait-any 或状态变化唤醒、followup/interrupt 以及受权限约束的模型能力目录。worktree 隔离随后按任务冲突需要增加。

另有一个明确的描述偏差：装配提示词称并发上限是“每个父运行”，实际执行按整个 Supervisor 的活动子运行计数。应先让文案和实际约束一致。

Codex V2 区分 QueueOnly 的 send_message 与 TriggerTurn 的 followup_task；wait 由 mailbox／steer 活动唤醒，不是等待一组 child 全部结束。子终态会给父队列发送结果，但 `trigger_turn=false`，不能声称 Codex 因而保证父模型自动验收。V2 在此版 feature 表为 Stable、**default_enabled=false**，还受 provider namespace/model 等能力约束。CCL 外部构建的团队功能也需要实验选项并通过远程开关。

证据：[wait 与 spawn](D:/UAH/src/runtime/supervisor.ts:762)、[全局计数](D:/UAH/src/runtime/supervisor.ts:806)、[工具目录](D:/UAH/src/runtime/delegation-tools.ts:3)、[提示词限制](D:/UAH/src/runtime/prompt-assembler.ts:92)、[CCL 团队门槛](D:/ccl/src/utils/agentSwarmsEnabled.ts:18)、[Codex steer 校验](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn_input.rs#L624)、[V2 消息模式](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L42)、[完成通知](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/agent/control/completion.rs#L88)、[V2 默认开关](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/features/src/lib.rs#L1323)。

### F09：项目规则与扩展能力应分阶段补齐

runtimePromptContext 目前提供实际目录／模型／角色／权限／工具，Git 和 memory 槽位未填，MCP/hooks 明确未接入。AGENTS.md 按需读取，没有自动项目规则加载或 skills 发现。提示词诚实反映能力，这是应保留的设计；缺口在宿主提供器。

**建议顺序：**

1. ProjectContext：项目根、按目录作用域加载的 AGENTS.md、Git 分支／脏状态摘要；保留来源、版本和大小预算，不把普通文件内容升级成系统权限。
2. SkillCatalog：先注入名称／描述／位置，触发后读取正文，跟踪显式调用和适用范围；不一次塞入所有技能。
3. MCP：连接状态、能力握手、工具命名／schema、审批、超时取消、资源和鉴权更新；外部工具执行仍走统一注册表与策略。
4. Hooks：定义少量 pre/post tool、turn end、pre/post compact 事件，限制超时／递归／权限。持久记忆需要单独定义写入、作用域和纠错策略，优先级低于可靠历史。

Codex 的项目规则加载、skills discovery 和 MCP exposure 是实际模块；MCP 可以按预算／搜索模式决定暴露方式。不要把“写一段提示词”当作这些能力接入。

每次接入必须同步维护 prompt-context、条件模块、GPT/Claude 宿主说明及切换测试，继续保留原始用户 Agent 编辑和锁定快照；旧默认文本迁移来源不应被改坏。

证据：[UAH 提供器](D:/UAH/src/runtime/prompt-context.ts:4)、[按需规则说明](D:/UAH/src/runtime/prompt-assembler.ts:66)、[Codex 项目规则](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/agents_md.rs#L58)、[skills](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/ext/skills/src/loader/discovery.rs#L56)、[MCP exposure](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/mcp_tool_exposure.rs#L37)。

CCL 的实际接入证据：[MCP client](D:/ccl/src/services/mcp/client.ts:1765)、[skills loader](D:/ccl/src/skills/loadSkillsDir.ts:407)、[工具前 hook](D:/ccl/src/services/tools/toolExecution.ts:800)、[工具后 hook](D:/ccl/src/services/tools/toolExecution.ts:1483)。

### F10：错误、重试和诊断需要一个请求身份

当前单次 HTTP 429、暂态 5xx 或连接失败会结束轮次；未见 Retry-After／有界 backoff。transport 有安全错误 reason，但 supervisor 重新构造 Error 后只持久化文案；输出长度、过滤、上下文耗尽等终止原因无法供调度稳定判断。网络诊断 requestId 与 prompt.assembled 的 requestId 独立，并发父子请求只能靠时间猜关联。

**建议：**统一 sessionId/runId/turnId/requestId/attempt/toolCallId；保留安全的 error.category、providerReason、retryable、outcomeKnown。仅在确认安全的请求阶段重试；一旦工具已执行或响应已部分消费，不重放整个任务。新增 usage／缓存命中／首 token 延迟／工具时长／审批等待时长，日志继续脱敏。提示词已有稳定段在前的设计，缓存优化应在拿到 usage 数据后评估。

**验收：**429 后成功、Retry-After、读流中断、已写文件后的失败、取消重试等待、父子反序返回，以及同一次请求装配／网络／错误能一对一关联。

证据：[HTTP 请求](D:/UAH/src/runtime/api-transport.ts:1211)、[错误转译](D:/UAH/src/runtime/supervisor.ts:894)、[装配 ID](D:/UAH/src/runtime/diagnostics.ts:135)、[网络 ID](D:/UAH/src/runtime/diagnostics.ts:197)。

### F11：全局存储上限与流式写入值得单独整改

RuntimeStore 的 MAX_RUNS=500 是整库所有会话和子运行合计，而非每会话；到达后直接拒绝新 run。它能保护原型规模，但长期使用或大量子代理任务容易达到，现有命令没有相应的运行归档／分页治理路径。

每个文本 delta 都复制活动数组、保存完整 RunRecord 并写事务；reasoning 更新还会携带整个 run-state 事件。SQLite 使用同步 FULL。随着正文／活动增大可能出现序列化与磁盘成本，但本次没有性能基准，不能把这一点称为已证明的卡顿原因。

**建议：**先定义保留／归档／分页策略，替代仅靠全局拒绝；再压测多子代理流式输出。采用增量事件和适度合并的物化快照，但审批、写入副作用、终态必须可靠 flush。不得为降低写入频率牺牲操作审计。

证据：[全局上限](D:/UAH/src/runtime/store.ts:16)、[COUNT 检查](D:/UAH/src/runtime/store.ts:62)、[逐 delta 写入](D:/UAH/src/runtime/supervisor.ts:900)、[活动更新](D:/UAH/src/runtime/supervisor.ts:521)。

### F12：原生 Codex 应成为独立适配路线

现有 API Engine 和原生 Codex 都能拥有模型循环、工具、审批和历史，不能对同一调用各执行一次。继续沿用 CODEX-RUNTIME.md 的单一所有者原则。

若目标是快速获得 Codex 原生能力，可先做隔离 adapter 试验；若目标是让任意 OpenAI／Anthropic 兼容 API 都共享 UAH 行为，F01–F11 的自有引擎建设仍然必要。两者可以并存。

建议边界：

```text
UAH 会话 / UI / 产品权限 / 统一事件
                │
        RuntimeAdapter 能力协商
          ┌─────┴─────────┐
    ApiAgentEngine     CodexAdapter
    UAH 工具循环       原生 thread / turn / item
    UAH 工具执行       原生工具与审批执行
    UAH 历史账本       原生历史 + 映射关系
```

优先评估长期交互适合的 app-server 协议；exec 可作为批处理验证桥。官方协议要求初始化握手，提供 thread start/resume/fork、turn start/steer/interrupt 和审批事件，并区分 experimental capability；具体兼容范围必须固定版本实测。官方 2026-09-05 更新还将 app-server 标注为实验性集成，因此原型验证通过不等于生产支持承诺。[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)，[更新日志](https://learn.chatgpt.com/docs/changelog)。

保持用户已确定的 Plan 产品语义：Plan 仍是会话权限模式，批准的是具体计划版本，不因参考 Codex 而拆成另一套协作模式或自动清空上下文。原生能力无法映射时明确不支持，不静默提升权限。portable API 提示词不直接作为原生 Codex 的 model_instructions_file。

证据：[项目既有接入边界](D:/UAH/docs/CODEX-RUNTIME.md:69)。

## 5. 建议实施分组与验收门槛

| 阶段 | 范围 | 交付门槛 |
| --- | --- | --- |
| A：完成与中断可信 | F01–F03，加 F10 的稳定错误类型与统一请求 ID | 本次复现改成正式回归；写入后失败仍可继续；父能处理必要子结果；协议不完整不冒充成功 |
| B：长任务与高效代码操作 | 历史账本／usage／预算、F05、命令日志和受管理会话 | 大仓库读改测可完成；大输出不杀构建；中断不重复操作；达到预算有明确继续点 |
| C：可扩展调度 | 注册表、受限并行、消息／followup／steer、项目上下文；存储分页归档 | 并发不越权、不乱序；运行中纠正可送达；500 run 不成为永久堵点 |
| D：按产品需要扩展 | skills/MCP/hooks、沙箱深化、Codex adapter、worktree | 能力握手、权限映射、生命周期和故障矩阵均有端到端证据 |

不建议一次重写 Supervisor。先提取 ContextManager/RunJournal、ToolRegistry/ToolScheduler、ExecService、AgentCoordinator；保留 Supervisor 的宿主协调入口和现有 Plan／审批事务，逐项迁移回归。

新增 UI 状态（后台命令、上下文预算、消息投递等）时仍执行 UI-first：root 先盘点 D:/UI 导出、API、demo 和文档，缺口先在 UI 库完成视觉验收，再接 UAH。本次仅评审，没有开始这些实现。

## 6. 本次验证与复跑

- 当前工作树全量现有自动测试：**226/226 通过**。[日志](D:/UAH/artifacts/runtime-comparison-2026-09-28/unit-tests.log)
- 新增审计运行探针：2 个场景，调用真实 Supervisor；已复现父子结果收尾缺口和失败写入历史遗漏。[脚本](D:/UAH/artifacts/runtime-comparison-2026-09-28/runtime-probes.ts)、[结果](D:/UAH/artifacts/runtime-comparison-2026-09-28/runtime-probes-results.json)
- 协议探针：8 个输入样例，调用真实 streamAgentApi，含正常对照和错误终态。[脚本](D:/UAH/artifacts/runtime-comparison-2026-09-28/transport-probes/probe.mjs)、[结果](D:/UAH/artifacts/runtime-comparison-2026-09-28/transport-probes/results.json)
- 探针完全替换 fetch 为内存响应，无 socket／真实模型请求；数据仅写入本次 artifacts 子目录。现有测试使用隔离 fixture，其中命令专项会执行无害本地 PowerShell 命令。
- Root 已复跑全部新增探针。探针中的断言用于证明当前行为，不表示这些缺口已被修复。
- 下载的 59 份 Codex 源文件全部按固定提交 tree 中的 Git blob SHA 校验一致；报告本地链接也已检查目标与行号范围。[源码校验清单](D:/UAH/artifacts/runtime-comparison-2026-09-28/source-manifest.json)
- 本次未运行桌面视觉回归、生产构建、真实模型、Codex CLI 或 CCL 应用；这些不是本次结论的证据。

在 `D:/UAH` 复跑：

```powershell
node --import tsx --test tests/runtime/*.test.ts tests/main/*.test.ts tests/renderer/*.test.mjs
node --import tsx artifacts/runtime-comparison-2026-09-28/runtime-probes.ts
node --import tsx artifacts/runtime-comparison-2026-09-28/transport-probes/probe.mjs
```

审计缓存保存在 `D:/UAH/artifacts/runtime-comparison-2026-09-28`，该目录被 Git 忽略；如需分享报告及复现证据，需要一并携带此目录中的脚本与结果。源码链接固定到已核实 Codex 提交；本地 UAH/CCL 行号对应本次工作树，后续编辑后应重新定位。
