# UAH 桌面端运行时最终升级方案

日期：2026-10-01

版本：1.0

项目：D:/UAH；配套 UI 库：D:/UI

交付状态（2026-10-03）：D00–D08 已接入，包括会话尾部窗口、人工独立目标验收、原始捕获开关、孤立文件清理、永久会话删除、升级备份/迁移故障回滚及日志分片轮转。D09 已按用户确认范围交付 Codex app-server、MCP/插件/技能管理与原生可观察活动/日志，原生父任务还可通过 UAH 委派 API／原生 Codex 子代理，并内置 grilling 与 powershell-windows-cli；详见 `HARNESS-D09.md`、`NATIVE-DELEGATION.md`；OAuth、其他原生运行时、大型高级看板仍为后续可选范围。核心路径已有协议、Windows、离线及 Electron 验证，最新证据见 `HANDOFF.md`、`VALIDATION.md`。目标验收为 user_review；长期历史仍有启动扫描和全历史面板成本。真实 Provider 效率基准、提交和发布未执行，不把本地验收称为已发布或可选扩展全部完成。

本方案可以独立用于桌面端任务拆解、实现、迁移和验收，不要求先阅读 Android 方案，也不以 Android 开发完成为发布前提。两端只协调 TranscriptEvent、ToolOutcome、UsageRecord 等公共语义和黄金测试样本，各自保留技术栈、持久化实现及生命周期。

桌面端的升级主线是：补齐工具结果和 Windows 命令生命周期，建立基于 SQLite 的可靠执行记录与完整 transcript，再改善跨轮历史、长任务存储、上下文预算和有界并发。完整 transcript、基础用量和离线排查属于首批交付。

## 1 当前基线与需要保留的能力

### 1.1 核验结果

- UAH HEAD 为 `7fcce00`，分析时工作区干净；本文档不代表该提交已经包含新增能力。
- UI HEAD 为 `3f99b1a`，分析时工作区干净。UAH 实际固定依赖 `@lingyzh/ui@0.1.0`，不能假设 UI checkout 的新能力已经进入产品。
- 已重新运行协议、请求上下文、中断历史、回复历史、工作区工具五组测试，共 52 项通过。
- 没有重新运行完整 Electron UI、Windows 进程树故障测试、性能基准或真实模型测试；输入文档中的历史测试数量不是本次结果。

已执行的验证命令：

```powershell
node --import tsx --test tests/runtime/api-tool-transport.test.ts tests/runtime/request-context.test.ts tests/runtime/interrupted-history.test.ts tests/runtime/reply-history.test.ts tests/runtime/workspace-tools.test.ts
```

### 1.2 保留项

保留 Electron 隔离、utility process 运行时、Supervisor、三协议 API、条件提示词装配、只读 Git、主子 Agent 配置和异步委派。

以下行为作为升级回归不变量：

- Plan 仍属于现有会话权限机制；草稿、不可变提交版本、批准版本和实施期审批边界保持。
- 审批身份及策略版本校验、审批后重新核对路径与内容、子代理权限不扩大。
- 文件 expectedContent、同路径写锁、链接边界和已发生文件变更快照。
- 重启停止未完成运行，旧审批失效，不自动重放未知副作用。
- 用户自定义 Agent 指令与历史锁定快照不被运行时升级覆盖。
- 显示回复编辑与原始模型输出分离；删除/分支/重新生成保持明确的上下文截止点。
- 已通过测试的协议终态、工具关联和同轮原生块续接逻辑。

### 1.3 源码确认的缺口

| 当前行为 | 影响 | 对应工作 |
|---|---|---|
| continuation 是 agentLoop 局部变量，跨用户轮次主要恢复正文 | 工具证据和原生上下文不能完整延续 | 持久模型历史与兼容投影 |
| 请求查看快照在最终协议编码前捕获，按 run 覆盖且过滤内容 | 无法作为逐请求精确记录和用量账本 | 最终请求快照与统一请求身份 |
| 工具结果主要是 content/isError | 无法可靠表示写入成功但记录失败、未知副作用 | ToolOutcome |
| 命令取消直接进程，预览超过 64 KiB 会终止 | 长构建和后代进程生命周期不适配 | ExecutionBackend 与日志分页 |
| 逐 delta 写累计 Run，状态事件可能携带完整 Run | 存在写放大与复制开销，幅度待测 | 增量事件与低频快照 |
| 全局 MAX_RUNS=500，快照全量加载与验证 artifacts | 长期使用及历史规模受限 | 分页、归档、配额和按访问校验 |
| 上下文占用展示尚非请求准入，循环固定 16 次 | 长任务缺预算和自动治理 | ContextGovernor 与任务树预算 |

## 2 桌面架构决策

保持现有进程边界，先在 Supervisor 内抽出接口与纯函数，再按职责拆模块，不一次性重写引擎。

| 模块 | 桌面职责 |
|---|---|
| RunCoordinator | 运行状态、取消、恢复、任务树与预算 |
| ModelGateway | 统一模型请求入口、身份、记录和准入 |
| ProviderAdapter | 最终协议编码、SSE、usage 与合法终态 |
| RuntimeStore 与 Journal | SQLite 事务权威、执行事实与 checkpoint |
| ArtifactStore | 大输出、请求块、附件与受限原生块 |
| TranscriptWriter 与 Reducers | JSONL、manifest、UI/历史/用量投影 |
| ContextGovernor | 活跃历史、容量估算、压缩与兼容性 |
| ToolScheduler 与 PolicyEngine | 工具目录、资源冲突、权限与审批 |
| ExecutionBackend | Windows 进程生命周期与真实执行证据 |

原生 Runtime 为后续可选后端。API run 由 UAH 控制模型与工具循环；原生 run 由对应 runtime 控制内循环，UAH 只映射身份、事件、审批与生命周期。接入时遵循 `docs/CODEX-RUNTIME.md`，并重新核验当时实际接口，不依赖本文判断外部接口稳定性。

## 3 身份与状态

引入以下稳定身份：sessionId；runId/parentRunId/rootRunId；turnId/stepId；requestId/attemptId；toolCallId/invocationId；executionId；approvalId；eventId/sessionSeq。

requestId 表示一个逻辑模型请求，重试创建新 attemptId；用户重新生成创建新请求。toolCallId 必须结合来源 attempt 解释，不能假设供应商 ID 全局唯一。执行命令使用 executionId，不与进程 PID 等同。

现有 run.sequence 保留给现有 IPC/UI；新增会话级 sessionSeq。每个根会话由一个写入序列分配者统一排序父子事件，不直接改变旧 sequence 的语义。eventId 在导出、导入、投影重建中保持不变。

运行状态覆盖 waiting_model、waiting_approval、waiting_resource、running_tools、stopping、suspended_budget、recording_failed、needs_reconciliation、completed、failed、cancelled。具体枚举与旧 RunState 的映射在 D00 冻结，先做兼容适配。

ToolOutcome 至少分开：

- status：succeeded / failed / denied / cancelled / running。
- effectState：not_started / possible / confirmed / reconciled。
- recordingState：durable / pending / failed。
- retryClass：safe / idempotent_with_key / reconcile_first / never。
- errorCode、exitCode、preview、artifactRefs、truncation、资源版本和时间证据。

取消不等于没有副作用。文件已写而快照记录失败时，明确表示已发生写入和记录失败，暂停后续依赖可靠记录的动作，不能只返回成功文字或要求模型自行理解。

引擎 completed 与用户目标的 verified 分开；验证结果记录工作区/文件版本、命令、退出码和产物。测试后又发生修改时，旧证据不继续证明当前版本已验证。

## 4 Windows 命令与文件执行

### 4.1 命令生命周期

建立 ExecutionBackend，提供 start、poll-output、wait、cancel，返回 executionId。短命令保留同步包装，长命令返回 running，后续按游标获取输出。

Windows 拟使用受控 helper 管理 Job Object 和进程句柄。先验证创建、纳管、子进程继承、异常退出、breakaway 和不可纳管路径，再宣称取消可控。纳管失败必须可见；不得靠进程名、临时 PID 或 WMI 查询替代已验证的归属关系。

现有 `native/UAH.NativeHelper` 仅是只读窗口观察，processGroups=false。可以复用构建工程，但新增执行协议及能力必须独立声明和测试，不能把观察接口直接当命令管理器。

stdout/stderr 原件写入 artifact，预览、模型上下文、磁盘配额与最长寿命分别限制。达到预览上限不终止健康构建；磁盘或时间硬限制触发明确的停止策略和结果状态。

记录 shell 类型/版本、cwd、参数和编码。区分重定向 stdio、真实控制台及未来 PTY；首期无法支持的交互程序明确拒绝或报告不支持，不能通过 PowerShell 管道伪装交互。PowerShell 使用明确路径和版本，脚本及批处理遵守项目编码约定。

Job Object 只负责生命周期，不能作为文件/网络沙箱。继续保留 UNSANDBOXED 与现有审批语义。停止验收检查受控后代的退出证据，不能仅看 UI 标记 stopped。

### 4.2 文件与结果

保留完整写入工具给小文件，新增带 baseHash 的 patch 或唯一片段编辑。处理 CRLF、编码、重复片段、外部修改和审批后漂移；失败不得静默留下部分成功。路径、链接和权限防护继续执行。

读取/搜索结果增加 contentHash、hasMore、nextCursor、scope、truncationReason；旧 UTF-16 offset 通过 schema 版本迁移，不静默改变。大结果外置后必须向模型提供可操作的 range read 方式。

## 5 完整 Transcript

### 5.1 必须记录的内容

新会话默认记录，不需要打开开发模式：

1. 用户输入、附件来源、消息修订和分支截止点。
2. 每个 attempt 的实际请求指令、消息顺序、工具 schema、参数及 adapter 版本。
3. Provider 应用层事件、正文、可见 reasoning 摘要、原生块、工具批次、终态和部分响应。
4. 工具校验、审批、排队、dispatch、执行结果、输出与文件前后版本。
5. Plan 提交/批准版本、权限变化、取消、恢复、子任务投递与消费。
6. 压缩候选及 commit/rollback、TaskState 与上下文版本。
7. 每个实际请求尝试的 raw usage、账本修订、耗时和预算。
8. checkpoint、日志健康、导出与保留范围。

完整只指宿主实际可观察的内容。隐藏的供应商内部推理、内部重试和原生 runtime 未暴露请求不能补造。完整 transcript 不等于完整原文每轮重新发送。

### 5.2 最终请求捕获

在 `api-transport.ts` 完成协议转换之后、网络 dispatch 之前形成不可变 RequestSnapshot。现有 `captureRequestContext` 保留为经过过滤和截断的查看面板，不能用作权威请求快照。

在 Gateway 分配 requestId/attemptId，贯穿 PromptAssembler、网络诊断、响应、usage、工具来源和记录。快照、HTTP trace 与调用不能再各自产生无法直接关联的请求身份。

稳定指令、schema 和历史块可内容寻址复用，快照保存有序引用与协议包装。只有 hash 没有内容不能称可重建；远端 file_id 等不可离线取得的内容标 external_reference_only。

发送意图与已发送、响应开始、合法终态分别记录。崩溃于网络发送边界时，保留“不确定是否已被上游接收”，不能据此声称未计费或安全重发。

### 5.3 文件与事件

```text
sessions/<sessionId>/
    manifest.json
    transcript.jsonl
    segments/
    artifacts/
    snapshots/
    exports/
```

JSONL 使用 UTF-8 无 BOM、LF、一行一个事件。基础字段为 schemaVersion、eventId、sessionSeq、timestamp、processEpochId、run 关联、type、payload；请求、工具、审批字段只在适用时填写。耗时采用同一进程 epoch 内的单调时钟。

manifest 包含 durableSeq、exportedSeq、分片范围、artifact 清单、保留区间、脱敏策略、capture coverage。主子任务共用会话流，以 run 关系区分，不把子结果复制成另一笔消耗。

大内容引用包含相对路径、hash、大小、类型和缺失原因。第一版优先会话内去重，分支共享资源采用显式引用保护，不提前实施复杂全局内容库。

捕获完整度、原生协议续接能力、执行恢复条件分别记录。未知事件保留有限证据；原始 SSE 字节属于限时限量诊断增强，不承诺默认还原 TCP chunk。

## 6 SQLite 权威与恢复

### 6.1 提交模型

状态变化与 canonical event 在同一 SQLite 事务内提交。事件表加导出游标即可承担 outbox 语义，不强制再存一份重复事件。JSONL 从已提交事件持续生成，允许短暂滞后。

artifact 先保存和确认，再提交引用；失败留下的孤儿文件按宽限期清理。不能先把不存在的文件引用当作已持久化证据。

durableSeq 表示 SQLite 已可靠提交，exportedSeq 表示 JSONL 已确认写出。文件已写但游标未更新时，用 eventId/seq/hash 对齐尾部；不通过生成新 ID 重写同一事实。

权威提交失败阻止新的模型发送与副作用动作；JSONL 滞后但数据库健康时进入可见降级，在有界容量内继续。不得将导出暂停等同于事实丢失，也不得无限缓存掩盖积压。

### 6.2 增量持久化

文字 delta 按时间/字节批量追加，模型块完成后形成终态视图；不把最终全文再作为新增文本计入。Run 快照低频物化，关键状态边界强制提交。

必须 durable ack 的边界：接受用户输入、模型发送意图、完整工具批次、审批决定、工具 dispatch、结果确认、压缩 commit、运行终态。正常停止/退出 drain；强杀前尚未持久化的尾部明确 partial，不能补造缺失正文。

UI 从内存/事件增量展示，持久化节奏与绘制节奏分离，但展示和日志使用相同块身份及 offset。

### 6.3 恢复

重启仍停止未完成任务并使旧审批失效。提供安全继续时，先核对工作区、当前权限、工具版本和副作用账本。

没有 dispatch 的动作按当前规则重新准入；已有确认结果的不重做；dispatch 后无结果的进入 needs_reconciliation。文件可结合身份与前后 hash 核对，未知命令/外部提交缺少幂等证据时不能自动重放。

数据库完整而 JSONL 损坏时重建文件投影。活跃半行先等待，确认 writer 退出后才隔离尾部；中间缺口、损坏和 hash 不符显式失败。最低事实记录故障通过独立内存/平台通道提示 UI。

## 7 用量 预算与上下文

### 7.1 基础账本

保留 rawUsage、协议/adapter 版本、来源、字段完整度和 revision。复用现有累计 usage 合并/替换逻辑，不从零重做已经通过测试的规则。

每个 attempt 独立记录，自动重试、失败、取消和辅助请求均纳入。连接测试放 application-scoped 流，purpose 区分。缺失字段为 null/unknown，不填零；未知请求数与已知小计同时显示。

父任务总量为聚合视图，不能与子请求再次相加。导入、分支继承、恢复和重建不产生新消耗。供应商 responseId 结合端点/账户命名空间使用，无可靠依据不擅自合并账单。

reportedCost 与 estimatedCost 分离，保留计价版本及币种；订阅用量不伪装成 API 实付。首批交付逐请求明细和按日 CSV/JSON，高级图表后续实施。

### 7.2 连续历史与压缩

建立持久 ModelFrame 和 ToolInvocation，替换桌面跨轮模型历史入口，保留显示投影。跨模型切换进行原生块兼容性判断；需要时使用公开历史与可信任务状态构建新窗口。

历史编辑、删除、重新生成及分支产生修订和截止点，不能改写旧请求事实；现有 request_contexts 面板失效不删除 canonical RequestSnapshot。旧记录导入 legacy_partial，不猜测缺失工具关联。

ContextGovernor 每次请求检查容量、输出预留、工具返回余量和估算误差。先外置大结果、处理重复失效材料，再压缩完整工具批次；失败保留旧窗口，连续失败可见暂停。

TaskState 保存目标、硬约束、Plan 版本、动作/证据引用、未知副作用和子结果。摘要不能成为授权来源，当前权限始终由宿主重取。稳定提示词与动态事实分开，但工具撤销优先于缓存收益。

### 7.3 预算与重试

保留 16 次循环上限作为初期保护，再引入请求数、工具数、token、时间和任务树预算。并发请求保留在途额度；usage 不明不能直接释放为零。预算耗尽进入暂停并保存状态，由新预算决定继续。

网络重试、模型纠错和工具重执行分别计数。暂时网络错误有限退避；认证/参数/权限错误不原样重试；部分流失败产生新 attempt，旧工具批次不执行。无进展判断结合相同参数、错误码、资源版本和新证据，取消必须打断等待。

## 8 调度与控制

先扩展独立读取的有界并行，未知 shell 和共享写操作默认独占。需要一致快照的读取与写任务协调，不把所有只读工具视为无冲突。

共享目录只允许一个修改任务持有写租约。父代理等待写子任务时显式移交租约，子任务结束后重新取得并校验资源版本；测试父持锁等待子、子等待锁的死锁场景。现有逐文件锁作为最后防线。

保留 spawn_agent/wait_agents，补持久结果投递和消费回执。结果投递、进入准备请求、实际发送和获得完整响应分开；首期以完整响应确认消费，失败后可用相同结果身份重新投递。

steer 绑定 runId/expectedStepId，记录后在安全边界处理。stop、retry、resume、fork 分别定义。多写者 worktree 和完整 PTY 为后续范围，不阻塞首批。

## 9 日志导出 隐私与离线工具

日志存应用数据目录，不自动上传。API key、认证头、Cookie、OAuth token、带凭据 URL 过滤；结构化白名单与跨片段秘密处理共同使用，不宣称自动脱敏绝无遗漏。

完整本地记录可包含代码/路径/对话。受限原生块与公开文字分开保管，必要时使用平台密钥保护；不能修改签名内容后仍标可回放。分享包默认移除受限块并标覆盖降级。

UI 提供打开日志目录、逐请求详情、完整/脱敏导出及水位状态。导出固定 targetSeq 并保护引用，校验通过才标完整；轮转后合并 transcript.jsonl，只有引用没有 artifact 的包不能称完整。

离线工具提供 validate、stats、trace、replay、export。replay 只重建公开消息、状态、任务树和账本，不接网络/真实执行器。输入校验 schema、路径、解压大小、事件和 artifact 上限，导入内容始终当作数据。

普通消息编辑/隐藏使用 revision；彻底删除清理记录、索引、独占 artifacts 和可控备份，共享资源按引用保护。SQLite WAL 和磁盘残留边界明确，不能承诺物理不可恢复；外部导出无法自动追回。

默认完整记录；用户停用正文捕获后标 partial，最低审批/dispatch/副作用账本仍须存在才能继续有副作用操作。

## 10 UI 实施约束

root 在每个 UI 工作包前核对 D:/UI 的导出、API、真实 demo/文档及 UAH 已安装版本，记录复用项与缺口。首期复用表格、代码块、对话框、徽标、提示和用量组件，不先建设大型时间线看板。

缺少通用能力时，先在 D:/UI 完成实现、公开 API、真实 demo、文档与视觉验收，再发布并升级 UAH 固定版本。不得复制源码回 UAH，继续 Vue dedupe，不引入 Material 主题或用业务 CSS 绕开库。

共享视觉变更由 root 或符合项目视觉模型下限的执行者承担。验收含浅深主题、键盘、长日志滚动、窄屏和 125% 缩放；测试通过不代替视觉证据。

## 11 独立实施工作包

| 编号 | 范围与入口 | 依赖 | 交付门槛 |
|---|---|---|---|
| D00 | contracts、tool-protocol、docs/tests | 无 | 身份/状态/事件/usage v1、黄金样本、性能基线；旧 IPC 映射清楚 |
| D01 | workspace-tools、Supervisor 工具结果 | D00 | ToolOutcome，已写但记录失败与部分写入有机器状态；原审批/冲突回归 |
| D02 | ExecutionBackend、native、输出 artifact | D00/D01 | executionId、start/poll/wait/cancel、受控后代退出和大输出；不等待日志 UI |
| D03 | store、Gateway、api-transport、Journal | D00/D01 | SQLite 权威事件、最终请求捕获、JSONL 水位、关键 ack；接齐 D02 命令事件 |
| D04 | Usage reducers、exporter、离线工具与最小 UI | D03，UI 库门槛 | 默认完整记录、基础用量、完整/脱敏包、离线五命令和 legacy partial |
| D05 | conversation-history、分支、索引/分页 | D03/D04 | 持久模型历史、修订不混入旧分支、500 以上 run 及配额管理 |
| D06 | 文件工具与结果 schema | D01/D03 | patch/hash、分页/range read、编码和链接回归 |
| D07 | ContextGovernor、TaskState、Gateway budget | D04/D05，优先使用 D06 | 请求前准入、压缩事务、有限重试、任务树预算与失败暂停 |
| D08 | Scheduler、委派、steer/恢复/验证 | D02/D05/D07 | 单写者、无父子死锁、消费回执、迟到指令保护和核对恢复 |
| D09 | 原生 Runtime、Skills/MCP 与高级可视化 | 基础稳定后 | 实际需求驱动，单控制者、真实能力声明、原生记录覆盖明确 |

D00 至 D04 为桌面首批完整交付。D02 的后端验证和 D03 的持久化可以在边界明确时分别推进，但同一 Supervisor/store 修改串行整合。桌面发布不等待 Android 实现；公共 schema 若需不兼容变化，先提升版本并更新样本。

每个工作包交付代码、迁移/回退说明、测试证据、已知限制与更新后的 HANDOFF。新增能力同步维护 prompt-context、conditional-prompts、两品牌上下文说明及相关测试，不能只改提示词宣称可用。

## 12 迁移与回退

先新增表/字段和兼容读取，不破坏现有 Run、Plan、审批与文件快照。SQLite 使用一致性备份，不在活动 WAL 下只复制主文件。旧数据导入标 legacy_partial，不猜测原生块和精确 usage。

迁移前后比较显示投影、Plan 版本、审批历史、文件快照和可见消息数量。历史查询改分页，artifact 完整性检查按访问/导出/显式校验执行，不每次普通 snapshot 全库重算。

回退优先停用新执行路径并保留新事实，旧客户端不支持 schema 时明确拒绝。恢复升级前备份会丢弃升级后新增记录，必须在实际操作时按用户授权处理，不能自动覆盖。

功能开关可切换投影，不能关闭后丢掉已写入的 journal。权威事件与 artifacts 在导出/保留要求满足前不可清除唯一来源。

## 13 桌面验收矩阵

| 类别 | 必测输入 | 通过标准 |
|---|---|---|
| 协议 | 三协议分块、截断、原生块、重复 callId、未知工具 | 不完整批次不执行；既有终态/续接测试不退化 |
| 请求 | 多轮工具、参数覆盖、连接测试、辅助调用 | 最终脱敏请求可重建，每个实际 attempt 有身份 |
| 文件 | 审批后漂移、并行覆盖、部分失败、快照保存失败 | 不静默覆盖；副作用与记录状态明确 |
| 命令 | 子孙进程、大输出、超时、停止、helper 崩溃 | 有归属和退出证据；预览超限不杀健康任务 |
| 持久化 | dispatch 前后强杀、DB/JSONL 水位分离、磁盘满 | 不重复已发生副作用；权威失败暂停；投影可补写 |
| 用量 | 累计 2→10→15、final 重复、父子、retry、usage 缺失 | 有效值 15；不重计；未知不填零 |
| 历史 | 跨轮、重启、分支、编辑、重新生成 | 工具依据保留，旧分支不混入新上下文 |
| 导出 | 分片、缺 artifact、运行中导出、并发清理 | targetSeq 固定，完整/partial 准确，引用受保护 |
| 离线 | 清空 UI/统计投影后 replay，恶意路径包 | 重建一致，零网络/工具副作用，拒绝越界 |
| 并发 | 读写冲突、父等待写子、重复投递、迟到 steer | 无死锁、无隐式多写者、身份不误投 |
| 隐私 | 跨片段密钥、凭据 URL、受限块、彻底删除 | 普通日志不含认证材料，分享不改原件，删除引用正确 |
| UI | 深浅主题、长行、键盘、窄屏、125% | 真实组件验证、长记录可查、状态和可操作范围清楚 |

性能基线：10 万字符每次 20 字符、多轮大结果、500 以上 run、长列表与子任务。记录事务数、序列化/磁盘字节、内存、水位、UI 延迟、取消延迟和总耗时。必须消除逐 token 重写全文；数值 p95/flush/配额在 D00 实测后固定，不能未测承诺百分比。

每个阶段按改动运行定向测试、typecheck、必要构建和平台专项。真实模型效率基准需另有预算；模拟协议、Electron、Windows 生命周期、真实 Provider 证据分别报告。方案定稿不代表上述新增验收已通过。

## 14 首批完成定义

桌面每个新任务默认留下完整可观察 transcript 和基础账本，主子请求可关联，实际请求可重建；审批和工具 dispatch/结果有 durable ack；命令取消与输出有执行证据；完整及脱敏包可离线校验和重建；日志权威失败不会继续悄悄执行副作用。

自动恢复未知动作、完整 PTY、多写者 worktree、原生订阅 runtime、远程 trace、多端实时同步和高级看板不属于首批前提。后续按 D05 至 D09 改善效率与扩展，不以删减 transcript 换取进度。

## 15 源码与方案来源

本地入口：`src/runtime/supervisor.ts`、`store.ts`、`api-transport.ts`、`request-context.ts`、`diagnostics.ts`、`workspace-tools.ts`；`src/shared/conversation-history.ts`、`contracts.ts`、`tool-protocol.ts`；`native/UAH.NativeHelper/`；`docs/HANDOFF.md`、`CODEX-RUNTIME.md`、`CONDITIONAL-PROMPTS.md`。

输入资料为用户提供的 `UAH_Agent_Architecture_Review_2026-10-01.md` 与 `UAH_AgentApp_Harness_Upgrade_Plan_2026-10-01_v1.1.md`，路径位于 `D:/迅雷下载/`。本文采纳完整 transcript 要求，独立调整为桌面实施顺序；参考文档不构成代码修改、发布或付费调用授权。

后续开工重新检查 UAH/UI 实际状态，按项目要求使用既有提交风格。本文档仅新增设计，不改变任何运行数据或配置。
