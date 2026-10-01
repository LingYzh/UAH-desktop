# D00 桌面升级契约与兼容边界

日期：2026-10-01。对应桌面方案 v1.0 的 D00；这是新增契约基线，不表示 D01–D09 已接通。

后续状态：本页下面的“实施前盘点”及未接入说明保留为 D00 当时的基线。当前生产路径已继续接入 D01–D04，UAH 使用用户升级的固定 npm `@lingyzh/ui@0.2.1`；D05–D08 正在推进，最新状态以 HANDOFF 文末及专项文档为准。

## 实施前盘点

UAH 基线 `7fcce00`，只有两份升级方案未跟踪；UI 基线 `3f99b1a`、工作区干净。UAH 固定使用 npm `@lingyzh/ui@0.1.0`。

root 已检查 `D:/UI/src/ui/index.ts`、`src/ui/docs/` 的真实 demo 与文档入口。后续日志页面可考虑 UiTable、UiCodeBlock、UiDialog、UiScrollArea、UiUsageMeter；新 checkout 中的 UiBadge/UiAlert 等不代表 0.1.0 已有。D00 无新界面、交互或共享样式，复用项和组件缺口均为空，不触发 UI 发布与视觉验收。D04 必须重新盘点实际安装版本。

## v1 数据边界

实现入口是 `src/shared/harness-contracts.ts`，由 `contracts.ts` 与 `tool-protocol.ts` 重新导出相关类型。新事件采用 discriminated union，type 与 payload 关联；JSON 值不能含 undefined、函数、BigInt 等非 JSON 数据。v1 是后续生产实现的基础目录，新增兼容事件可扩展；改变已有字段含义必须升级 schema 并更新黄金样本。当前不是不可信导入数据的校验器，D04 离线工具仍需严格验证大小、路径、类型与版本。

- sessionId 为会话身份；根子 run 共用会话事件序列，rootRunId 指向任务树根，根 parentRunId 为 null。
- turnId 沿用现有轮身份；stepId 是宿主分配的模型/工具步骤身份，不从 UI 序号推导。
- requestId 表示逻辑请求，重试保留 requestId 并新增 attemptId；重新生成分配新 requestId。实际每次发送均必须有 attemptId。
- toolCallId 只在 attempt 内有意义。`toolCallKey` 用 JSON 二元组编码，避免拼接分隔符碰撞；invocationId 是宿主动作身份，executionId 是后端执行身份，两者均不是 PID。
- 现有 ApprovalIdentity.requestId 是旧审批身份。新记录必须通过显式适配将其作为 approvalId；不得把它当模型 requestId。policyVersion 仍必须复验。
- eventId 在重建和导出中不变。sessionSeq 由会话唯一 writer 在提交时分配，从 1 开始递增，不使用 `run.sequence`。旧 sequence、IPC 类型和 SQLite v2 完全保留。
- timestamp 为 UTC ISO 时间；durationMs 只来自同 processEpochId 内的单调时钟。未结束或无证据的耗时、退出码保留 null。

### 状态兼容

`projectLegacyRunState` 仅用于兼容显示，生产调度尚未调用它。waiting_model / waiting_resource / running_tools 映射 running；waiting_approval 映射 approval；stopping 保持；cancelled 映射 stopped；completed 保持；failed / suspended_budget / recording_failed / needs_reconciliation 映射 failed。

暂停和待核对状态在旧 UI 无对应展示，保守呈现 failed。启用新运行路径前必须给新 UI 传递原始状态和原因，不能根据有损映射决定终态、恢复或授权。旧 running 不反向猜测为 waiting_model，旧记录导入应标 legacy_partial。cancelRequested 仍是现有 IPC 请求阶段，不另造已完成取消证据。

ToolOutcome 将 status、effectState、recordingState、retryClass 分开。文件已写、记录失败的样本保留 confirmed + failed；取消但执行结果未知保留 possible + reconcile_first。`projectLegacyToolResult` 将非成功或记录未 durable 标 isError，但本身不暂停调度；D01 必须在 Supervisor 读取机器状态并执行暂停规则。idempotent_with_key 必须配真实 key，不能凭模型文字构造幂等保证。

## 请求、事件和用量

RequestSnapshot 捕获最终协议 body，明确 adapterVersion、capture coverage 和脱敏策略。它不同于旧 request_contexts 查看面板。v1 不保存认证头；body 也可能含秘密，实际接入前需要脱敏/受限原件策略，不能把此类型当作安全过滤器。artifact 路径只允许会话相对路径；hash/byteLength 指向真实保存的内容。外部引用、缺失与原生续接能力独立声明。

初始事件目录覆盖消息接受/修订、请求意图/发送、响应开始/delta/终态、完整工具批次、审批决定、工具 dispatch/结果、用量修订、Plan版本、权限、控制请求、子结果投递消费、压缩与 checkpoint。D02 命令输出分页和 D03 细粒度记录按此 envelope 增加具体 payload；不能以自由字符串 payload 绕开 schema。delta offset 明确为 UTF-16 单元，未来 range read 若使用字节游标须另设版本。

UsageRecord 是每 attempt 的修订快照。rawUsage 保存供应商字段，规范化 counters 保留 null，revision 替换旧版而不相加；三协议现有累计字段合并逻辑继续由 api-transport 负责。父子合计是聚合视图，不创建新消耗记录。连接测试使用 application scope；它不伪造 session/run，应在 D03 建立独立 application 流。reportedCost 与 estimatedCost 分开，价格版本和币种不可省略。

Manifest 将 durableSeq 与 exportedSeq 分开；exportedSeq 不得大于 durableSeq。captureCoverage、continuationCoverage、recovery 各有独立字段。完整 transcript 不等于自动恢复资格，也不保证原生续接。

## 迁移、回退和提示词

本包没有数据库迁移、用户配置写入或网络请求，没有启用新执行器。回退只需撤回新增契约及类型导出，现有 SQLite v2 与旧 IPC 不受影响。D03 仍需实现事务、artifact 保存、durable ack、导出水位与崩溃边界，不能在此阶段宣称已实现。

已检查 prompt-context、Claude/GPT harness 绑定和 conditional-prompts。D00 未新增工具或运行能力，因此保留原提示词及精确迁移来源；未向模型声明完整 transcript、进程树取消或新文件工具已可用。D01 起按实际注册结果同步条件模块和测试。

性能原始证据、复现方式和未覆盖维度见 `HARNESS-D00-BASELINE.md`。数值属于当前机器的基线，不是产品 SLA；flush、配额、UI/取消延迟需相应实现和专项实测后冻结。
